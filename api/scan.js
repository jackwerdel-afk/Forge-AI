const { createClient } = require('@supabase/supabase-js');
const { checkUrl, checkContent, checkGoogleSafeBrowsing } = require('./content-check');
const { executeTier1Ban, executeTier2Warning, checkUserStatus, sendAdminAlert } = require('./enforce-ban');

// ── RATE LIMITING ─────────────────────────────────────────
const rateLimitStore = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const record = rateLimitStore.get(ip);
  if (!record || now > record.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (record.count >= 15) return false;
  record.count++;
  return true;
}
function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// ── PAGE FETCHER ──────────────────────────────────────────
async function fetchPage(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  };

  const attempts = [
    async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(url, { signal: controller.signal, headers, redirect: 'follow' });
        clearTimeout(t);
        if (!res.ok) return null;
        return await res.text();
      } catch(e) { clearTimeout(t); return null; }
    },
    async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal: controller.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        const json = await res.json();
        if (json.status?.http_code === 403 || json.status?.http_code === 429) return 'BLOCKED';
        return json.contents && json.contents.length > 200 ? json.contents : null;
      } catch(e) { clearTimeout(t); return null; }
    },
    async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { signal: controller.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        const text = await res.text();
        return text && text.length > 200 ? text : null;
      } catch(e) { clearTimeout(t); return null; }
    }
  ];

  for (const attempt of attempts) {
    const result = await attempt();
    if (!result) continue;
    if (result === 'BLOCKED') return { html: null, blocked: true };
    const lower = result.toLowerCase();
    if (
      (lower.includes('checking your browser') && lower.includes('cloudflare')) ||
      lower.includes('ddos-guard') ||
      lower.includes('enable javascript and cookies to continue') ||
      (lower.includes('access denied') && result.length < 2000) ||
      (lower.includes('please wait') && lower.includes('captcha'))
    ) return { html: null, blocked: true };
    return { html: result, blocked: false };
  }
  return { html: null, blocked: false, failed: true };
}

// ── LINK EXTRACTOR ────────────────────────────────────────
function extractInternalLinks(html, baseUrl) {
  const links = new Set();
  try {
    const base = new URL(baseUrl);
    const regex = /href=["']([^"'#?]+)["']/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      try {
        const href = match[1].trim();
        if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
        let fullUrl;
        if (href.startsWith('http')) fullUrl = new URL(href);
        else if (href.startsWith('/')) fullUrl = new URL(href, base.origin);
        else continue;
        if (fullUrl.hostname !== base.hostname) continue;
        if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|txt|zip|doc|docx|mp4|mp3)$/i.test(fullUrl.pathname)) continue;
        links.add(fullUrl.origin + fullUrl.pathname.replace(/\/$/, '') || '/');
      } catch(e) { continue; }
    }
  } catch(e) {}
  return Array.from(links);
}

function getPageLimit(total) {
  if (total <= 20) return total;
  if (total <= 100) return 25;
  return 15;
}

// ── HTML UTILITIES ────────────────────────────────────────
function getMeta(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']{0,500})["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']{0,500})["'][^>]*name=["']${name}["']`, 'i'),
    new RegExp(`<meta[^>]*property=["']${name}["'][^>]*content=["']([^"']{0,500})["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']{0,500})["'][^>]*property=["']${name}["']`, 'i'),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function getTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  return m ? m[1].trim() : null;
}

function countTag(html, tag) {
  return (html.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
}

function getTextContent(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(html) {
  return getTextContent(html).split(/\s+/).filter(w => w.length > 2).length;
}

function getImagesWithoutAlt(html) {
  const imgs = html.match(/<img[^>]*>/gi) || [];
  const missing = imgs.filter(img => !img.match(/alt=["'][^"']+["']/i));
  const evidence = missing.slice(0, 5).map(img => {
    const srcMatch = img.match(/src=["']([^"']{0,100})["']/i);
    return srcMatch ? srcMatch[1].split('/').pop() || srcMatch[1] : 'unknown image';
  });
  return { count: missing.length, evidence };
}

function hasFaviconRobust(html) {
  // Check multiple ways favicon might be declared
  return /<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i.test(html) ||
    /<link[^>]*href=["'][^"']*favicon[^"']*["'][^>]*>/i.test(html) ||
    html.includes('/favicon.ico') ||
    html.includes('apple-touch-icon') ||
    /(wordpress|shopify|squarespace|wix|webflow)/i.test(html); // These platforms always inject favicons
}

function hasSchema(html) {
  return html.includes('application/ld+json') || html.includes('itemtype=');
}

function hasCanonical(html) {
  return /<link[^>]*rel=["']canonical["'][^>]*>/i.test(html);
}

function countExternalScripts(html) {
  const scripts = html.match(/<script[^>]*src=["']https?:\/\/([^"'/]*)[^"']*["'][^>]*>/gi) || [];
  const domains = new Set(scripts.map(s => {
    const m = s.match(/src=["']https?:\/\/([^"'/]*)/i);
    return m ? m[1] : null;
  }).filter(Boolean));
  return { count: scripts.length, domains: Array.from(domains).slice(0, 5) };
}

function hasLazyLoading(html) {
  return /loading=["']lazy["']/i.test(html) || /data-src=/i.test(html);
}

function hasDeferredScripts(html) {
  return /\bdefer\b/i.test(html) || /\basync\b/i.test(html);
}

function detectCTA(html) {
  return /(btn|button|cta|get.started|sign.up|contact.us|buy.now|shop.now|learn.more|free.trial|get.demo|schedule|book.now|request.quote)/i.test(html);
}

function hasNavigation(html) {
  return /<nav[\s>]/i.test(html) || /role=["']navigation["']/i.test(html);
}

function hasContactInfo(html) {
  return /(mailto:|tel:|@[a-z]+\.[a-z]+|contact|phone|email)/i.test(html);
}

function hasSSL(url) {
  return url.startsWith('https://');
}

function detectMixedContent(html) {
  const httpSrcs = (html.match(/src=["']http:\/\/[^"']+["']/gi) || []).filter(s => !s.includes('localhost'));
  return { found: httpSrcs.length > 0, evidence: httpSrcs.slice(0, 3).map(s => s.replace(/src=["']|["']/g, '')) };
}

function hasSitemapRef(html) {
  return /sitemap/i.test(html);
}

function hasRobotsMeta(html) {
  return getMeta(html, 'robots') !== null;
}

function detectOutdatedCopyright(html) {
  const year = new Date().getFullYear();
  const match = html.match(/©\s*(\d{4})|copyright\s*©?\s*(\d{4})/i);
  if (match) {
    const found = parseInt(match[1] || match[2]);
    return { outdated: found < year - 1, year: found };
  }
  return { outdated: false, year: null };
}

function getViewport(html) {
  return getMeta(html, 'viewport');
}

function checkHeadingHierarchy(html) {
  const hasH1 = /<h1[\s>]/i.test(html);
  const hasH2 = /<h2[\s>]/i.test(html);
  const hasH3 = /<h3[\s>]/i.test(html);
  return hasH1 && hasH3 && !hasH2;
}

function hasOpenGraph(html) {
  const title = getMeta(html, 'og:title') || /property=["']og:title["']/i.test(html);
  const desc = getMeta(html, 'og:description') || /property=["']og:description["']/i.test(html);
  const image = getMeta(html, 'og:image') || /property=["']og:image["']/i.test(html);
  return { hasTitle: !!title, hasDesc: !!desc, hasImage: !!image, complete: !!(title && desc && image) };
}

function hasTwitterCard(html) {
  return getMeta(html, 'twitter:card') !== null || /name=["']twitter:card["']/i.test(html);
}

function hasARIA(html) {
  return /aria-label=/i.test(html) || /role=["'][^"']+["']/i.test(html);
}

function checkSecurityHeaders(html) {
  // Security headers are server-side - we can only detect if explicitly added to HTML meta tags
  const hasCSP = /content-security-policy/i.test(html) || /<meta[^>]*http-equiv=["']content-security-policy["'][^>]*>/i.test(html);
  const hasXFrame = /x-frame-options/i.test(html);
  // If we can't verify from HTML, mark as unverifiable
  return { detectable: hasCSP || hasXFrame, hasCSP, hasXFrame };
}

function getDuplicateMetaAcrossPages(allHtmlParts) {
  const metas = allHtmlParts.map(h => getMeta(h, 'description')).filter(Boolean);
  const unique = new Set(metas);
  return metas.length > 1 && unique.size < metas.length
    ? metas.length - unique.size
    : 0;
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
  if (!rateLimit(ip)) return res.status(429).json({ error: 'Too many requests.' });

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

      // User status check removed — Forge AI does not ban users

      // Check URL for known bad domains/TLDs before fetching
      const urlCheck = checkUrl(cleanUrl);
      if (urlCheck) {
        if (urlCheck.tier === 1 || urlCheck.tier === 2) {
          // Log the attempt for admin review but never delete data or ban accounts
          await sendAdminAlert(urlCheck.tier, user.email, user.id, cleanUrl, urlCheck.category, urlCheck.reason, ip).catch(() => {});
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
        await sendAdminAlert(1, user.email, user.id, cleanUrl, 'malware', safeBrowsing.reason, ip).catch(() => {});
        return res.status(200).json({
          success: false,
          cannotScan: true,
          error: 'This site cannot be scanned by Forge AI.',
          reason: 'This site has been flagged by Google Safe Browsing as potentially harmful.',
          url: cleanUrl
        });
      }
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
        await sendAdminAlert(contentCheck.tier, currentUser.email, currentUser.id, cleanUrl, contentCheck.category, contentCheck.reason, ip).catch(() => {});
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

    const [seoResult, mobileResult, uxResult, maintenanceResult, performanceResult] = await Promise.all([
      runSEOModule(combinedHtml, cleanUrl, links, allHtmlParts, context),
      runMobileModule(combinedHtml, cleanUrl, context),
      runUXModule(combinedHtml, cleanUrl, context),
      runMaintenanceModule(combinedHtml, cleanUrl, context),
      runPerformanceModule(cleanUrl, homeHtml)
    ]);

    const moduleResults = { seo: seoResult, performance: performanceResult, mobile: mobileResult, ux: uxResult, maintenance: maintenanceResult };
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
    console.error('Scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
