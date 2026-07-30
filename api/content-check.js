const { createClient } = require('@supabase/supabase-js');

// Tier 1 — Instant permanent ban
const TIER1_PATTERNS = {
  adult: [
    /\bporn\b/i, /\bxxx\b/i, /\badult.?content\b/i, /\bnude[sd]?\b/i,
    /\bescort[s]?\b/i, /\bsex.?(site|cam|video|chat)\b/i, /\bonlyfans\b/i,
    /\bstripper[s]?\b/i, /\berotica\b/i, /\bhentai\b/i
  ],
  illegal: [
    /\bbuy.{0,10}(cocaine|heroin|meth|fentanyl|drugs)\b/i,
    /\bhuman.?traffic/i, /\bweapons?.?for.?sale\b/i,
    /\bbuy.{0,10}(ak.?47|ar.?15|pistol|gun)\b/i,
    /\bcounterfeit\b/i, /\bchild.?porn/i, /\bcsam\b/i,
    /\bcp.?site\b/i, /\billegal.?(drugs?|weapons?|firearms?)\b/i
  ],
  phishing: [
    /verify.?your.?(account|password|credit.?card|bank)/i,
    /your.?account.?has.?been.?(suspended|locked|compromised)/i,
    /click.?here.?to.?unlock.?your.?account/i,
    /free.?(iphone|gift.?card|money|bitcoin)/i
  ],
  malware: [
    /download.?virus/i, /install.?malware/i, /trojan/i,
    /ransomware/i, /spyware/i, /keylogger/i
  ]
};

// Tier 2 — Soft block with warning
const TIER2_PATTERNS = {
  gambling: [
    /\bonline.?casino\b/i, /\bbet.?(now|online|here)\b/i,
    /\bsports.?betting\b/i, /\bpoker.?(room|site|online)\b/i,
    /\bslot.?(machine|games?|online)\b/i, /\bwager\b/i,
    /\bbookmaker\b/i, /\bodds.?(calculator|comparison)\b/i
  ],
  impersonation: [
    /official.?apple.?support/i, /official.?microsoft.?support/i,
    /official.?google.?support/i, /official.?amazon.?support/i,
    /official.?paypal.?support/i, /official.?bank.?support/i,
    /irs.?official/i, /fbi.?official/i
  ]
};

// Known bad TLD patterns
const BAD_TLDS = ['.onion', '.tor2web'];

// Known malware/phishing domains (small list — in production use Google Safe Browsing API)
const KNOWN_BAD_DOMAINS = [
  'freebitcoin.win', 'cryptoscam.net', 'phishing-test.com'
];

async function checkGoogleSafeBrowsing(url) {
  try {
    if (!process.env.GOOGLE_SAFE_BROWSING_KEY) return null;
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${process.env.GOOGLE_SAFE_BROWSING_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'forgeai', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.matches && data.matches.length > 0) {
      return { flagged: true, reason: 'Google Safe Browsing: ' + data.matches[0].threatType };
    }
    return { flagged: false };
  } catch(e) {
    return null;
  }
}

// Known adult/explicit domains to block at URL level
const BLOCKED_DOMAINS = [
  'xvideos.com', 'pornhub.com', 'xhamster.com', 'redtube.com', 'youporn.com',
  'tube8.com', 'spankbang.com', 'xnxx.com', 'beeg.com', 'livejasmin.com',
  'chaturbate.com', 'onlyfans.com', 'stripchat.com', 'myfreecams.com',
  'brazzers.com', 'realitykings.com', 'bangbros.com', 'naughtyamerica.com'
];


// ── SSRF PROTECTION ────────────────────────────────────────────────────────
// Blocks requests to private networks, loopback, cloud metadata endpoints,
// and other internal infrastructure that should never be scanned.
// This prevents Server-Side Request Forgery (SSRF) attacks.

const BLOCKED_IP_RANGES = [
  // Loopback
  /^127\./, 
  /^::1$/,
  // RFC-1918 Private ranges
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  // Link-local
  /^169\.254\./,
  /^fe80:/i,
  // Cloud metadata endpoints
  /^100\.64\./,   // CGNAT
  /^0\.0\.0\.0/,
  /^::$/,
  /^0::/,
];

const BLOCKED_HOSTNAMES = [
  // AWS metadata
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.internal',
  // Azure metadata
  '169.254.169.254',
  // Common internal hostnames
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  // Kubernetes
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
];

const BLOCKED_SCHEMES = ['file:', 'ftp:', 'gopher:', 'dict:', 'ldap:', 'ldaps:', 'sftp:', 'tftp:'];

function checkSSRF(url) {
  try {
    const parsed = new URL(url);
    
    // Block non-HTTP(S) schemes
    if (BLOCKED_SCHEMES.includes(parsed.protocol)) {
      return { blocked: true, reason: `Disallowed URL scheme: ${parsed.protocol}` };
    }
    
    // Must be HTTP or HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { blocked: true, reason: `Only HTTP and HTTPS URLs are allowed` };
    }

    // Check hostname against blocked list
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.some(h => hostname === h || hostname.endsWith('.' + h))) {
      return { blocked: true, reason: `Blocked hostname: ${hostname}` };
    }

    // Check if hostname is a raw IP address
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (ipv4Regex.test(hostname)) {
      // Block all private/special IP ranges
      for (const range of BLOCKED_IP_RANGES) {
        if (range.test(hostname)) {
          return { blocked: true, reason: `Blocked IP range: ${hostname}` };
        }
      }
      // Also block any IP that starts with 0
      if (hostname.startsWith('0.')) {
        return { blocked: true, reason: `Blocked IP: ${hostname}` };
      }
    }

    // Block non-standard ports that could access internal services
    const port = parseInt(parsed.port);
    if (parsed.port && port) {
      const allowedPorts = [80, 443, 8080, 8443];
      if (!allowedPorts.includes(port)) {
        return { blocked: true, reason: `Non-standard port blocked: ${port}` };
      }
    }

    return null; // Not blocked
  } catch(e) {
    return { blocked: true, reason: 'Invalid URL' };
  }
}

function checkUrl(url) {
  // ── SSRF CHECK — must run first ────────────────────────
  const ssrfCheck = checkSSRF(url);
  if (ssrfCheck) {
    return { tier: 0, category: 'ssrf', reason: ssrfCheck.reason };
  }

  // Check against known blocked domains first
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    if (BLOCKED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d))) {
      return { tier: 1, category: 'adult', reason: 'Adult content domain' };
    }
  } catch(e) {}
  const lower = url.toLowerCase();

  // Check bad TLDs
  for (const tld of BAD_TLDS) {
    if (lower.includes(tld)) {
      return { tier: 1, category: 'illegal', reason: 'Dark web / illegal TLD detected' };
    }
  }

  // Check known bad domains
  try {
    const domain = new URL(url).hostname.toLowerCase();
    if (KNOWN_BAD_DOMAINS.some(d => domain.includes(d))) {
      return { tier: 1, category: 'malware', reason: 'Known malicious domain' };
    }
  } catch(e) {}

  // Also check URL against Tier 1 content patterns (adult, illegal, etc.)
  for (const [category, patterns] of Object.entries(TIER1_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(url)) {
        return { tier: 1, category, reason: `${category} content detected in URL` };
      }
    }
  }

  return null;
}

function checkContent(html, url) {
  if (!html) return null;

  // Check Tier 1 patterns against HTML content
  for (const [category, patterns] of Object.entries(TIER1_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(html)) {
        return { tier: 1, category, reason: `${category} content detected` };
      }
    }
  }

  // Check URL itself for tier 1
  for (const [category, patterns] of Object.entries(TIER1_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(url)) {
        return { tier: 1, category, reason: `${category} content in URL` };
      }
    }
  }

  // Check Tier 2 patterns
  for (const [category, patterns] of Object.entries(TIER2_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(html) || pattern.test(url)) {
        return { tier: 2, category, reason: `${category} content detected` };
      }
    }
  }

  return null;
}

module.exports = { checkUrl, checkContent, checkGoogleSafeBrowsing, checkSSRF };
