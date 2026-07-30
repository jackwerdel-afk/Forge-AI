const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

const { createClient } = require('@supabase/supabase-js');
const dns = require('dns').promises;
const tls = require('tls');
const net = require('net');
const { checkUrl, checkContent, checkGoogleSafeBrowsing, checkSSRF } = require('./content-check');
const { executeTier1Ban, executeTier2Warning, checkUserStatus, sendAdminAlert } = require('./enforce-ban');

// ── RATE LIMITING ─────────────────────────────────────────
// ── SUPABASE RATE LIMITING ─────────────────────────────────
// Uses Supabase instead of in-memory Map — works correctly
// across all serverless function instances and cold starts.
async function rateLimitDB(sb, key, maxRequests, windowMs) {
  try {
    const now = new Date();
    const resetAt = new Date(Date.now() + windowMs);

    // Try to get existing record
    const { data: existing } = await sb
      .from('rate_limits')
      .select('count, reset_at')
      .eq('key', key)
      .maybeSingle();

    if (!existing || new Date(existing.reset_at) < now) {
      // No record or expired — create/reset
      await sb.from('rate_limits').upsert({
        key,
        count: 1,
        reset_at: resetAt.toISOString()
      }, { onConflict: 'key' });
      return { allowed: true, remaining: maxRequests - 1 };
    }

    if (existing.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: existing.reset_at };
    }

    // Increment count
    await sb.from('rate_limits')
      .update({ count: existing.count + 1 })
      .eq('key', key);

    return { allowed: true, remaining: maxRequests - existing.count - 1 };
  } catch(e) {
    // If rate limiting fails, allow the request rather than blocking legitimate users
    console.error('Rate limit DB error (allowing request):', e.message);
    return { allowed: true, remaining: -1 };
  }
}


async function fetchSecurityHeaders(url) {
  // SSRF protection — validate URL before fetching
  const ssrfBlock = checkSSRF(url);
  if (ssrfBlock) return null;
  // Fetch with manual redirect tracking to capture headers
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual', // don't auto-follow so we can inspect headers
      headers: { 'User-Agent': 'ForgeAI-Security/1.0' }
    });
    clearTimeout(t);
    // Build header map (lowercase keys)
    const headers = {};
    res.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
    return {
      status: res.status,
      headers,
      redirected: res.status >= 300 && res.status < 400,
      redirectLocation: res.headers.get('location') || null
    };
  } catch(e) {
    // Try with redirect follow as fallback
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'ForgeAI-Security/1.0' }
      });
      clearTimeout(t);
      const headers = {};
      res.headers.forEach((val, key) => { headers[key.toLowerCase()] = val; });
      return { status: res.status, headers, redirected: false, redirectLocation: null };
    } catch(e2) { return null; }
  }
}

async function checkSSLAndHTTPS(url) {
  const findings = [];
  // SSRF protection
  const ssrfBlock = checkSSRF(url);
  if (ssrfBlock) return [];
  const urlObj = new URL(url);

  // Check 1: Is the site using HTTPS?
  const isHTTPS = urlObj.protocol === 'https:';
  if (!isHTTPS) {
    findings.push({
      id: 'no_https',
      category: 'SSL/TLS',
      title: 'Site not using HTTPS',
      description: 'The site is served over HTTP, meaning all data transmitted between visitors and the server is unencrypted.',
      severity: 'CRITICAL',
      confidence: 'verified',
      evidence: `Protocol: ${urlObj.protocol}`,
      points: 8,
      fix: "Enable HTTPS through your hosting provider or install an SSL certificate via Let's Encrypt.",
      effort: 'medium',
      impact: 'high'
    });
    return findings;
  }

  // Check 2: Does HTTP redirect to HTTPS?
  const httpUrl = url.replace('https://', 'http://');
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const httpRes = await fetch(httpUrl, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'ForgeAI-Security/1.0' }
    });
    clearTimeout(t);
    const location = httpRes.headers.get('location') || '';
    const redirectsToHTTPS = (httpRes.status === 301 || httpRes.status === 302) && location.startsWith('https://');
    if (!redirectsToHTTPS) {
      findings.push({
        id: 'no_http_redirect',
        category: 'SSL/TLS',
        title: 'HTTP does not redirect to HTTPS',
        description: 'Visitors who access the site via HTTP are not automatically redirected to the secure HTTPS version.',
        severity: 'HIGH',
        confidence: 'verified',
        evidence: `HTTP request returned status ${httpRes.status}. Location: ${location || 'none'}`,
        points: 4,
        fix: 'Configure your server or hosting provider to redirect all HTTP traffic to HTTPS.',
        effort: 'low',
        impact: 'high'
      });
    }
  } catch(e) {}

  return findings;
}

async function checkSSLCertificate(hostname) {
  return new Promise((resolve) => {
    const findings = [];
    const timeout = setTimeout(() => { resolve(findings); }, 8000);

    try {
      const socket = tls.connect({
        host: hostname, port: 443, servername: hostname,
        rejectUnauthorized: false, timeout: 7000
      }, () => {
        try {
          clearTimeout(timeout);
          const cert = socket.getPeerCertificate(true);
          const authError = socket.authorizationError;
          socket.destroy();

          if (!cert || !cert.subject) { resolve(findings); return; }

          // Check expiry
          const expiry = new Date(cert.valid_to);
          const daysUntilExpiry = Math.floor((expiry - new Date()) / (1000 * 60 * 60 * 24));

          if (daysUntilExpiry < 0) {
            findings.push({ id: 'ssl_cert_expired', category: 'SSL/TLS',
              title: 'SSL certificate has EXPIRED',
              description: `The SSL certificate expired ${Math.abs(daysUntilExpiry)} days ago. Visitors will see security warnings.`,
              severity: 'CRITICAL', confidence: 'verified',
              evidence: `Certificate expired: ${cert.valid_to}`,
              points: 10, fix: "Renew your SSL certificate immediately via your hosting provider or Let's Encrypt.", effort: 'low', impact: 'high' });
          } else if (daysUntilExpiry < 14) {
            findings.push({ id: 'ssl_cert_expiring_soon', category: 'SSL/TLS',
              title: `SSL certificate expires in ${daysUntilExpiry} day${daysUntilExpiry !== 1 ? 's' : ''}`,
              description: 'Certificate expiring very soon. Visitors will see security warnings when it expires.',
              severity: 'CRITICAL', confidence: 'verified',
              evidence: `Expires: ${cert.valid_to}. Days remaining: ${daysUntilExpiry}`,
              points: 8, fix: 'Renew your SSL certificate immediately.', effort: 'low', impact: 'high' });
          } else if (daysUntilExpiry < 30) {
            findings.push({ id: 'ssl_cert_expiring', category: 'SSL/TLS',
              title: `SSL certificate expires in ${daysUntilExpiry} days`,
              description: 'Certificate expiring within 30 days. Plan renewal now.',
              severity: 'HIGH', confidence: 'verified',
              evidence: `Expires: ${cert.valid_to}. Days remaining: ${daysUntilExpiry}`,
              points: 4, fix: 'Renew your SSL certificate before it expires.', effort: 'low', impact: 'high' });
          }

          // Check hostname/chain issues
          if (authError) {
            const errStr = String(authError);
            if (errStr.includes('HOSTNAME') || errStr.includes('hostname')) {
              findings.push({ id: 'ssl_hostname_mismatch', category: 'SSL/TLS',
                title: 'SSL certificate hostname mismatch',
                description: 'The SSL certificate is not issued for this domain. Browsers will show a security warning.',
                severity: 'CRITICAL', confidence: 'verified',
                evidence: `TLS error: ${authError}`,
                points: 10, fix: 'Obtain an SSL certificate that includes this domain name.', effort: 'low', impact: 'high' });
            } else if (errStr.includes('SELF_SIGNED') || errStr.includes('self signed')) {
              findings.push({ id: 'ssl_self_signed', category: 'SSL/TLS',
                title: 'Self-signed SSL certificate detected',
                description: 'Self-signed certificates are not trusted by browsers. Visitors will see a security warning.',
                severity: 'HIGH', confidence: 'verified',
                evidence: `TLS error: ${authError}`,
                points: 6, fix: "Replace with a certificate from a trusted CA. Let's Encrypt provides free certificates.", effort: 'low', impact: 'high' });
            }
          }

          // Check weak key size
          if (cert.bits && cert.bits < 2048) {
            findings.push({ id: 'ssl_weak_key', category: 'SSL/TLS',
              title: `Weak SSL key size (${cert.bits} bits)`,
              description: 'Certificate uses a key size below the recommended 2048-bit minimum.',
              severity: 'HIGH', confidence: 'verified',
              evidence: `Key size: ${cert.bits} bits`,
              points: 4, fix: 'Reissue the certificate with at least 2048-bit RSA or 256-bit EC key.', effort: 'medium', impact: 'medium' });
          }

          resolve(findings);
        } catch(e) { clearTimeout(timeout); resolve(findings); }
      });
      socket.on('error', () => { clearTimeout(timeout); resolve(findings); });
      socket.on('timeout', () => { clearTimeout(timeout); socket.destroy(); resolve(findings); });
    } catch(e) { clearTimeout(timeout); resolve(findings); }
  });
}


function checkHTTPHeaders(headers, url, html) {
  const findings = [];
  const h = headers || {};

  // ── HSTS ──────────────────────────────────────────────
  const hsts = h['strict-transport-security'];
  if (!hsts) {
    findings.push({
      id: 'missing_hsts',
      category: 'HTTP Security',
      title: 'Missing HTTP Strict Transport Security (HSTS)',
      description: 'HSTS tells browsers to always use HTTPS for this domain, preventing protocol downgrade attacks and cookie hijacking.',
      severity: 'HIGH',
      confidence: 'verified',
      evidence: 'Strict-Transport-Security header not present in HTTP response',
      points: 4,
      fix: 'Add header: Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
      effort: 'low',
      impact: 'high'
    });
  } else {
    // Check HSTS max-age
    const maxAgeMatch = hsts.match(/max-age=(\d+)/i);
    const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1]) : 0;
    if (maxAge < 31536000) {
      findings.push({
        id: 'weak_hsts',
        category: 'HTTP Security',
        title: 'HSTS max-age is too short',
        description: 'The HSTS policy expires too quickly. OWASP recommends a minimum of 1 year (31,536,000 seconds).',
        severity: 'MEDIUM',
        confidence: 'verified',
        evidence: `Strict-Transport-Security: ${hsts}. Current max-age: ${maxAge} seconds`,
        points: 2,
        fix: 'Increase max-age to at least 63072000 (2 years): Strict-Transport-Security: max-age=63072000; includeSubDomains',
        effort: 'low',
        impact: 'medium'
      });
    }
  }

  // ── CSP ───────────────────────────────────────────────
  // Check header first, then HTML meta tag (CDN-served sites may use meta tags)
  const csp = h['content-security-policy'];
  const cspMetaMatch = (html || '').match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]+content=["']([^"']+)["']/i)
    || (html || '').match(/<meta[^>]+content=["']([^"']+)["'][^>]+http-equiv=["']Content-Security-Policy["']/i);
  const cspMeta = cspMetaMatch ? cspMetaMatch[1] : null;
  const cspValue = csp || cspMeta;

  if (!cspValue) {
    findings.push({
      id: 'missing_csp',
      category: 'HTTP Security',
      title: 'Missing Content Security Policy (CSP)',
      description: 'CSP prevents cross-site scripting (XSS) attacks by specifying which content sources the browser is allowed to load.',
      severity: 'MEDIUM',
      confidence: 'verified',
      evidence: 'Content-Security-Policy not found in HTTP response headers or HTML meta tags',
      points: 3,
      fix: "Add a Content-Security-Policy header. Start with: Content-Security-Policy: default-src 'self'",
      effort: 'high',
      impact: 'high'
    });
  } else {
    // Note if CSP is via meta tag (less secure than header)
    if (!csp && cspMeta) {
      findings.push({
        id: 'csp_via_meta_only',
        category: 'HTTP Security',
        title: 'CSP only set via meta tag — not via HTTP header',
        description: "CSP implemented via HTML meta tag is less secure than via HTTP header. Meta-based CSP cannot block all resource types and is applied after some resources may already load.",
        severity: 'LOW',
        confidence: 'verified',
        evidence: `CSP found in meta tag: ${cspMeta.substring(0, 100)}`,
        points: 1,
        fix: 'Move your Content-Security-Policy from a meta tag to an HTTP response header for full protection.',
        effort: 'low',
        impact: 'low'
      });
    }
    // Check for unsafe-inline which defeats CSP
    if (cspValue.includes("'unsafe-inline'") && cspValue.includes('script-src')) {
      findings.push({
        id: 'weak_csp_unsafe_inline',
        category: 'HTTP Security',
        title: "CSP contains 'unsafe-inline' in script-src",
        description: "Including 'unsafe-inline' in script-src largely defeats the XSS protection CSP provides.",
        severity: 'MEDIUM',
        confidence: 'verified',
        evidence: `Content-Security-Policy: ${cspValue.substring(0, 120)}`,
        points: 2,
        fix: "Remove 'unsafe-inline' from script-src and use nonces or hashes instead.",
        effort: 'high',
        impact: 'medium'
      });
    }
  }

  // ── X-CONTENT-TYPE-OPTIONS ────────────────────────────
  if (!h['x-content-type-options']) {
    findings.push({
      id: 'missing_xcto',
      category: 'HTTP Security',
      title: 'Missing X-Content-Type-Options header',
      description: 'This header prevents browsers from MIME-sniffing a response away from the declared content type, reducing exposure to drive-by download attacks.',
      severity: 'LOW',
      confidence: 'verified',
      evidence: 'X-Content-Type-Options header not present in HTTP response',
      points: 1,
      fix: 'Add header: X-Content-Type-Options: nosniff',
      effort: 'low',
      impact: 'low'
    });
  }

  // ── X-FRAME-OPTIONS / frame-ancestors ─────────────────
  const xfo = h['x-frame-options'];
  const hasFrameAncestors = cspValue && cspValue.includes('frame-ancestors');
  if (!xfo && !hasFrameAncestors) {
    findings.push({
      id: 'missing_frame_options',
      category: 'HTTP Security',
      title: 'Missing clickjacking protection',
      description: 'Without X-Frame-Options or CSP frame-ancestors, attackers can embed your site in an iframe to trick users into unintended actions.',
      severity: 'MEDIUM',
      confidence: 'verified',
      evidence: 'Neither X-Frame-Options nor CSP frame-ancestors directive found',
      points: 2,
      fix: "Add header: X-Frame-Options: DENY, or add frame-ancestors 'none' to your CSP.",
      effort: 'low',
      impact: 'medium'
    });
  }

  // ── REFERRER-POLICY ───────────────────────────────────
  if (!h['referrer-policy']) {
    findings.push({
      id: 'missing_referrer_policy',
      category: 'HTTP Security',
      title: 'Missing Referrer-Policy header',
      description: 'Without a Referrer-Policy, browsers may send the full URL in the Referer header to third parties, leaking sensitive path information.',
      severity: 'LOW',
      confidence: 'verified',
      evidence: 'Referrer-Policy header not present in HTTP response',
      points: 1,
      fix: 'Add header: Referrer-Policy: strict-origin-when-cross-origin',
      effort: 'low',
      impact: 'low'
    });
  }

  // ── PERMISSIONS-POLICY ────────────────────────────────
  if (!h['permissions-policy']) {
    findings.push({
      id: 'missing_permissions_policy',
      category: 'HTTP Security',
      title: 'Missing Permissions-Policy header',
      description: 'Permissions-Policy controls which browser features (camera, microphone, geolocation) can be used on the page.',
      severity: 'LOW',
      confidence: 'verified',
      evidence: 'Permissions-Policy header not present in HTTP response',
      points: 1,
      fix: 'Add header: Permissions-Policy: camera=(), microphone=(), geolocation=()',
      effort: 'low',
      impact: 'low'
    });
  }

  // ── SERVER HEADER INFORMATION DISCLOSURE ──────────────
  const server = h['server'];
  if (server && /apache|nginx|iis|php|express/i.test(server)) {
    findings.push({
      id: 'server_header_disclosure',
      category: 'HTTP Security',
      title: 'Server software version disclosed',
      description: 'The Server header reveals the web server software and potentially its version, helping attackers identify vulnerabilities.',
      severity: 'LOW',
      confidence: 'verified',
      evidence: `Server: ${server}`,
      points: 1,
      fix: 'Configure your server to remove or obscure the Server header.',
      effort: 'low',
      impact: 'low'
    });
  }

  return findings;
}


// ── AUTHORITATIVE DNS LOOKUP ───────────────────────────────
// Uses Cloudflare DNS-over-HTTPS instead of the system resolver
// to avoid stale cached results and get consistent authoritative answers.
async function dnsResolveText(hostname) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=TXT`,
      {
        signal: controller.signal,
        headers: { 'Accept': 'application/dns-json' }
      }
    );
    clearTimeout(t);
    if (!res.ok) throw new Error(`DNS-over-HTTPS error: ${res.status}`);
    const data = await res.json();
    // Extract TXT record data — Cloudflare returns array of strings per record
    if (!data.Answer || data.Answer.length === 0) return [];
    return data.Answer
      .filter(a => a.type === 16) // Type 16 = TXT
      .map(a => {
        // Strip surrounding quotes from TXT data
        let txt = a.data || '';
        txt = txt.replace(/^"|"$/g, '').replace(/" "/g, '');
        return txt;
      });
  } catch(e) {
    // Fall back to system DNS if DoH fails
    try {
      const records = await dns.resolveTxt(hostname);
      return records.flat();
    } catch(e2) {
      throw e2;
    }
  }
}

async function checkEmailSecurity(domain) {
  const findings = [];

  // ── SPF ───────────────────────────────────────────────
  try {
    const txtRecords = await dnsResolveText(domain);
    const spfRecord = txtRecords.find(r => r.startsWith('v=spf1'));
    if (!spfRecord) {
      findings.push({
        id: 'missing_spf',
        category: 'Email Security',
        title: 'No SPF record found',
        description: 'SPF (Sender Policy Framework) prevents email spoofing by specifying which mail servers are authorized to send email for your domain.',
        severity: 'HIGH',
        confidence: 'verified',
        evidence: `No SPF TXT record found for ${domain}`,
        points: 3,
        fix: 'Add a TXT record to your DNS: v=spf1 include:your-email-provider.com ~all',
        effort: 'low',
        impact: 'high'
      });
    } else {
      // Check for weak SPF policy (+all means anyone can send)
      if (spfRecord.includes('+all')) {
        findings.push({
          id: 'weak_spf',
          category: 'Email Security',
          title: 'SPF record uses permissive +all policy',
          description: 'The "+all" mechanism allows any server to send email for your domain, defeating the purpose of SPF.',
          severity: 'HIGH',
          confidence: 'verified',
          evidence: `SPF record: ${spfRecord}`,
          points: 3,
          fix: 'Change "+all" to "~all" (softfail) or "-all" (hardfail) in your SPF record.',
          effort: 'low',
          impact: 'high'
        });
      }
    }

    // ── DMARC ─────────────────────────────────────────
    try {
      const dmarcRecords = await dnsResolveText(`_dmarc.${domain}`);
      const dmarcRecord = dmarcRecords.find(r => r.startsWith('v=DMARC1'));
      if (!dmarcRecord) {
        findings.push({
          id: 'missing_dmarc',
          category: 'Email Security',
          title: 'No DMARC record found',
          description: 'DMARC prevents email spoofing by telling receiving mail servers what to do with emails that fail SPF or DKIM checks.',
          severity: 'HIGH',
          confidence: 'verified',
          evidence: `No DMARC TXT record found for _dmarc.${domain}`,
          points: 3,
          fix: 'Add a TXT record: _dmarc.' + domain + ' → v=DMARC1; p=quarantine; rua=mailto:dmarc@' + domain,
          effort: 'low',
          impact: 'high'
        });
      } else {
        // Check DMARC policy strength
        const policyMatch = dmarcRecord.match(/p=(\w+)/i);
        const policy = policyMatch ? policyMatch[1].toLowerCase() : 'none';
        if (policy === 'none') {
          findings.push({
            id: 'weak_dmarc',
            category: 'Email Security',
            title: 'DMARC policy set to "none" — no enforcement',
            description: 'A DMARC policy of "none" only monitors email — it does not quarantine or reject spoofed messages.',
            severity: 'MEDIUM',
            confidence: 'verified',
            evidence: `DMARC record: ${dmarcRecord}`,
            points: 2,
            fix: 'Update DMARC policy to p=quarantine or p=reject for active protection.',
            effort: 'low',
            impact: 'high'
          });
        }
      }
    } catch(e) {
      // DMARC record doesn't exist
      findings.push({
        id: 'missing_dmarc',
        category: 'Email Security',
        title: 'No DMARC record found',
        description: 'DMARC prevents email spoofing by telling receiving mail servers what to do with emails that fail SPF or DKIM checks.',
        severity: 'HIGH',
        confidence: 'verified',
        evidence: `No DMARC TXT record found for _dmarc.${domain}`,
        points: 3,
        fix: 'Add a TXT record: _dmarc.' + domain + ' → v=DMARC1; p=quarantine; rua=mailto:dmarc@' + domain,
        effort: 'low',
        impact: 'high'
      });
    }

    // ── DKIM — enumerate common selectors ─────────────────
    const DKIM_SELECTORS = [
      'default', 'google', 'mail', 'email', 'k1', 'k2',
      'resend', 'mailchimp', 'sendgrid', 'mailgun', 'ses',
      'protonmail', 'dkim', 'smtp', 'selector1', 'selector2',
      'mandrill', 'postmark', 'sparkpost', 'zoho', 'hubspot'
    ];

    let dkimFound = false;
    for (const selector of DKIM_SELECTORS) {
      try {
        const dkimRecords = await dnsResolveText(`${selector}._domainkey.${domain}`);
        const dkimRecord = dkimRecords.find(r => r.includes('v=DKIM1') || r.includes('k=rsa') || r.includes('p='));
        if (dkimRecord) {
          dkimFound = true;
          break;
        }
      } catch(e) {
        // Selector not found — try next
      }
    }

    if (!dkimFound) {
      findings.push({
        id: 'missing_dkim',
        category: 'Email Security',
        title: 'DKIM not detected',
        description: 'DKIM cryptographically signs outgoing emails, allowing receivers to verify they were not tampered with in transit. No DKIM record was found for common email selectors.',
        severity: 'HIGH',
        confidence: 'probable',
        evidence: `Checked ${DKIM_SELECTORS.length} common DKIM selectors — none found for ${domain}. Note: DKIM may be configured with a custom selector not checked here.`,
        points: 3,
        fix: 'Enable DKIM signing through your email provider. They will give you a DNS TXT record to add to your domain.',
        effort: 'low',
        impact: 'high'
      });
    }

  } catch(e) {
    // DNS lookup failed — mark as unverifiable
    findings.push({
      id: 'dns_lookup_failed',
      category: 'Email Security',
      title: 'DNS lookup failed',
      description: 'Could not verify SPF or DMARC records. This may be a temporary DNS issue.',
      severity: 'LOW',
      confidence: 'low',
      evidence: `DNS error: ${e.message}`,
      points: 0,
      fix: 'Check your DNS configuration and try again.',
      effort: 'low',
      impact: 'medium'
    });
  }

  return findings;
}

function checkMixedContent(html, url) {
  const findings = [];
  if (!url.startsWith('https://')) return findings;

  // Find HTTP resources loaded on HTTPS page
  const httpResources = [];
  const patterns = [
    /src=["']http:\/\/[^"']+["']/gi,
    /href=["']http:\/\/[^"']+["']/gi,
    /url\(["']?http:\/\/[^"')]+["']?\)/gi
  ];
  patterns.forEach(p => {
    const matches = html.match(p) || [];
    matches.forEach(m => {
      const resource = m.replace(/^(src|href)=["']|["']$/g, '').replace(/^url\(["']?|["']?\)$/g, '');
      if (!resource.includes('localhost') && !resource.includes('127.0.0.1')) {
        httpResources.push(resource);
      }
    });
  });

  if (httpResources.length > 0) {
    findings.push({
      id: 'mixed_content',
      category: 'SSL/TLS',
      title: `Mixed content detected — ${httpResources.length} HTTP resource${httpResources.length > 1 ? 's' : ''} on HTTPS page`,
      description: 'HTTP resources loaded on an HTTPS page can expose users to data interception and trigger browser security warnings.',
      severity: httpResources.length > 3 ? 'HIGH' : 'MEDIUM',
      confidence: 'verified',
      evidence: `HTTP resources found: ${httpResources.slice(0, 3).join(', ')}${httpResources.length > 3 ? ` and ${httpResources.length - 3} more` : ''}`,
      points: Math.min(httpResources.length, 4),
      fix: 'Update all resource URLs to use HTTPS instead of HTTP.',
      effort: 'low',
      impact: 'medium'
    });
  }

  return findings;
}

function calculateSecurityScore(findings) {
  const maxScore = 20;
  const totalDeductions = findings.reduce((sum, f) => sum + (f.points || 0), 0);
  return Math.max(0, Math.min(maxScore, maxScore - totalDeductions));
}


// ── WORDPRESS-SPECIFIC SECURITY CHECKS ────────────────────
// Only runs when WordPress is detected from HTML signatures.
// Checks for common WordPress attack vectors via HTTP requests.

function isWordPressSite(html) {
  if (!html) return false;
  return (
    html.includes('wp-content') ||
    html.includes('wp-includes') ||
    /generator.*WordPress/i.test(html) ||
    html.includes('/wp-json/') ||
    html.includes('wp-embed')
  );
}

async function checkWordPressSecurity(url, html) {
  if (!isWordPressSite(html)) return [];
  const findings = [];
  const base = url.replace(/\/$/, '');

  // Helper: check if a URL returns a specific status
  async function checkEndpoint(path, timeoutMs) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs || 6000);
      const res = await fetch(base + path, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'ForgeAI-Security/1.0' }
      });
      clearTimeout(t);
      return { status: res.status, accessible: res.status === 200 };
    } catch(e) { return { status: 0, accessible: false }; }
  }

  // Run all WP checks in parallel
  const [xmlrpc, readme, debugLog, wpAdmin, wpJson] = await Promise.allSettled([
    checkEndpoint('/xmlrpc.php'),
    checkEndpoint('/readme.html'),
    checkEndpoint('/wp-content/debug.log'),
    checkEndpoint('/wp-admin/'),
    checkEndpoint('/wp-json/wp/v2/users')
  ]);

  // ── XML-RPC ───────────────────────────────────────────
  const xmlrpcResult = xmlrpc.status === 'fulfilled' ? xmlrpc.value : { accessible: false };
  if (xmlrpcResult.accessible) {
    findings.push({
      id: 'wp_xmlrpc_exposed',
      category: 'WordPress Security',
      title: 'XML-RPC endpoint is publicly accessible',
      description: 'The WordPress XML-RPC interface is accessible. This legacy API is frequently exploited for brute force attacks, DDoS amplification, and credential stuffing. Unless you specifically need it for Jetpack or remote publishing, it should be disabled.',
      severity: 'HIGH',
      confidence: 'verified',
      evidence: `${base}/xmlrpc.php returned HTTP 200`,
      points: 4,
      fix: "Disable XML-RPC by adding to .htaccess: <Files xmlrpc.php><Order deny,allow><Deny from all></Files>. Or use a security plugin like Wordfence to block it.",
      effort: 'low',
      impact: 'high'
    });
  }

  // ── README.HTML — version disclosure ─────────────────
  const readmeResult = readme.status === 'fulfilled' ? readme.value : { accessible: false };
  if (readmeResult.accessible) {
    findings.push({
      id: 'wp_readme_exposed',
      category: 'WordPress Security',
      title: 'WordPress readme.html exposes version information',
      description: 'The WordPress readme.html file is publicly accessible. It reveals the WordPress version, helping attackers identify known vulnerabilities for your specific version.',
      severity: 'LOW',
      confidence: 'verified',
      evidence: `${base}/readme.html returned HTTP 200`,
      points: 1,
      fix: 'Delete or restrict access to readme.html. Add to .htaccess: <Files readme.html><Order deny,allow><Deny from all></Files>',
      effort: 'low',
      impact: 'low'
    });
  }

  // ── DEBUG.LOG — sensitive data exposure ────────────────
  const debugResult = debugLog.status === 'fulfilled' ? debugLog.value : { accessible: false };
  if (debugResult.accessible) {
    findings.push({
      id: 'wp_debug_log_exposed',
      category: 'WordPress Security',
      title: 'WordPress debug.log is publicly accessible',
      description: 'The WordPress debug log file is publicly accessible. Debug logs frequently contain file paths, database queries, error messages, and other sensitive information useful to attackers.',
      severity: 'HIGH',
      confidence: 'verified',
      evidence: `${base}/wp-content/debug.log returned HTTP 200`,
      points: 5,
      fix: 'Immediately restrict access to debug.log. Add to .htaccess or delete the file. Disable WP_DEBUG_LOG in wp-config.php.',
      effort: 'low',
      impact: 'high'
    });
  }

  // ── USER ENUMERATION VIA REST API ─────────────────────
  const wpJsonResult = wpJson.status === 'fulfilled' ? wpJson.value : { accessible: false };
  if (wpJsonResult.accessible) {
    findings.push({
      id: 'wp_user_enumeration',
      category: 'WordPress Security',
      title: 'WordPress user enumeration via REST API',
      description: 'The WordPress REST API exposes a list of all users including their usernames. Attackers use this to identify valid usernames for brute force login attacks.',
      severity: 'MEDIUM',
      confidence: 'verified',
      evidence: `${base}/wp-json/wp/v2/users returned HTTP 200 — user list publicly accessible`,
      points: 3,
      fix: "Disable user enumeration via REST API. Add to functions.php: add_filter('rest_endpoints', function($endpoints) { if (isset($endpoints['/wp/v2/users'])) { unset($endpoints['/wp/v2/users']); } return $endpoints; });",
      effort: 'low',
      impact: 'medium'
    });
  }

  // ── WP VERSION IN HTML ────────────────────────────────
  const versionMatch = html.match(/WordPress ([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i) ||
                       html.match(/ver=([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
  if (versionMatch) {
    const version = versionMatch[1];
    // We can't check if it's the latest without an external API, but we flag disclosure
    findings.push({
      id: 'wp_version_disclosed',
      category: 'WordPress Security',
      title: `WordPress version ${version} disclosed in page source`,
      description: 'The WordPress version number is visible in the page source code. This helps attackers identify known vulnerabilities specific to your version.',
      severity: 'LOW',
      confidence: 'verified',
      evidence: `WordPress ${version} found in HTML source`,
      points: 1,
      fix: "Remove the WordPress version from your site. Add to functions.php: remove_action('wp_head', 'wp_generator');",
      effort: 'low',
      impact: 'low'
    });
  }

  if (findings.length === 0) {
    console.log('WordPress security: all checks passed for', url);
  } else {
    console.log(`WordPress security: ${findings.length} issues found for`, url);
  }

  return findings;
}

async function runSecurityModule(url, html, headers) {
  const urlObj = new URL(url);
  const domain = urlObj.hostname.replace(/^www\./, '');
  const allFindings = [];

  // Run all checks in parallel where possible
  const urlObj2 = new URL(url);
  const [sslFindings, emailFindings, certFindings, wpFindings] = await Promise.all([
    checkSSLAndHTTPS(url),
    checkEmailSecurity(domain),
    urlObj2.protocol === 'https:' ? checkSSLCertificate(urlObj2.hostname) : Promise.resolve([]),
    checkWordPressSecurity(url, html)
  ]);

  const headerFindings = checkHTTPHeaders(headers || {}, url, html);
  const mixedFindings = checkMixedContent(html || '', url);

  // Safety guards — ensure all results are arrays before spreading
  allFindings.push(
    ...(Array.isArray(sslFindings) ? sslFindings : []),
    ...(Array.isArray(certFindings) ? certFindings : []),
    ...(Array.isArray(headerFindings) ? headerFindings : []),
    ...(Array.isArray(emailFindings) ? emailFindings : []),
    ...(Array.isArray(mixedFindings) ? mixedFindings : []),
    ...(Array.isArray(wpFindings) ? wpFindings : [])
  );

  const score = calculateSecurityScore(allFindings);
  const criticalCount = allFindings.filter(f => f.severity === 'CRITICAL').length;
  const highCount = allFindings.filter(f => f.severity === 'HIGH').length;

  // Security status
  let status = 'Protected';
  let statusColor = 'green';
  if (criticalCount > 0) { status = 'Critical Risk'; statusColor = 'red'; }
  else if (highCount > 0) { status = 'Needs Attention'; statusColor = 'yellow'; }
  else if (allFindings.length > 3) { status = 'Improvements Available'; statusColor = 'yellow'; }

  return {
    score,
    status,
    statusColor,
    findings: allFindings,
    summary: {
      total: allFindings.length,
      critical: criticalCount,
      high: highCount,
      medium: allFindings.filter(f => f.severity === 'MEDIUM').length,
      low: allFindings.filter(f => f.severity === 'LOW').length
    },
    deductions: allFindings.map(f => ({
      issue: f.title,
      severity: f.severity,
      points: f.points,
      category: f.category
    })),
    patches: allFindings
      .filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')
      .map(f => ({
        type: f.id,
        title: f.title,
        fix: f.fix,
        effort: f.effort,
        impact: f.impact
      }))
  };
}


// ── BROKEN LINK CHECKER ───────────────────────────────────
async function checkBrokenLinks(links) {
  const broken = [];
  const toCheck = links.slice(0, 20);
  await Promise.all(toCheck.map(async (link) => {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(link, { method: 'HEAD', signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'ForgeAI-LinkChecker/1.0' } });
      clearTimeout(t);
      if (res.status === 404 || res.status === 410) broken.push({ url: link, status: res.status });
    } catch(e) {}
  }));
  return broken;
}

// ── CONFIDENCE HELPER ─────────────────────────────────────
function confidence(level, reason) {
  return { level, reason };
}

// ── CONTEXT DETECTOR ──────────────────────────────────────
async function detectContext(html, url) {
  try {
    const textSample = getTextContent(html).slice(0, 600);
    const prompt = `Analyze this webpage content ONLY — ignore the domain name completely.
Return ONLY valid JSON, no markdown.

Page content sample:
${textSample}

Based ONLY on the actual text content above (not the URL or domain name), return:
{"page_type":"homepage|landing|blog|ecommerce|portfolio|service|other","industry":"web_agency|marketing_agency|retail|healthcare|tech|restaurant|finance|education|nonprofit|other","platform":"wordpress|webflow|wix|squarespace|shopify|custom","audit_mode":"full_audit"}

Rules:
- Determine industry from the actual page text and services described
- Do NOT use the domain name to guess industry
- If unsure, use "other"`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 100, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) {
    return { page_type: 'homepage', industry: 'other', platform: 'custom', audit_mode: 'full_audit' };
  }
}

// ── MODULE AI INTERPRETER ─────────────────────────────────
async function interpretModule(moduleName, findings, context, url) {
  if (findings.length === 0) return [];
  try {
    const prompt = `You are a ${moduleName} specialist reviewing a ${context.industry} ${context.page_type} website built on ${context.platform}.

Findings detected by code analysis:
${findings.map((f, i) => `${i + 1}. ${f.issue}${f.evidence ? ' — Evidence: ' + f.evidence : ''}`).join('\n')}

For each finding write ONE specific actionable fix recommendation.

STRICT RULES:
- Never invent specific content, keywords, headlines, or business details you don't know
- Never write example H1s, meta descriptions, or titles with made-up content
- Use placeholders like [your main service] or [your business name] if examples are needed
- Focus on HOW to fix the issue technically, not WHAT content to write
- Be concise — 1-2 sentences max per fix
- Explain why the fix matters for this type of site

Return ONLY a JSON array of strings, one fix per finding, no markdown:
["fix 1", "fix 2"]`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = (data.content?.[0]?.text || '[]').replace(/```json|```/g, '').trim();
    const patches = JSON.parse(text);
    return Array.isArray(patches) ? patches : [];
  } catch(e) {
    return findings.map(f => `Fix: ${f.issue}`);
  }
}

// ── MODULE 1: SEO ─────────────────────────────────────────
async function runSEOModule(allHtml, url, internalLinks, allHtmlParts, context) {
  let score = 20;
  const deductions = [];
  const findings = [];

  const metaDesc = getMeta(allHtml, 'description');
  const title = getTitle(allHtml);
  const h1Count = countTag(allHtml, 'h1');
  const altData = getImagesWithoutAlt(allHtml);
  const wordCount = countWords(allHtml);
  const ogData = hasOpenGraph(allHtml);
  const dupMetas = getDuplicateMetaAcrossPages(allHtmlParts);

  // Meta description
  if (!metaDesc) {
    score -= 5;
    deductions.push({ issue: 'Missing meta description', severity: 'CRITICAL', points: -5, confidence: 'VERIFIED', evidence: 'No <meta name="description"> tag found in HTML' });
    findings.push({ issue: 'Missing meta description', evidence: 'No meta description tag found across scanned pages' });
  } else if (metaDesc.length < 50) {
    score -= 3;
    deductions.push({ issue: `Meta description too short (${metaDesc.length} chars)`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Found: "${metaDesc.slice(0, 60)}..."` });
    findings.push({ issue: `Meta description too short (${metaDesc.length} chars)`, evidence: `Current: "${metaDesc}"` });
  } else if (metaDesc.length > 160) {
    score -= 2;
    deductions.push({ issue: `Meta description too long (${metaDesc.length} chars)`, severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `Found: "${metaDesc.slice(0, 80)}..."` });
    findings.push({ issue: `Meta description too long (${metaDesc.length} chars)`, evidence: `Current: "${metaDesc.slice(0, 100)}"` });
  }

  // Title
  if (!title) {
    score -= 5;
    deductions.push({ issue: 'Missing page title', severity: 'CRITICAL', points: -5, confidence: 'VERIFIED', evidence: 'No <title> tag found' });
    findings.push({ issue: 'Missing page title', evidence: 'No <title> tag found in HTML' });
  } else if (title.length > 60) {
    score -= 2;
    deductions.push({ issue: `Page title too long (${title.length} chars)`, severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `Title: "${title}"` });
    findings.push({ issue: `Page title too long (${title.length} chars)`, evidence: `Current title: "${title}"` });
  }

  // H1
  if (h1Count === 0) {
    score -= 5;
    deductions.push({ issue: 'Missing H1 heading', severity: 'CRITICAL', points: -5, confidence: 'VERIFIED', evidence: 'No <h1> tag found in page HTML' });
    findings.push({ issue: 'Missing H1 heading', evidence: 'No H1 tag found across scanned pages' });
  } else if (h1Count > 1) {
    score -= 3;
    deductions.push({ issue: `Multiple H1 tags (${h1Count} found)`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Found ${h1Count} H1 tags — should be exactly 1` });
    findings.push({ issue: `Multiple H1 tags (${h1Count} found)`, evidence: `${h1Count} H1 tags detected` });
  }

  // Alt text
  if (altData.count > 0) {
    const pts = Math.min(6, altData.count * 3);
    score -= pts;
    deductions.push({ issue: `${altData.count} images missing alt text`, severity: 'HIGH', points: -pts, confidence: 'VERIFIED', evidence: `Examples: ${altData.evidence.join(', ')}` });
    findings.push({ issue: `${altData.count} images missing alt text`, evidence: `Example images: ${altData.evidence.join(', ')}` });
  }

  // Canonical
  if (!hasCanonical(allHtml)) {
    score -= 1;
    deductions.push({ issue: 'Missing canonical tag', severity: 'LOW', points: -1, confidence: 'VERIFIED', evidence: 'No <link rel="canonical"> tag found' });
    findings.push({ issue: 'Missing canonical tag', evidence: 'No canonical link element in HTML' });
  }

  // Schema
  if (!hasSchema(allHtml)) {
    score -= 1;
    deductions.push({ issue: 'No structured data found', severity: 'LOW', points: -1, confidence: 'VERIFIED', evidence: 'No JSON-LD or itemtype schema markup found' });
    findings.push({ issue: 'No structured data', evidence: 'No JSON-LD script or itemtype attributes found' });
  }

  // Open Graph
  if (!ogData.complete) {
    const missing = [!ogData.hasTitle && 'og:title', !ogData.hasDesc && 'og:description', !ogData.hasImage && 'og:image'].filter(Boolean);
    if (missing.length > 0) {
      score -= 2;
      deductions.push({ issue: `Incomplete Open Graph tags (missing: ${missing.join(', ')})`, severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `Missing tags: ${missing.join(', ')}` });
      findings.push({ issue: `Missing Open Graph tags: ${missing.join(', ')}`, evidence: `${missing.join(', ')} tags not found` });
    }
  }

  // Twitter Card
  if (!hasTwitterCard(allHtml)) {
    score -= 1;
    deductions.push({ issue: 'Missing Twitter Card tags', severity: 'LOW', points: -1, confidence: 'VERIFIED', evidence: 'No twitter:card meta tag found' });
    findings.push({ issue: 'Missing Twitter Card tags', evidence: 'No twitter:card meta tag in HTML' });
  }

  // Heading hierarchy
  if (checkHeadingHierarchy(allHtml)) {
    score -= 2;
    deductions.push({ issue: 'Broken heading hierarchy (skips H2)', severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: 'H1 found, H3 found, but no H2 between them' });
    findings.push({ issue: 'Broken heading hierarchy', evidence: 'Page uses H1 and H3 but skips H2' });
  }

  // Thin content
  if (wordCount < 300) {
    score -= 2;
    deductions.push({ issue: `Thin content (${wordCount} words)`, severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: `${wordCount} words detected — may be higher if JS-rendered content loads` });
    findings.push({ issue: `Thin content (${wordCount} words)`, evidence: `${wordCount} words found in HTML` });
  }

  // Duplicate metas
  if (dupMetas > 0) {
    score -= 3;
    deductions.push({ issue: `Duplicate meta descriptions across pages (${dupMetas} duplicates)`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `${dupMetas} pages share identical meta descriptions` });
    findings.push({ issue: `Duplicate meta descriptions (${dupMetas} duplicates)`, evidence: `${dupMetas} pages have identical meta descriptions` });
  }

  // Broken links
  if (internalLinks.length > 0) {
    const broken = await checkBrokenLinks(internalLinks);
    if (broken.length > 0) {
      score -= 3;
      deductions.push({ issue: `${broken.length} broken internal links`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Broken: ${broken.slice(0, 3).map(b => b.url).join(', ')}` });
      findings.push({ issue: `${broken.length} broken internal links`, evidence: broken.slice(0, 3).map(b => `${b.url} (${b.status})`).join(', ') });
    }
  }

  const patches = await interpretModule('SEO', findings, context, url);
  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: 20 - Math.max(0, score),
    deductions,
    issues: deductions.map(d => d.issue),
    patches
  };
}

// ── MODULE 2: PERFORMANCE ─────────────────────────────────
async function runPerformanceModule(url, html) {
  let score = 20;
  const deductions = [];
  const findings = [];
  let coreWebVitals = null;

  const extScripts = countExternalScripts(html);

  if (!hasLazyLoading(html) && (html.match(/<img/gi) || []).length > 3) {
    const imgCount = (html.match(/<img/gi) || []).length;
    score -= 2;
    deductions.push({ issue: 'Images not using lazy loading', severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `${imgCount} images found, none use loading="lazy"` });
    findings.push({ issue: 'No lazy loading on images', evidence: `${imgCount} images detected without lazy loading` });
  }

  if (!hasDeferredScripts(html) && extScripts.count > 3) {
    score -= 2;
    deductions.push({ issue: 'Scripts not deferred or async', severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `${extScripts.count} external scripts without defer/async` });
    findings.push({ issue: 'Scripts blocking page render', evidence: `${extScripts.count} scripts without defer/async: ${extScripts.domains.join(', ')}` });
  }

  if (!/webp/i.test(html) && (html.match(/<img/gi) || []).length > 2) {
    score -= 2;
    deductions.push({ issue: 'No WebP images detected', severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: 'No WebP format references found in HTML — may use WebP via CSS or CDN' });
    findings.push({ issue: 'No WebP images', evidence: 'No WebP format references found in page HTML' });
  }

  // Google PageSpeed API
  try {
    const apiKey = process.env.PAGESPEED_API_KEY;
    if (apiKey) {
      const psUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&key=${apiKey}&category=performance`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 25000);
      const psRes = await fetch(psUrl, { signal: controller.signal });
      clearTimeout(t);

      if (psRes.ok) {
        const psData = await psRes.json();
        const cats = psData.lighthouseResult?.categories;
        const audits = psData.lighthouseResult?.audits;

        if (cats?.performance) {
          const perfScore = Math.round(cats.performance.score * 100);
          if (perfScore < 50) {
            score -= 5;
            deductions.push({ issue: `PageSpeed mobile: ${perfScore}/100 (Poor)`, severity: 'CRITICAL', points: -5, confidence: 'VERIFIED', evidence: `Google PageSpeed measured ${perfScore}/100 on mobile` });
            findings.push({ issue: `PageSpeed score ${perfScore}/100`, evidence: `Google measured ${perfScore}/100 performance on mobile devices` });
          } else if (perfScore < 70) {
            score -= 3;
            deductions.push({ issue: `PageSpeed mobile: ${perfScore}/100 (Needs Improvement)`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Google PageSpeed measured ${perfScore}/100 on mobile` });
            findings.push({ issue: `PageSpeed score ${perfScore}/100`, evidence: `Google measured ${perfScore}/100 performance on mobile devices` });
          } else if (perfScore < 90) {
            score -= 1;
            deductions.push({ issue: `PageSpeed mobile: ${perfScore}/100 (Good, room to improve)`, severity: 'LOW', points: -1, confidence: 'VERIFIED', evidence: `Google PageSpeed measured ${perfScore}/100 on mobile` });
            findings.push({ issue: `PageSpeed score ${perfScore}/100`, evidence: `Google measured ${perfScore}/100 — above average but not optimal` });
          }
        }

        if (audits) {
          const lcp = audits['largest-contentful-paint'];
          const cls = audits['cumulative-layout-shift'];
          const tbt = audits['total-blocking-time'];
          coreWebVitals = {
            lcp: lcp?.displayValue || null, lcp_score: lcp?.score,
            cls: cls?.displayValue || null, cls_score: cls?.score,
            tbt: tbt?.displayValue || null, tbt_score: tbt?.score
          };

          if (lcp?.score !== null && lcp?.score < 0.5) {
            score -= 3;
            deductions.push({ issue: `LCP: ${lcp.displayValue} (Slow)`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Largest Contentful Paint: ${lcp.displayValue} — Google threshold: under 2.5s` });
            findings.push({ issue: `Slow LCP: ${lcp.displayValue}`, evidence: `Largest Contentful Paint measured at ${lcp.displayValue} by Google` });
          }
          if (cls?.score !== null && cls?.score < 0.5) {
            score -= 3;
            deductions.push({ issue: `CLS: ${cls.displayValue} (Poor)`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Cumulative Layout Shift: ${cls.displayValue} — Google threshold: under 0.1` });
            findings.push({ issue: `Poor CLS: ${cls.displayValue}`, evidence: `Layout shift measured at ${cls.displayValue} by Google` });
          }
          if (tbt?.score !== null && tbt?.score < 0.5) {
            score -= 2;
            deductions.push({ issue: `TBT: ${tbt.displayValue} (High)`, severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `Total Blocking Time: ${tbt.displayValue}` });
            findings.push({ issue: `High TBT: ${tbt.displayValue}`, evidence: `Total Blocking Time measured at ${tbt.displayValue}` });
          }
          if (audits['render-blocking-resources']?.score === 0) {
            score -= 2;
            deductions.push({ issue: 'Render-blocking resources detected', severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: 'Google detected render-blocking CSS/JS resources' });
            findings.push({ issue: 'Render-blocking resources', evidence: 'Google PageSpeed confirmed render-blocking resources' });
          }
          if (audits['uses-text-compression']?.score === 0) {
            score -= 1;
            deductions.push({ issue: 'Text compression not enabled', severity: 'LOW', points: -1, confidence: 'VERIFIED', evidence: 'Google confirmed no gzip/brotli compression on server responses' });
            findings.push({ issue: 'No text compression', evidence: 'Google confirmed compression is disabled on server' });
          }
        }
      }
    }
  } catch(e) {
    console.log('PageSpeed error:', e.message);
  }

  const patches = await interpretModule('Performance', findings, { page_type: 'website', industry: 'other', platform: 'custom' }, url);
  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: 20 - Math.max(0, score),
    core_web_vitals: coreWebVitals,
    deductions,
    issues: deductions.map(d => d.issue),
    patches
  };
}

// ── MODULE 3: MOBILE ──────────────────────────────────────
async function runMobileModule(html, url, context) {
  let score = 20;
  const deductions = [];
  const findings = [];
  const viewport = getViewport(html);

  if (!viewport) {
    score -= 5;
    deductions.push({ issue: 'Missing viewport meta tag', severity: 'CRITICAL', points: -5, confidence: 'VERIFIED', evidence: 'No <meta name="viewport"> tag found in HTML' });
    findings.push({ issue: 'Missing viewport meta tag', evidence: 'No viewport tag found — site will not scale on mobile' });
  } else {
    if (!viewport.includes('width=device-width')) {
      score -= 3;
      deductions.push({ issue: 'Viewport not set to device-width', severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Current viewport: "${viewport}"` });
      findings.push({ issue: 'Viewport misconfigured', evidence: `Current: "${viewport}"` });
    }
    if (viewport.includes('user-scalable=no') || viewport.includes('user-scalable=0')) {
      score -= 3;
      deductions.push({ issue: 'user-scalable=no prevents zoom', severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `Viewport: "${viewport}" — blocks pinch-to-zoom` });
      findings.push({ issue: 'Zoom disabled by viewport', evidence: `viewport contains user-scalable=no` });
    }
  }

  if (/<[^>]*style=["'][^"']*width:\s*\d{3,4}px[^"']*["']/i.test(html)) {
    score -= 2;
    deductions.push({ issue: 'Fixed pixel width elements detected', severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: 'Inline style with fixed pixel width found' });
    findings.push({ issue: 'Fixed-width elements', evidence: 'Inline CSS with fixed pixel widths detected' });
  }

  const fontMatch = html.match(/font-size:\s*([0-9]+)px/i);
  if (fontMatch && parseInt(fontMatch[1]) < 14) {
    score -= 2;
    deductions.push({ issue: `Font size ${fontMatch[1]}px below minimum`, severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: `Found font-size: ${fontMatch[1]}px — minimum for mobile is 14px` });
    findings.push({ issue: `Font too small (${fontMatch[1]}px)`, evidence: `font-size: ${fontMatch[1]}px found in CSS` });
  }

  if (!/@media/i.test(html) && !/(bootstrap|tailwind|foundation|bulma)/i.test(html)) {
    score -= 2;
    deductions.push({ issue: 'No responsive CSS detected', severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: 'No @media queries or responsive framework found in HTML' });
    findings.push({ issue: 'No responsive design signals', evidence: 'No @media queries or responsive frameworks detected' });
  }

  const btnMatch = html.match(/<button[^>]*style=["'][^"']*(?:width|height):\s*([0-9]+)px/i);
  if (btnMatch && parseInt(btnMatch[1]) < 44) {
    score -= 2;
    deductions.push({ issue: `Touch target too small (${btnMatch[1]}px)`, severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: `Button with ${btnMatch[1]}px dimension found — Google minimum is 44px` });
    findings.push({ issue: `Small touch targets (${btnMatch[1]}px)`, evidence: `Button found with ${btnMatch[1]}px — below 44px minimum` });
  }

  const patches = await interpretModule('Mobile Optimization', findings, context, url);
  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: 20 - Math.max(0, score),
    deductions,
    issues: deductions.map(d => d.issue),
    patches
  };
}

// ── MODULE 4: UX ──────────────────────────────────────────
async function runUXModule(html, url, context) {
  let score = 20;
  const deductions = [];
  const findings = [];

  if (!detectCTA(html)) {
    score -= 3;
    deductions.push({ issue: 'No call-to-action detected', severity: 'HIGH', points: -3, confidence: 'LIKELY', evidence: 'No CTA-related text or button patterns found in HTML' });
    findings.push({ issue: 'No CTA detected', evidence: 'No CTA buttons or links found in HTML' });
  }

  if (!hasNavigation(html)) {
    score -= 3;
    deductions.push({ issue: 'No navigation element', severity: 'HIGH', points: -3, confidence: 'LIKELY', evidence: 'No <nav> tag or role="navigation" found' });
    findings.push({ issue: 'No navigation element', evidence: 'No <nav> or navigation role attribute found' });
  }

  if (!hasContactInfo(html)) {
    score -= 2;
    deductions.push({ issue: 'No contact information found', severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: 'No email, phone, or contact patterns found in HTML text' });
    findings.push({ issue: 'No contact info', evidence: 'No email addresses, phone numbers, or contact links found' });
  }

  if (/<form[\s>]/i.test(html)) {
    const inputs = (html.match(/<input[^>]*type=["'](text|email|tel|password)[^>]*>/gi) || []).length;
    const labels = (html.match(/<label[^>]*>/gi) || []).length;
    if (inputs > 0 && labels < inputs) {
      score -= 3;
      deductions.push({ issue: `Form inputs without labels (${inputs} inputs, ${labels} labels)`, severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `${inputs} form inputs found but only ${labels} labels` });
      findings.push({ issue: 'Form inputs missing labels', evidence: `${inputs} inputs found with only ${labels} label elements` });
    }
  }

  const h2Count = countTag(html, 'h2');
  if (h2Count === 0 && getTextContent(html).length > 500) {
    score -= 2;
    deductions.push({ issue: 'No H2 headings — poor content structure', severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: 'No H2 headings found — content may be JS-rendered' });
    findings.push({ issue: 'No H2 headings', evidence: 'No H2 heading elements found in HTML' });
  }

  if (!/(review|testimonial|rating|stars|trust|clients|customers|award|certified)/i.test(html)) {
    score -= 1;
    deductions.push({ issue: 'No social proof detected', severity: 'LOW', points: -1, confidence: 'LIKELY', evidence: 'No review, testimonial, or trust signal keywords found' });
    findings.push({ issue: 'No social proof', evidence: 'No reviews, testimonials, or trust badges found' });
  }

  if (!hasARIA(html)) {
    score -= 2;
    deductions.push({ issue: 'No ARIA labels found', severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: 'No aria-label attributes or role attributes found' });
    findings.push({ issue: 'No ARIA accessibility labels', evidence: 'No aria-label or role attributes found in HTML' });
  }

  const patches = await interpretModule('UX & Conversion', findings, context, url);
  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: 20 - Math.max(0, score),
    deductions,
    issues: deductions.map(d => d.issue),
    patches
  };
}

// ── MODULE 5: MAINTENANCE ─────────────────────────────────
async function runMaintenanceModule(html, url, context) {
  let score = 20;
  const deductions = [];
  const findings = [];

  if (!hasSSL(url)) {
    score -= 5;
    deductions.push({ issue: 'Site not using HTTPS', severity: 'CRITICAL', points: -5, confidence: 'VERIFIED', evidence: `URL starts with http:// — no SSL certificate` });
    findings.push({ issue: 'No HTTPS', evidence: `URL is ${url} — using HTTP not HTTPS` });
  }

  const mixedContent = detectMixedContent(html);
  if (hasSSL(url) && mixedContent.found) {
    score -= 3;
    deductions.push({ issue: 'Mixed content detected', severity: 'HIGH', points: -3, confidence: 'VERIFIED', evidence: `HTTP resources on HTTPS page: ${mixedContent.evidence.join(', ')}` });
    findings.push({ issue: 'Mixed content (HTTP on HTTPS)', evidence: mixedContent.evidence.join(', ') });
  }

  if (!hasFaviconRobust(html)) {
    score -= 1;
    deductions.push({ issue: 'No favicon detected', severity: 'LOW', points: -1, confidence: 'LIKELY', evidence: 'No favicon link tag found — may be injected by JS or platform' });
    findings.push({ issue: 'No favicon', evidence: 'No favicon link element found in HTML' });
  }

  const copyright = detectOutdatedCopyright(html);
  if (copyright.outdated) {
    score -= 2;
    deductions.push({ issue: `Outdated copyright year (${copyright.year})`, severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `Copyright year ${copyright.year} found — current year is ${new Date().getFullYear()}` });
    findings.push({ issue: `Copyright shows ${copyright.year}`, evidence: `Found "© ${copyright.year}" — should be ${new Date().getFullYear()}` });
  }

  if (!hasRobotsMeta(html)) {
    score -= 1;
    deductions.push({ issue: 'No robots meta tag', severity: 'LOW', points: -1, confidence: 'VERIFIED', evidence: 'No <meta name="robots"> tag found in HTML' });
    findings.push({ issue: 'No robots meta tag', evidence: 'No robots meta tag in page head' });
  }

  if (!hasSitemapRef(html)) {
    score -= 2;
    deductions.push({ issue: 'No sitemap reference', severity: 'MEDIUM', points: -2, confidence: 'LIKELY', evidence: 'No sitemap reference in HTML — sitemap may exist at /sitemap.xml' });
    findings.push({ issue: 'No sitemap reference', evidence: 'No sitemap link or reference found in HTML' });
  }

  // Security headers — mark as POSSIBLE since they are server-side
  const secHeaders = checkSecurityHeaders(html);
  if (!secHeaders.detectable) {
    score -= 1; // Only LOW penalty since this is server-side and hard to verify from HTML
    deductions.push({ issue: 'Security headers not verifiable from HTML', severity: 'LOW', points: -1, confidence: 'POSSIBLE', evidence: 'Security headers (X-Frame-Options, CSP) are server-side — could not verify from HTML content' });
    findings.push({ issue: 'Security headers unverifiable', evidence: 'Headers are set server-side — check via browser DevTools > Network tab' });
  }

  const extScripts = countExternalScripts(html);
  if (extScripts.count > 10) {
    score -= 2;
    deductions.push({ issue: `${extScripts.count} external scripts loaded`, severity: 'MEDIUM', points: -2, confidence: 'VERIFIED', evidence: `Domains: ${extScripts.domains.join(', ')}` });
    findings.push({ issue: `${extScripts.count} external scripts`, evidence: `Loading from: ${extScripts.domains.join(', ')}` });
  }

  const patches = await interpretModule('Maintenance & Security', findings, context, url);
  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: 20 - Math.max(0, score),
    deductions,
    issues: deductions.map(d => d.issue),
    patches
  };
}

// ── AUTOMATION DECISION ENGINE ────────────────────────────
function runAutomationEngine(modules) {
  const safeAutoFix = [];
  const needsApproval = [];
  const blockPublish = [];
  Object.entries(modules).forEach(([mod, result]) => {
    (result.deductions || []).forEach(d => {
      const issue = d.issue.toLowerCase();
      if (d.severity === 'CRITICAL') {
        blockPublish.push({ module: mod, issue: d.issue, confidence: d.confidence });
      } else if (issue.includes('meta description') || issue.includes('alt text') || issue.includes('title too long') || issue.includes('copyright') || issue.includes('open graph') || issue.includes('twitter card')) {
        safeAutoFix.push({ module: mod, issue: d.issue, confidence: d.confidence });
      } else {
        needsApproval.push({ module: mod, issue: d.issue, confidence: d.confidence });
      }
    });
  });
  return { safeAutoFix, needsApproval, blockPublish };
}

// ── SUMMARY WRITER ────────────────────────────────────────
async function writeSummary(url, score, modules, context, pagesScanned) {
  try {
    const totalIssues = Object.values(modules).reduce((a, m) => a + (m.deductions?.length || 0), 0);
    const criticalCount = Object.values(modules).reduce((a, m) => a + (m.deductions || []).filter(d => d.severity === 'CRITICAL').length, 0);
    const prompt = `Write a 2-3 sentence professional website audit summary. Be direct and specific. Do not use markdown headers. Do not start with the site name or URL.

Score: ${score}/100 | Pages: ${pagesScanned} | Issues: ${totalIssues} | Critical: ${criticalCount}
Type: ${context.page_type} | Industry: ${context.industry} | Platform: ${context.platform}
SEO: ${modules.seo?.score}/20 | Performance: ${modules.performance?.score}/20 | Mobile: ${modules.mobile?.score}/20 | UX: ${modules.ux?.score}/20 | Maintenance: ${modules.maintenance?.score}/20`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    let summary = (data.content?.[0]?.text || 'Audit complete.').trim();
    summary = summary.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').trim();
    return summary;
  } catch(e) {
    return 'Audit complete. See module scores for detailed findings.';
  }
}

// ── MAIN HANDLER ──────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getIp(req);
  const rlResult = await rateLimitDB(sb, 'scan:' + ip, 10, 60000);
  if (!rlResult.allowed) return res.status(429).json({ error: 'Too many requests. Please wait before scanning again.' });

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    let cleanUrl;
    try {
      cleanUrl = new URL(url.startsWith('http') ? url : 'https://' + url).toString();
      cleanUrl = cleanUrl.replace(/\/$/, '') || cleanUrl;
    } catch(e) { return res.status(400).json({ error: 'Invalid URL format' }); }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.replace('Bearer ', '');
    const isInternal = token === process.env.CRON_SECRET;
    let currentUser = null;
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (!isInternal) {
      const { data: { user }, error } = await sb.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: 'Invalid session' });
      currentUser = user;

      // Verify the URL belongs to this user or their agency
      // Check user_sites and team_members for ownership
      try {
        // First check if it's directly in user_sites
        const { data: ownSite } = await sb.from('user_sites')
          .select('site_id')
          .eq('user_id', currentUser.id)
          .ilike('url', cleanUrl.replace(/https?:\/\//, '%'))
          .maybeSingle();

        if (!ownSite) {
          // Check if team member — then check agency's sites
          const { data: memberRecord } = await sb.from('team_members')
            .select('agency_id')
            .eq('user_id', currentUser.id)
            .eq('status', 'active')
            .maybeSingle();

          if (memberRecord && memberRecord.agency_id) {
            const { data: agencySite } = await sb.from('user_sites')
              .select('site_id')
              .eq('user_id', memberRecord.agency_id)
              .ilike('url', cleanUrl.replace(/https?:\/\//, '%'))
              .maybeSingle();

            if (!agencySite) {
              return res.status(403).json({ error: 'You do not have permission to scan this site.' });
            }
          } else {
            // Not a team member and not their site
            return res.status(403).json({ error: 'You do not have permission to scan this site.' });
          }
        }
      } catch(ownerErr) {
        console.log('Ownership check error (non-fatal):', ownerErr.message);
        // Don't block scan if ownership check fails — log and continue
      }

      // Check URL for known bad domains/TLDs before fetching
      const urlCheck = checkUrl(cleanUrl);
      if (urlCheck) {
        if (urlCheck.tier === 1 || urlCheck.tier === 2) {
          // Log the attempt for admin review but never delete data or ban accounts
          return res.status(200).json({
            success: false,
            cannotScan: true,
            error: 'This site cannot be scanned by Forge AI.',
            reason: 'This site falls outside our scanning policy.',
            url: cleanUrl
          });
        }
      }

      // Check Google Safe Browsing — never ban, just block the scan
      const safeBrowsing = await checkGoogleSafeBrowsing(cleanUrl);
      if (safeBrowsing && safeBrowsing.flagged) {
        return res.status(200).json({
          success: false,
          cannotScan: true,
          error: 'This site cannot be scanned by Forge AI.',
          reason: 'This site has been flagged by Google Safe Browsing as potentially harmful.',
          url: cleanUrl
        });
      }
    }

    // Pre-check only mode — just check the URL without fetching
    const isPreCheckOnly = req.body && req.body.preCheckOnly;
    if (isPreCheckOnly) {
      return res.status(200).json({ success: true, preCheckOnly: true, url: cleanUrl });
    }

    console.log('Scanning:', cleanUrl);

    const homeResult = await fetchPage(cleanUrl);
    if (homeResult.blocked) return res.status(200).json({ success: false, blocked: true, error: 'This site has bot protection enabled (Cloudflare or similar). Forge AI cannot scan sites that block automated access.', url: cleanUrl });
    if (homeResult.failed || !homeResult.html) return res.status(200).json({ success: false, error: 'Could not reach this site. Please check the URL is correct and the site is live.', url: cleanUrl });

    const homeHtml = homeResult.html;

    // Content moderation check on fetched HTML — never ban, just block the scan
    if (!isInternal && currentUser) {
      const contentCheck = checkContent(homeHtml, cleanUrl);
      if (contentCheck) {
        return res.status(200).json({
          success: false,
          cannotScan: true,
          error: 'This site cannot be scanned by Forge AI.',
          reason: 'This site contains content that falls outside our scanning policy.',
          url: cleanUrl
        });
      }
    }

    const links = extractInternalLinks(homeHtml, cleanUrl);
    const allLinks = [...new Set([cleanUrl, ...links])];
    const limit = getPageLimit(allLinks.length);
    const pagesToScan = allLinks.slice(0, limit);

    console.log(`Crawling ${pagesToScan.length} of ${allLinks.length} pages`);

    const allHtmlParts = [homeHtml];
    for (const pageUrl of pagesToScan.slice(1)) {
      try {
        const r = await fetchPage(pageUrl);
        if (!r.blocked && r.html) allHtmlParts.push(r.html);
      } catch(e) { continue; }
    }

    const combinedHtml = allHtmlParts.join('\n');
    const context = await detectContext(homeHtml, cleanUrl);
    console.log('Context:', JSON.stringify(context));

    // ── GRACEFUL DEGRADATION ─────────────────────────────────
    // Use allSettled so a single module failure doesn't crash the entire scan.
    // Each module gets a safe fallback if it throws.
    function moduleFallback(name, score) {
      return { score, status: 'error', partial: true, error: `${name} module unavailable`,
        deductions: [], patches: [], findings: [], summary: { total: 0 } };
    }

    const [seoRes, mobileRes, uxRes, maintenanceRes, performanceRes, securityRes] = await Promise.allSettled([
      runSEOModule(combinedHtml, cleanUrl, links, allHtmlParts, context),
      runMobileModule(combinedHtml, cleanUrl, context),
      runUXModule(combinedHtml, cleanUrl, context),
      runMaintenanceModule(combinedHtml, cleanUrl, context),
      runPerformanceModule(cleanUrl, homeHtml),
      runSecurityModule(cleanUrl, homeHtml, _lastResponseHeaders)
    ]);

    const seoResult        = seoRes.status === 'fulfilled'         ? seoRes.value         : moduleFallback('SEO', 0);
    const mobileResult     = mobileRes.status === 'fulfilled'      ? mobileRes.value      : moduleFallback('Mobile', 0);
    const uxResult         = uxRes.status === 'fulfilled'          ? uxRes.value          : moduleFallback('UX', 0);
    const maintenanceResult= maintenanceRes.status === 'fulfilled' ? maintenanceRes.value : moduleFallback('Maintenance', 0);
    const performanceResult= performanceRes.status === 'fulfilled' ? performanceRes.value : moduleFallback('Performance', 0);
    const securityResult   = securityRes.status === 'fulfilled'    ? securityRes.value    : moduleFallback('Security', null);

    // Log any module failures for observability
    [['SEO', seoRes], ['Mobile', mobileRes], ['UX', uxRes], ['Maintenance', maintenanceRes],
     ['Performance', performanceRes], ['Security', securityRes]].forEach(([name, r]) => {
      if (r.status === 'rejected') {
        console.error(`Module failure [${name}]:`, r.reason?.message || r.reason);
        Sentry.captureException(r.reason, { extra: { module: name, url: cleanUrl } });
      }
    });

    const moduleResults = { seo: seoResult, performance: performanceResult, mobile: mobileResult, ux: uxResult, maintenance: maintenanceResult, security: securityResult };
    const totalScore = Math.min(100, seoResult.score + performanceResult.score + mobileResult.score + uxResult.score + maintenanceResult.score);
    const grade = totalScore >= 90 ? 'A' : totalScore >= 80 ? 'B' : totalScore >= 70 ? 'C' : totalScore >= 60 ? 'D' : 'F';
    const automation = runAutomationEngine(moduleResults);
    const summary = await writeSummary(cleanUrl, totalScore, moduleResults, context, allHtmlParts.length);

    const allDeductions = Object.entries(moduleResults).flatMap(([mod, r]) => (r.deductions || []).map(d => ({ ...d, module: mod }))).sort((a, b) => a.points - b.points);
    const prioritySummary = allDeductions.slice(0, 5).map(d => `[${d.severity}] ${d.module.toUpperCase()}: ${d.issue} (${d.points} pts)`);

    const result = {
      overall_score: totalScore,
      grade,
      site_name: new URL(cleanUrl).hostname.replace('www.', ''),
      summary,
      audit_mode: context.audit_mode,
      context,
      pages_scanned: allHtmlParts.length,
      pages_found: allLinks.length,
      modules: moduleResults,
      patches: Object.values(moduleResults).flatMap(m => m.patches || []),
      automation,
      priority_summary: prioritySummary,
      critical_issues: automation.blockPublish.length,
      high_issues: Object.values(moduleResults).reduce((a, m) => a + (m.deductions || []).filter(d => d.severity === 'HIGH').length, 0)
    };

    console.log(`Scan complete: ${cleanUrl} — ${totalScore}/100, ${allHtmlParts.length} pages`);
    return res.status(200).json({ success: true, result });

  } catch(err) {
    Sentry.captureException(err);
    console.error('Scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
