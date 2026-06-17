const { createClient } = require('@supabase/supabase-js');

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
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'max-age=0'
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
        if (href.startsWith('http')) {
          fullUrl = new URL(href);
        } else if (href.startsWith('/')) {
          fullUrl = new URL(href, base.origin);
        } else continue;
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

function countImagesWithoutAlt(html) {
  const imgs = html.match(/<img[^>]*>/gi) || [];
  return imgs.filter(img => !img.match(/alt=["'][^"']+["']/i)).length;
}

function hasTag(html, tag) {
  return new RegExp(`<${tag}[\\s/>]`, 'i').test(html);
}

function hasSchema(html) {
  return html.includes('application/ld+json') || html.includes('itemtype=');
}

function hasCanonical(html) {
  return /<link[^>]*rel=["']canonical["'][^>]*>/i.test(html);
}

function hasFavicon(html) {
  return /<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*>/i.test(html);
}

function hasLazyLoading(html) {
  return /loading=["']lazy["']/i.test(html) || /data-src=/i.test(html);
}

function hasDeferredScripts(html) {
  return /\bdefer\b/i.test(html) || /\basync\b/i.test(html);
}

function countExternalScripts(html) {
  return (html.match(/<script[^>]*src=["']https?:\/\/[^"']*["'][^>]*>/gi) || []).length;
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
  return /src=["']http:\/\//i.test(html) && !/<meta[^>]*http-equiv/i.test(html);
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
  if (match) return parseInt(match[1] || match[2]) < year - 1;
  return false;
}

function getViewport(html) {
  return getMeta(html, 'viewport');
}

function checkHeadingHierarchy(html) {
  const h1 = html.indexOf('<h1');
  const h2 = html.indexOf('<h2');
  const h3 = html.indexOf('<h3');
  if (h1 === -1 || h2 !== -1) return false;
  if (h1 !== -1 && h3 !== -1 && h2 === -1) return true; // H1 → H3 skip
  return false;
}

function hasOpenGraph(html) {
  return getMeta(html, 'og:title') !== null || /property=["']og:title["']/i.test(html);
}

function hasTwitterCard(html) {
  return getMeta(html, 'twitter:card') !== null || /name=["']twitter:card["']/i.test(html);
}

function hasARIA(html) {
  return /aria-label=/i.test(html) || /role=["'][^"']+["']/i.test(html);
}

function hasSecurityHeaders(html) {
  return /x-frame-options|content-security-policy|x-content-type/i.test(html);
}

// ── BROKEN LINK CHECKER ───────────────────────────────────
async function checkBrokenLinks(links, baseUrl) {
  const broken = [];
  const toCheck = links.slice(0, 20); // Check up to 20 links

  await Promise.all(toCheck.map(async (link) => {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(link, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'ForgeAI-LinkChecker/1.0' }
      });
      clearTimeout(t);
      if (res.status === 404 || res.status === 410) {
        broken.push({ url: link, status: res.status });
      }
    } catch(e) { /* skip on timeout */ }
  }));

  return broken;
}

// ── CONTEXT DETECTOR ──────────────────────────────────────
async function detectContext(html, url) {
  try {
    const textSample = getTextContent(html).slice(0, 800);
    const prompt = `Analyze this webpage and return ONLY a JSON object with no markdown:
URL: ${url}
Content sample: ${textSample}

Return exactly:
{"page_type":"homepage|landing|blog|ecommerce|portfolio|service|other","industry":"agency|retail|healthcare|tech|restaurant|finance|education|other","platform":"wordpress|webflow|wix|squarespace|shopify|custom","audit_mode":"full_audit"}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    return { page_type: 'homepage', industry: 'other', platform: 'custom', audit_mode: 'full_audit' };
  }
}

// ── MODULE AI INTERPRETER ─────────────────────────────────
async function interpretModule(moduleName, issues, context, url) {
  if (issues.length === 0) return [];
  try {
    const prompt = `You are a ${moduleName} specialist reviewing a ${context.industry} ${context.page_type} website built on ${context.platform}.

URL: ${url}
Issues detected by code analysis:
${issues.map((i, n) => `${n + 1}. ${i}`).join('\n')}

For each issue provide a specific, actionable fix recommendation for this exact type of site.
Return ONLY a JSON array of strings, one fix per issue, no markdown:
["fix for issue 1", "fix for issue 2", ...]`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    const text = data.content?.[0]?.text?.trim() || '[]';
    const clean = text.replace(/```json|```/g, '').trim();
    const patches = JSON.parse(clean);
    return Array.isArray(patches) ? patches : [];
  } catch(e) {
    return issues.map(i => `Fix: ${i}`);
  }
}

// ── MODULE 1: SEO ─────────────────────────────────────────
async function runSEOModule(allHtml, url, internalLinks, context) {
  let score = 20;
  const deductions = [];
  const issues = [];

  const metaDesc = getMeta(allHtml, 'description');
  const title = getTitle(allHtml);
  const h1Count = countTag(allHtml, 'h1');
  const missingAlt = countImagesWithoutAlt(allHtml);
  const wordCount = countWords(allHtml);

  // Meta description
  if (!metaDesc) {
    score -= 5; deductions.push({ issue: 'Missing meta description', severity: 'CRITICAL', points: -5 });
    issues.push('Missing meta description');
  } else if (metaDesc.length < 50) {
    score -= 3; deductions.push({ issue: `Meta description too short (${metaDesc.length} chars)`, severity: 'HIGH', points: -3 });
    issues.push(`Meta description too short (${metaDesc.length} chars — minimum 120)`);
  } else if (metaDesc.length > 160) {
    score -= 2; deductions.push({ issue: `Meta description too long (${metaDesc.length} chars)`, severity: 'MEDIUM', points: -2 });
    issues.push(`Meta description too long (${metaDesc.length} chars — maximum 160)`);
  }

  // Page title
  if (!title) {
    score -= 5; deductions.push({ issue: 'Missing page title', severity: 'CRITICAL', points: -5 });
    issues.push('Missing page title tag');
  } else if (title.length > 60) {
    score -= 2; deductions.push({ issue: `Page title too long (${title.length} chars)`, severity: 'MEDIUM', points: -2 });
    issues.push(`Page title too long (${title.length} chars — maximum 60)`);
  }

  // H1
  if (h1Count === 0) {
    score -= 5; deductions.push({ issue: 'Missing H1 heading', severity: 'CRITICAL', points: -5 });
    issues.push('Missing H1 heading — required for SEO');
  } else if (h1Count > 1) {
    score -= 3; deductions.push({ issue: `Multiple H1 tags (${h1Count} found)`, severity: 'HIGH', points: -3 });
    issues.push(`Multiple H1 tags found (${h1Count}) — should have exactly one`);
  }

  // Alt text
  if (missingAlt > 0) {
    const pts = Math.min(6, missingAlt * 3);
    score -= pts; deductions.push({ issue: `${missingAlt} images missing alt text`, severity: 'HIGH', points: -pts });
    issues.push(`${missingAlt} image${missingAlt > 1 ? 's' : ''} missing alt text`);
  }

  // Canonical
  if (!hasCanonical(allHtml)) {
    score -= 1; deductions.push({ issue: 'Missing canonical tag', severity: 'LOW', points: -1 });
    issues.push('Missing canonical link tag');
  }

  // Schema
  if (!hasSchema(allHtml)) {
    score -= 1; deductions.push({ issue: 'No structured data found', severity: 'LOW', points: -1 });
    issues.push('No structured data (schema markup) found');
  }

  // Open Graph
  if (!hasOpenGraph(allHtml)) {
    score -= 2; deductions.push({ issue: 'Missing Open Graph tags', severity: 'MEDIUM', points: -2 });
    issues.push('Missing Open Graph tags (og:title, og:description, og:image) — needed for social sharing');
  }

  // Twitter Card
  if (!hasTwitterCard(allHtml)) {
    score -= 1; deductions.push({ issue: 'Missing Twitter Card tags', severity: 'LOW', points: -1 });
    issues.push('Missing Twitter Card meta tags');
  }

  // Heading hierarchy
  if (checkHeadingHierarchy(allHtml)) {
    score -= 2; deductions.push({ issue: 'Broken heading hierarchy (H1→H3 skip)', severity: 'MEDIUM', points: -2 });
    issues.push('Broken heading hierarchy — H1 jumps to H3 skipping H2');
  }

  // Thin content
  if (wordCount < 300) {
    score -= 2; deductions.push({ issue: `Thin content detected (${wordCount} words)`, severity: 'MEDIUM', points: -2 });
    issues.push(`Thin content detected (${wordCount} words — minimum 300 recommended for SEO)`);
  }

  // Broken links
  if (internalLinks.length > 0) {
    const broken = await checkBrokenLinks(internalLinks, url);
    if (broken.length > 0) {
      score -= 3; deductions.push({ issue: `${broken.length} broken internal link${broken.length > 1 ? 's' : ''} detected`, severity: 'HIGH', points: -3 });
      issues.push(`${broken.length} broken internal link${broken.length > 1 ? 's' : ''} returning 404`);
    }
  }

  const patches = await interpretModule('SEO', issues, context, url);
  const totalDeducted = 20 - Math.max(0, score);

  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: totalDeducted,
    deductions,
    issues,
    patches
  };
}

// ── MODULE 2: PERFORMANCE ─────────────────────────────────
async function runPerformanceModule(url, html) {
  let score = 20;
  const deductions = [];
  const issues = [];
  let coreWebVitals = null;

  // HTML-based checks
  if (!hasLazyLoading(html) && (html.match(/<img/gi) || []).length > 3) {
    score -= 2; deductions.push({ issue: 'Images not using lazy loading', severity: 'MEDIUM', points: -2 });
    issues.push('Images not using lazy loading — increases initial page load time');
  }

  if (!hasDeferredScripts(html) && countExternalScripts(html) > 3) {
    score -= 2; deductions.push({ issue: 'Scripts not deferred or async', severity: 'MEDIUM', points: -2 });
    issues.push('External scripts not deferred or async — blocking page render');
  }

  if (!/webp/i.test(html) && (html.match(/<img/gi) || []).length > 2) {
    score -= 2; deductions.push({ issue: 'No WebP images detected', severity: 'MEDIUM', points: -2 });
    issues.push('No WebP format images detected — WebP reduces file size by 25-35%');
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
            score -= 5; deductions.push({ issue: `PageSpeed mobile score: ${perfScore}/100 (Poor)`, severity: 'CRITICAL', points: -5 });
            issues.push(`Google PageSpeed mobile score: ${perfScore}/100 — Poor performance`);
          } else if (perfScore < 70) {
            score -= 3; deductions.push({ issue: `PageSpeed mobile score: ${perfScore}/100 (Needs Improvement)`, severity: 'HIGH', points: -3 });
            issues.push(`Google PageSpeed mobile score: ${perfScore}/100 — Needs improvement`);
          } else if (perfScore < 90) {
            score -= 1; deductions.push({ issue: `PageSpeed mobile score: ${perfScore}/100 (Good)`, severity: 'LOW', points: -1 });
            issues.push(`Google PageSpeed mobile score: ${perfScore}/100 — Minor optimization possible`);
          }
        }

        if (audits) {
          // Core Web Vitals
          const lcp = audits['largest-contentful-paint'];
          const cls = audits['cumulative-layout-shift'];
          const tbt = audits['total-blocking-time'];

          coreWebVitals = {
            lcp: lcp?.displayValue || null,
            cls: cls?.displayValue || null,
            tbt: tbt?.displayValue || null,
            lcp_score: lcp?.score,
            cls_score: cls?.score,
            tbt_score: tbt?.score
          };

          if (lcp?.score !== null && lcp?.score < 0.5) {
            score -= 3; deductions.push({ issue: `LCP: ${lcp.displayValue} (Slow)`, severity: 'HIGH', points: -3 });
            issues.push(`Largest Contentful Paint: ${lcp.displayValue} — should be under 2.5s`);
          }

          if (cls?.score !== null && cls?.score < 0.5) {
            score -= 3; deductions.push({ issue: `CLS: ${cls.displayValue} (Poor)`, severity: 'HIGH', points: -3 });
            issues.push(`Cumulative Layout Shift: ${cls.displayValue} — should be under 0.1`);
          }

          if (tbt?.score !== null && tbt?.score < 0.5) {
            score -= 2; deductions.push({ issue: `TBT: ${tbt.displayValue} (Poor)`, severity: 'MEDIUM', points: -2 });
            issues.push(`Total Blocking Time: ${tbt.displayValue} — indicates slow JavaScript execution`);
          }

          if (audits['render-blocking-resources']?.score === 0) {
            score -= 2; deductions.push({ issue: 'Render-blocking resources detected', severity: 'MEDIUM', points: -2 });
            issues.push('Render-blocking CSS or JavaScript resources detected');
          }

          if (audits['uses-text-compression']?.score === 0) {
            score -= 1; deductions.push({ issue: 'Text compression not enabled', severity: 'LOW', points: -1 });
            issues.push('Text compression (gzip/brotli) not enabled on server');
          }
        }
      }
    } else {
      // No API key - use only HTML checks, don't penalize
      console.log('No PAGESPEED_API_KEY found');
    }
  } catch(e) {
    console.log('PageSpeed error:', e.message);
  }

  const patches = await interpretModule('Performance', issues, { page_type: 'website', industry: 'other', platform: 'custom' }, url);
  const totalDeducted = 20 - Math.max(0, score);

  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: totalDeducted,
    core_web_vitals: coreWebVitals,
    deductions,
    issues,
    patches
  };
}

// ── MODULE 3: MOBILE ──────────────────────────────────────
async function runMobileModule(html, url, context) {
  let score = 20;
  const deductions = [];
  const issues = [];

  const viewport = getViewport(html);

  if (!viewport) {
    score -= 5; deductions.push({ issue: 'Missing viewport meta tag', severity: 'CRITICAL', points: -5 });
    issues.push('Missing viewport meta tag — site will not display correctly on mobile');
  } else {
    if (!viewport.includes('width=device-width')) {
      score -= 3; deductions.push({ issue: 'Viewport not set to device-width', severity: 'HIGH', points: -3 });
      issues.push('Viewport not configured for device-width responsiveness');
    }
    if (viewport.includes('user-scalable=no') || viewport.includes('user-scalable=0')) {
      score -= 3; deductions.push({ issue: 'user-scalable=no prevents zoom', severity: 'HIGH', points: -3 });
      issues.push('user-scalable=no prevents users from zooming — fails accessibility standards');
    }
  }

  if (/<[^>]*style=["'][^"']*width:\s*\d{3,4}px[^"']*["']/i.test(html)) {
    score -= 2; deductions.push({ issue: 'Fixed pixel width elements detected', severity: 'MEDIUM', points: -2 });
    issues.push('Fixed pixel width elements detected — may break on mobile screens');
  }

  const fontMatch = html.match(/font-size:\s*([0-9]+)px/i);
  if (fontMatch && parseInt(fontMatch[1]) < 14) {
    score -= 2; deductions.push({ issue: `Font size ${fontMatch[1]}px detected (below 14px)`, severity: 'MEDIUM', points: -2 });
    issues.push(`Font size ${fontMatch[1]}px detected — below minimum 14px for mobile readability`);
  }

  if (!/@media/i.test(html) && !/(bootstrap|tailwind|foundation|bulma)/i.test(html)) {
    score -= 2; deductions.push({ issue: 'No responsive design signals detected', severity: 'MEDIUM', points: -2 });
    issues.push('No CSS media queries or responsive framework detected');
  }

  // Touch targets
  if (/<button[^>]*style=["'][^"']*(?:width|height):\s*([0-9]+)px[^"']*["']/i.test(html)) {
    const sizeMatch = html.match(/<button[^>]*style=["'][^"']*(?:width|height):\s*([0-9]+)px/i);
    if (sizeMatch && parseInt(sizeMatch[1]) < 44) {
      score -= 2; deductions.push({ issue: 'Touch targets below 44px minimum', severity: 'MEDIUM', points: -2 });
      issues.push('Button/touch targets below Google\'s 44px minimum for mobile usability');
    }
  }

  const patches = await interpretModule('Mobile Optimization', issues, context, url);
  const totalDeducted = 20 - Math.max(0, score);

  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: totalDeducted,
    deductions,
    issues,
    patches
  };
}

// ── MODULE 4: UX ──────────────────────────────────────────
async function runUXModule(html, url, context) {
  let score = 20;
  const deductions = [];
  const issues = [];

  if (!detectCTA(html)) {
    score -= 3; deductions.push({ issue: 'No call-to-action detected', severity: 'HIGH', points: -3 });
    issues.push('No clear call-to-action button or link detected');
  }

  if (!hasNavigation(html)) {
    score -= 3; deductions.push({ issue: 'No navigation element detected', severity: 'HIGH', points: -3 });
    issues.push('No navigation element found (missing <nav> tag or role="navigation")');
  }

  if (!hasContactInfo(html)) {
    score -= 2; deductions.push({ issue: 'No contact information found', severity: 'MEDIUM', points: -2 });
    issues.push('No contact information found (email, phone, or contact link)');
  }

  if (/<form[\s>]/i.test(html)) {
    const inputs = (html.match(/<input[^>]*type=["'](text|email|tel|password)[^>]*>/gi) || []).length;
    const labels = (html.match(/<label[^>]*>/gi) || []).length;
    if (inputs > 0 && labels < inputs) {
      score -= 3; deductions.push({ issue: 'Form inputs missing labels', severity: 'HIGH', points: -3 });
      issues.push('Form inputs detected without corresponding labels — accessibility issue');
    }
  }

  const h2Count = countTag(html, 'h2');
  if (h2Count === 0 && getTextContent(html).length > 500) {
    score -= 2; deductions.push({ issue: 'No H2 headings — poor content structure', severity: 'MEDIUM', points: -2 });
    issues.push('No H2 headings found — poor content structure and readability');
  }

  if (!/(review|testimonial|rating|stars|trust|clients|customers|award|certified)/i.test(html)) {
    score -= 1; deductions.push({ issue: 'No social proof detected', severity: 'LOW', points: -1 });
    issues.push('No social proof elements detected (reviews, testimonials, trust badges)');
  }

  if (!hasARIA(html)) {
    score -= 2; deductions.push({ issue: 'No ARIA labels found', severity: 'MEDIUM', points: -2 });
    issues.push('No ARIA labels or roles found — accessibility concern for screen readers');
  }

  const patches = await interpretModule('UX & Conversion', issues, context, url);
  const totalDeducted = 20 - Math.max(0, score);

  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: totalDeducted,
    deductions,
    issues,
    patches
  };
}

// ── MODULE 5: MAINTENANCE ─────────────────────────────────
async function runMaintenanceModule(html, url, context) {
  let score = 20;
  const deductions = [];
  const issues = [];

  if (!hasSSL(url)) {
    score -= 5; deductions.push({ issue: 'Site not using HTTPS', severity: 'CRITICAL', points: -5 });
    issues.push('Site is not using HTTPS — critical security and SEO issue');
  }

  if (hasSSL(url) && detectMixedContent(html)) {
    score -= 3; deductions.push({ issue: 'Mixed content detected', severity: 'HIGH', points: -3 });
    issues.push('Mixed content detected — HTTP resources loaded on HTTPS page');
  }

  if (!hasFavicon(html)) {
    score -= 1; deductions.push({ issue: 'Missing favicon', severity: 'LOW', points: -1 });
    issues.push('No favicon detected');
  }

  if (detectOutdatedCopyright(html)) {
    score -= 2; deductions.push({ issue: 'Outdated copyright year', severity: 'MEDIUM', points: -2 });
    issues.push(`Outdated copyright year detected — site appears unmaintained`);
  }

  if (!hasRobotsMeta(html)) {
    score -= 1; deductions.push({ issue: 'Missing robots meta tag', severity: 'LOW', points: -1 });
    issues.push('No robots meta tag found');
  }

  if (!hasSitemapRef(html)) {
    score -= 2; deductions.push({ issue: 'No sitemap reference found', severity: 'MEDIUM', points: -2 });
    issues.push('No sitemap reference detected in HTML');
  }

  if (!hasSecurityHeaders(html)) {
    score -= 2; deductions.push({ issue: 'Security headers not detected', severity: 'MEDIUM', points: -2 });
    issues.push('Security headers not detected (X-Frame-Options, Content-Security-Policy)');
  }

  const extScripts = countExternalScripts(html);
  if (extScripts > 10) {
    score -= 2; deductions.push({ issue: `${extScripts} external scripts loaded`, severity: 'MEDIUM', points: -2 });
    issues.push(`${extScripts} external scripts detected — increases attack surface and load time`);
  }

  const patches = await interpretModule('Maintenance & Security', issues, context, url);
  const totalDeducted = 20 - Math.max(0, score);

  return {
    score: Math.max(0, score),
    status_label: score >= 18 ? 'Excellent' : score >= 15 ? 'Good' : score >= 10 ? 'Needs Work' : 'Critical',
    total_points_deducted: totalDeducted,
    deductions,
    issues,
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
        blockPublish.push({ module: mod, issue: d.issue });
      } else if (
        issue.includes('meta description') ||
        issue.includes('alt text') ||
        issue.includes('title too long') ||
        issue.includes('copyright year') ||
        issue.includes('open graph') ||
        issue.includes('twitter card')
      ) {
        safeAutoFix.push({ module: mod, issue: d.issue });
      } else {
        needsApproval.push({ module: mod, issue: d.issue });
      }
    });
  });

  return { safeAutoFix, needsApproval, blockPublish };
}

// ── SUMMARY WRITER ────────────────────────────────────────
async function writeSummary(url, score, modules, context, pagesScanned) {
  try {
    const totalIssues = Object.values(modules).reduce((a, m) => a + (m.issues?.length || 0), 0);
    const criticalCount = Object.values(modules).reduce((a, m) =>
      a + (m.deductions || []).filter(d => d.severity === 'CRITICAL').length, 0);

    const prompt = `Write a 2-3 sentence professional website audit summary. Be direct and specific. Do not use markdown. Do not start with the URL or a header.

Site: ${url}
Type: ${context.page_type} | Industry: ${context.industry} | Platform: ${context.platform}
Score: ${score}/100 | Pages scanned: ${pagesScanned}
Total issues: ${totalIssues} | Critical: ${criticalCount}
SEO: ${modules.seo?.score}/20 | Performance: ${modules.performance?.score}/20 | Mobile: ${modules.mobile?.score}/20 | UX: ${modules.ux?.score}/20 | Maintenance: ${modules.maintenance?.score}/20`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();
    let summary = data.content?.[0]?.text?.trim() || 'Audit complete.';
    summary = summary.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/^["']|["']$/g, '').trim();
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
  if (!rateLimit(ip)) return res.status(429).json({ error: 'Too many requests. Please slow down.' });

  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    let cleanUrl;
    try {
      cleanUrl = new URL(url.startsWith('http') ? url : 'https://' + url).toString();
      cleanUrl = cleanUrl.replace(/\/$/, '') || cleanUrl;
    } catch(e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.replace('Bearer ', '');
    const isInternal = token === process.env.CRON_SECRET;
    if (!isInternal) {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: { user }, error } = await sb.auth.getUser(token);
      if (error || !user) return res.status(401).json({ error: 'Invalid session' });
    }

    console.log('Starting scan:', cleanUrl);

    // STEP 1: Fetch homepage
    const homeResult = await fetchPage(cleanUrl);

    if (homeResult.blocked) {
      return res.status(200).json({
        success: false,
        blocked: true,
        error: 'This site has bot protection enabled (Cloudflare or similar). Forge AI cannot scan sites that block automated access. This is common on large enterprise sites.',
        url: cleanUrl
      });
    }

    if (homeResult.failed || !homeResult.html) {
      return res.status(200).json({
        success: false,
        error: 'Could not reach this site. Please check the URL is correct and the site is live.',
        url: cleanUrl
      });
    }

    const homeHtml = homeResult.html;

    // STEP 2: Crawl pages
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

    // STEP 3: Context detection
    const context = await detectContext(homeHtml, cleanUrl);
    console.log('Context:', JSON.stringify(context));

    // STEP 4: Run all modules (performance runs separately for PageSpeed)
    const [seoResult, mobileResult, uxResult, maintenanceResult, performanceResult] = await Promise.all([
      runSEOModule(combinedHtml, cleanUrl, links, context),
      runMobileModule(combinedHtml, cleanUrl, context),
      runUXModule(combinedHtml, cleanUrl, context),
      runMaintenanceModule(combinedHtml, cleanUrl, context),
      runPerformanceModule(cleanUrl, homeHtml)
    ]);

    const moduleResults = {
      seo: seoResult,
      performance: performanceResult,
      mobile: mobileResult,
      ux: uxResult,
      maintenance: maintenanceResult
    };

    // STEP 5: Score
    const totalScore = Math.min(100,
      seoResult.score + performanceResult.score + mobileResult.score +
      uxResult.score + maintenanceResult.score
    );
    const grade = totalScore >= 90 ? 'A' : totalScore >= 80 ? 'B' : totalScore >= 70 ? 'C' : totalScore >= 60 ? 'D' : 'F';

    // STEP 6: Automation engine
    const automation = runAutomationEngine(moduleResults);

    // STEP 7: Summary
    const summary = await writeSummary(cleanUrl, totalScore, moduleResults, context, allHtmlParts.length);

    // STEP 8: Priority summary
    const allDeductions = Object.entries(moduleResults).flatMap(([mod, r]) =>
      (r.deductions || []).map(d => ({ ...d, module: mod }))
    ).sort((a, b) => a.points - b.points);

    const prioritySummary = allDeductions.slice(0, 5).map(d =>
      `[${d.severity}] ${d.module.toUpperCase()}: ${d.issue} (${d.points})`
    );

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
      high_issues: Object.values(moduleResults).reduce((a, m) =>
        a + (m.deductions || []).filter(d => d.severity === 'HIGH').length, 0)
    };

    console.log(`Scan complete: ${cleanUrl} — ${totalScore}/100, ${allHtmlParts.length} pages`);
    return res.status(200).json({ success: true, result });

  } catch(err) {
    console.error('Scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
