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
  // Try direct fetch first (works server-side on Vercel)
  const attempts = [
    // Direct fetch with browser-like headers
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ForgeAI/1.0; +https://forgeai-wgs.com)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
          }
        });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const html = await res.text();
        return html && html.length > 200 ? html : null;
      } catch(e) { clearTimeout(timeout); return null; }
    },
    // Proxy fallback 1
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const json = await res.json();
        if (json.status?.http_code === 403 || json.status?.http_code === 429) return null;
        return json.contents && json.contents.length > 200 ? json.contents : null;
      } catch(e) { clearTimeout(timeout); return null; }
    },
    // Proxy fallback 2
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return null;
        const html = await res.text();
        return html && html.length > 200 ? html : null;
      } catch(e) { clearTimeout(timeout); return null; }
    }
  ];

  for (const attempt of attempts) {
    const html = await attempt();
    if (!html) continue;

    // Detect bot protection
    const lower = html.toLowerCase();
    if (
      (lower.includes('checking your browser') && lower.includes('cloudflare')) ||
      lower.includes('ddos-guard') ||
      (lower.includes('please wait') && lower.includes('captcha')) ||
      (lower.includes('access denied') && html.length < 1000) ||
      lower.includes('enable javascript and cookies to continue')
    ) {
      return { html: null, blocked: true };
    }

    return { html, blocked: false };
  }

  return { html: null, blocked: false, failed: true };
}

// ── LINK EXTRACTOR ────────────────────────────────────────
function extractInternalLinks(html, baseUrl) {
  const links = new Set();
  try {
    const base = new URL(baseUrl);
    const hrefRegex = /href=["']([^"'#?]+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      try {
        const href = match[1].trim();
        if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
        
        let fullUrl;
        if (href.startsWith('http://') || href.startsWith('https://')) {
          fullUrl = new URL(href);
        } else if (href.startsWith('/')) {
          fullUrl = new URL(href, base.origin);
        } else {
          continue;
        }

        // Only internal links, no file downloads
        if (fullUrl.hostname === base.hostname) {
          const path = fullUrl.pathname;
          if (path.match(/\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js|xml|txt|zip|doc|docx)$/i)) continue;
          links.add(fullUrl.origin + path);
        }
      } catch(e) { continue; }
    }
  } catch(e) {}
  return Array.from(links);
}

// ── SMART PAGE LIMIT ──────────────────────────────────────
function getPageLimit(totalFound) {
  if (totalFound <= 20) return totalFound; // Small site - scan all
  if (totalFound <= 100) return 25;        // Medium site - scan 25
  return 15;                                // Large site - scan 15
}

// ── HTML PARSER UTILITIES ─────────────────────────────────
function getMeta(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'),
    new RegExp(`<meta[^>]*property=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'),
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function getTitle(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : null;
}

function countTag(html, tag) {
  return (html.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
}

function getTagContent(html, tag) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'));
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
}

function countImagesWithoutAlt(html) {
  const imgs = html.match(/<img[^>]*>/gi) || [];
  return imgs.filter(img => !img.match(/alt=["'][^"']+["']/i)).length;
}

function hasTag(html, tag) {
  return new RegExp(`<${tag}[\\s/>]`, 'i').test(html);
}

function getViewport(html) {
  return getMeta(html, 'viewport');
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

function countExternalScripts(html) {
  const scripts = html.match(/<script[^>]*src=["'][^"']*["'][^>]*>/gi) || [];
  return scripts.filter(s => s.includes('http')).length;
}

function hasLazyLoading(html) {
  return html.includes('loading="lazy"') || html.includes("loading='lazy'") || html.includes('data-src=');
}

function hasDeferredScripts(html) {
  return html.includes('defer') || html.includes('async');
}

function detectCTA(html) {
  const ctaPatterns = /(<button|<a)[^>]*(btn|button|cta|call-to-action|get.started|sign.up|contact|buy|shop|learn.more|free.trial|get.demo)[^>]*/i;
  return ctaPatterns.test(html);
}

function hasNavigation(html) {
  return /<nav[\s>]/i.test(html) || /<[^>]*role=["']navigation["'][^>]*>/i.test(html);
}

function hasContactInfo(html) {
  return /(\+1|tel:|mailto:|@|contact|phone|email)/i.test(html);
}

function hasSSL(url) {
  return url.startsWith('https://');
}

function detectMixedContent(html) {
  return /src=["']http:\/\//i.test(html) || /href=["']http:\/\//i.test(html);
}

function hasSitemapLink(html) {
  return /sitemap/i.test(html);
}

function hasRobotsMeta(html) {
  return getMeta(html, 'robots') !== null;
}

function detectOutdatedCopyright(html) {
  const currentYear = new Date().getFullYear();
  const match = html.match(/©\s*(\d{4})|copyright\s*(\d{4})/i);
  if (match) {
    const year = parseInt(match[1] || match[2]);
    return year < currentYear - 1;
  }
  return false;
}

function getTextContent(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── MODULE 1: SEO ─────────────────────────────────────────
function runSEOModule(html, url) {
  let score = 20;
  const deductions = [];
  const issues = [];
  const patches = [];

  const metaDesc = getMeta(html, 'description');
  const title = getTitle(html);
  const h1Count = countTag(html, 'h1');
  const missingAlt = countImagesWithoutAlt(html);

  // Meta description
  if (!metaDesc) {
    score -= 5; deductions.push({ issue: 'Missing meta description', severity: 'CRITICAL', points: -5 });
    issues.push('Missing meta description');
    patches.push('Add a meta description tag between 120-160 characters describing the page content');
  } else if (metaDesc.length < 50) {
    score -= 3; deductions.push({ issue: 'Meta description too short (' + metaDesc.length + ' chars)', severity: 'HIGH', points: -3 });
    issues.push('Meta description too short (' + metaDesc.length + ' chars, minimum 50)');
    patches.push('Expand meta description to at least 120 characters with relevant keywords');
  } else if (metaDesc.length > 160) {
    score -= 2; deductions.push({ issue: 'Meta description too long (' + metaDesc.length + ' chars)', severity: 'MEDIUM', points: -2 });
    issues.push('Meta description too long (' + metaDesc.length + ' chars, maximum 160)');
    patches.push('Shorten meta description to under 160 characters to prevent truncation in search results');
  }

  // Page title
  if (!title) {
    score -= 5; deductions.push({ issue: 'Missing page title', severity: 'CRITICAL', points: -5 });
    issues.push('Missing page title tag');
    patches.push('Add a descriptive title tag under 60 characters including your primary keyword');
  } else if (title.length > 60) {
    score -= 2; deductions.push({ issue: 'Page title too long (' + title.length + ' chars)', severity: 'MEDIUM', points: -2 });
    issues.push('Page title too long (' + title.length + ' chars, maximum 60)');
    patches.push('Shorten page title to under 60 characters to prevent truncation in search results');
  }

  // H1
  if (h1Count === 0) {
    score -= 5; deductions.push({ issue: 'Missing H1 heading', severity: 'CRITICAL', points: -5 });
    issues.push('Missing H1 heading tag');
    patches.push('Add exactly one H1 tag that clearly describes the main topic of the page');
  } else if (h1Count > 1) {
    score -= 3; deductions.push({ issue: 'Multiple H1 tags found (' + h1Count + ')', severity: 'HIGH', points: -3 });
    issues.push('Multiple H1 tags found (' + h1Count + ' — should be exactly 1)');
    patches.push('Remove extra H1 tags and keep only one primary H1 per page');
  }

  // Alt text
  if (missingAlt > 0) {
    const pts = Math.min(6, missingAlt * 3);
    score -= pts; deductions.push({ issue: missingAlt + ' images missing alt text', severity: 'HIGH', points: -pts });
    issues.push(missingAlt + ' image' + (missingAlt > 1 ? 's' : '') + ' missing alt text');
    patches.push('Add descriptive alt text to all ' + missingAlt + ' images for accessibility and SEO');
  }

  // Canonical
  if (!hasCanonical(html)) {
    score -= 1; deductions.push({ issue: 'Missing canonical tag', severity: 'LOW', points: -1 });
    issues.push('Missing canonical link tag');
    patches.push('Add a canonical link tag to prevent duplicate content issues');
  }

  // Schema
  if (!hasSchema(html)) {
    score -= 1; deductions.push({ issue: 'No structured data found', severity: 'LOW', points: -1 });
    issues.push('No structured data (schema markup) found');
    patches.push('Add schema markup (JSON-LD) to help search engines understand your content');
  }

  return {
    score: Math.max(0, score),
    deductions,
    issues,
    patches
  };
}

// ── MODULE 2: MOBILE ──────────────────────────────────────
function runMobileModule(html, url) {
  let score = 20;
  const deductions = [];
  const issues = [];
  const patches = [];

  const viewport = getViewport(html);

  // Viewport
  if (!viewport) {
    score -= 5; deductions.push({ issue: 'Missing viewport meta tag', severity: 'CRITICAL', points: -5 });
    issues.push('Missing viewport meta tag — site will not display correctly on mobile');
    patches.push('Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head section');
  } else {
    if (!viewport.includes('width=device-width')) {
      score -= 3; deductions.push({ issue: 'Viewport not set to device-width', severity: 'HIGH', points: -3 });
      issues.push('Viewport not configured for device-width responsiveness');
      patches.push('Update viewport meta tag to include width=device-width for proper mobile scaling');
    }
    if (viewport.includes('user-scalable=no') || viewport.includes('user-scalable=0')) {
      score -= 3; deductions.push({ issue: 'user-scalable=no prevents zoom', severity: 'HIGH', points: -3 });
      issues.push('user-scalable=no prevents users from zooming — fails accessibility standards');
      patches.push('Remove user-scalable=no from viewport meta tag to allow user zoom');
    }
  }

  // Fixed width
  if (/<[^>]*style=["'][^"']*width:\s*\d{3,4}px[^"']*["']/i.test(html)) {
    score -= 2; deductions.push({ issue: 'Fixed pixel width elements detected', severity: 'MEDIUM', points: -2 });
    issues.push('Fixed pixel width elements detected — may break on mobile screens');
    patches.push('Replace fixed pixel widths with percentage or max-width values for responsive design');
  }

  // Small font size
  if (/font-size:\s*([0-9]+)px/i.test(html)) {
    const fontMatch = html.match(/font-size:\s*([0-9]+)px/i);
    if (fontMatch && parseInt(fontMatch[1]) < 14) {
      score -= 2; deductions.push({ issue: 'Font size below 14px detected', severity: 'MEDIUM', points: -2 });
      issues.push('Font size below 14px detected — too small for comfortable mobile reading');
      patches.push('Increase base font size to at least 16px for comfortable mobile reading');
    }
  }

  // Media queries (positive check)
  if (!/@media/i.test(html) && !html.includes('responsive') && !html.includes('bootstrap') && !html.includes('tailwind')) {
    score -= 2; deductions.push({ issue: 'No responsive design signals detected', severity: 'MEDIUM', points: -2 });
    issues.push('No responsive CSS media queries detected');
    patches.push('Implement CSS media queries or a responsive framework for mobile optimization');
  }

  return {
    score: Math.max(0, score),
    deductions,
    issues,
    patches
  };
}

// ── MODULE 3: UX ──────────────────────────────────────────
function runUXModule(html, url) {
  let score = 20;
  const deductions = [];
  const issues = [];
  const patches = [];

  // CTA
  if (!detectCTA(html)) {
    score -= 3; deductions.push({ issue: 'No clear call-to-action detected', severity: 'HIGH', points: -3 });
    issues.push('No clear call-to-action button or link detected');
    patches.push('Add a prominent call-to-action button above the fold to guide visitors');
  }

  // Navigation
  if (!hasNavigation(html)) {
    score -= 3; deductions.push({ issue: 'No navigation element detected', severity: 'HIGH', points: -3 });
    issues.push('No navigation element detected (no <nav> tag or role="navigation")');
    patches.push('Add a proper navigation element with role="navigation" for usability and accessibility');
  }

  // Contact info
  if (!hasContactInfo(html)) {
    score -= 2; deductions.push({ issue: 'No contact information found', severity: 'MEDIUM', points: -2 });
    issues.push('No contact information found (email, phone, or contact link)');
    patches.push('Add visible contact information or a contact page link to build trust with visitors');
  }

  // Forms without labels
  if (/<form[\s>]/i.test(html)) {
    const formInputs = (html.match(/<input[^>]*type=["'](text|email|tel|password)[^>]*>/gi) || []).length;
    const labels = (html.match(/<label[^>]*>/gi) || []).length;
    if (formInputs > 0 && labels < formInputs) {
      score -= 3; deductions.push({ issue: 'Form inputs missing labels', severity: 'HIGH', points: -3 });
      issues.push('Form inputs detected without corresponding labels — accessibility issue');
      patches.push('Add <label> elements to all form inputs for accessibility compliance');
    }
  }

  // Heading structure
  const h2Count = countTag(html, 'h2');
  const h3Count = countTag(html, 'h3');
  if (h2Count === 0 && getTextContent(html).length > 500) {
    score -= 2; deductions.push({ issue: 'No H2 headings found', severity: 'MEDIUM', points: -2 });
    issues.push('No H2 headings found — poor content structure');
    patches.push('Add H2 headings to organize content and improve readability');
  }

  // Social proof
  if (!/review|testimonial|rating|stars|trust|clients|customers/i.test(html)) {
    score -= 1; deductions.push({ issue: 'No social proof detected', severity: 'LOW', points: -1 });
    issues.push('No social proof elements detected (reviews, testimonials, ratings)');
    patches.push('Add customer testimonials, reviews, or trust badges to increase conversion');
  }

  return {
    score: Math.max(0, score),
    deductions,
    issues,
    patches
  };
}

// ── MODULE 4: MAINTENANCE ─────────────────────────────────
function runMaintenanceModule(html, url) {
  let score = 20;
  const deductions = [];
  const issues = [];
  const patches = [];

  // SSL
  if (!hasSSL(url)) {
    score -= 5; deductions.push({ issue: 'Site not using HTTPS', severity: 'CRITICAL', points: -5 });
    issues.push('Site is using HTTP not HTTPS — major security and SEO issue');
    patches.push('Install an SSL certificate and redirect all HTTP traffic to HTTPS');
  }

  // Mixed content
  if (hasSSL(url) && detectMixedContent(html)) {
    score -= 3; deductions.push({ issue: 'Mixed content detected (HTTP resources on HTTPS page)', severity: 'HIGH', points: -3 });
    issues.push('Mixed content detected — HTTP resources loaded on HTTPS page');
    patches.push('Update all resource URLs to use HTTPS to fix mixed content warnings');
  }

  // Favicon
  if (!hasFavicon(html)) {
    score -= 1; deductions.push({ issue: 'Missing favicon', severity: 'LOW', points: -1 });
    issues.push('No favicon detected');
    patches.push('Add a favicon to improve brand recognition in browser tabs and bookmarks');
  }

  // Outdated copyright
  if (detectOutdatedCopyright(html)) {
    score -= 2; deductions.push({ issue: 'Outdated copyright year detected', severity: 'MEDIUM', points: -2 });
    issues.push('Outdated copyright year detected — site may appear unmaintained');
    patches.push('Update copyright year to ' + new Date().getFullYear() + ' to show the site is actively maintained');
  }

  // Robots meta
  if (!hasRobotsMeta(html)) {
    score -= 1; deductions.push({ issue: 'Missing robots meta tag', severity: 'LOW', points: -1 });
    issues.push('No robots meta tag found');
    patches.push('Add a robots meta tag to control search engine crawling behavior');
  }

  // Sitemap
  if (!hasSitemapLink(html)) {
    score -= 2; deductions.push({ issue: 'No sitemap reference found', severity: 'MEDIUM', points: -2 });
    issues.push('No sitemap link or reference detected in HTML');
    patches.push('Create and submit an XML sitemap to help search engines discover all pages');
  }

  // External scripts (too many)
  const externalScripts = countExternalScripts(html);
  if (externalScripts > 10) {
    score -= 2; deductions.push({ issue: externalScripts + ' external scripts loaded', severity: 'MEDIUM', points: -2 });
    issues.push(externalScripts + ' external scripts detected — increases load time and security risk');
    patches.push('Audit and reduce external script dependencies to improve performance and security');
  }

  return {
    score: Math.max(0, score),
    deductions,
    issues,
    patches
  };
}

// ── MODULE 5: PERFORMANCE (Google PageSpeed) ──────────────
async function runPerformanceModule(url, html) {
  let score = 20;
  const deductions = [];
  const issues = [];
  const patches = [];

  // Always run basic HTML checks
  const externalScripts = countExternalScripts(html);
  const hasLazy = hasLazyLoading(html);
  const hasDefer = hasDeferredScripts(html);

  if (!hasLazy && (html.match(/<img/gi) || []).length > 3) {
    score -= 2; deductions.push({ issue: 'Images not using lazy loading', severity: 'MEDIUM', points: -2 });
    issues.push('Images not using lazy loading — increases initial page load time');
    patches.push('Add loading="lazy" attribute to images below the fold');
  }

  if (!hasDefer && externalScripts > 3) {
    score -= 2; deductions.push({ issue: 'Scripts not deferred or async', severity: 'MEDIUM', points: -2 });
    issues.push('External scripts not using defer or async — blocking page render');
    patches.push('Add defer or async attribute to non-critical script tags');
  }

  // Google PageSpeed Insights API
  try {
    const apiKey = process.env.PAGESPEED_API_KEY;
    if (apiKey) {
      const psUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=mobile&key=${apiKey}&category=performance`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const psRes = await fetch(psUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (psRes.ok) {
        const psData = await psRes.json();
        const categories = psData.lighthouseResult?.categories;
        const audits = psData.lighthouseResult?.audits;

        if (categories?.performance) {
          const perfScore = Math.round(categories.performance.score * 100);

          // Map PageSpeed score to deductions
          if (perfScore < 50) {
            score -= 5; deductions.push({ issue: 'PageSpeed mobile score: ' + perfScore + '/100 (Poor)', severity: 'CRITICAL', points: -5 });
            issues.push('Google PageSpeed mobile score: ' + perfScore + '/100 — Poor performance');
            patches.push('Run Google PageSpeed Insights for detailed performance recommendations');
          } else if (perfScore < 70) {
            score -= 3; deductions.push({ issue: 'PageSpeed mobile score: ' + perfScore + '/100 (Needs Improvement)', severity: 'HIGH', points: -3 });
            issues.push('Google PageSpeed mobile score: ' + perfScore + '/100 — Needs improvement');
            patches.push('Optimize images, reduce render-blocking resources, and enable compression');
          } else if (perfScore < 90) {
            score -= 1; deductions.push({ issue: 'PageSpeed mobile score: ' + perfScore + '/100 (Good)', severity: 'LOW', points: -1 });
            issues.push('Google PageSpeed mobile score: ' + perfScore + '/100 — Room for improvement');
            patches.push('Consider additional optimizations to reach 90+ PageSpeed score');
          }

          // Check specific audits
          if (audits) {
            if (audits['render-blocking-resources']?.score === 0) {
              score -= 2; deductions.push({ issue: 'Render-blocking resources detected', severity: 'MEDIUM', points: -2 });
              issues.push('Render-blocking CSS or JavaScript resources detected');
              patches.push('Eliminate render-blocking resources by deferring non-critical CSS and JS');
            }
            if (audits['uses-optimized-images']?.score < 0.5) {
              score -= 2; deductions.push({ issue: 'Images not optimized', severity: 'MEDIUM', points: -2 });
              issues.push('Images could be better optimized for web delivery');
              patches.push('Convert images to WebP format and compress them using a tool like Squoosh');
            }
            if (audits['uses-text-compression']?.score === 0) {
              score -= 1; deductions.push({ issue: 'Text compression not enabled', severity: 'LOW', points: -1 });
              issues.push('Text compression (gzip/brotli) not enabled on server');
              patches.push('Enable gzip or brotli compression on your web server to reduce transfer size');
            }
          }
        }
      }
    }
  } catch(psErr) {
    console.log('PageSpeed API error:', psErr.message);
  }

  return {
    score: Math.max(0, score),
    deductions,
    issues,
    patches
  };
}

// ── WRITE SUMMARY WITH CLAUDE ─────────────────────────────
async function writeSummary(url, totalScore, moduleResults, pageCount) {
  try {
    const issueCount = Object.values(moduleResults).reduce((a, m) => a + m.issues.length, 0);
    const criticalCount = Object.values(moduleResults).reduce((a, m) => 
      a + m.deductions.filter(d => d.severity === 'CRITICAL').length, 0);

    const prompt = `Write a professional 2-3 sentence website audit summary for ${url}.

Score: ${totalScore}/100
Pages scanned: ${pageCount}
Total issues found: ${issueCount}
Critical issues: ${criticalCount}
SEO: ${moduleResults.seo.score}/20
Performance: ${moduleResults.performance.score}/20
Mobile: ${moduleResults.mobile.score}/20
UX: ${moduleResults.ux.score}/20
Maintenance: ${moduleResults.maintenance.score}/20

Write a concise professional summary. Do not use the word "I". Be direct and specific.`;

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
    return data.content?.[0]?.text?.trim() || 'Audit complete. See module scores for details.';
  } catch(e) {
    return 'Audit complete. See module scores for details.';
  }
}

// ── AUTOMATION DECISION ENGINE ────────────────────────────
function runAutomationEngine(moduleResults) {
  const safeAutoFix = [];
  const needsApproval = [];
  const blockPublish = [];

  Object.entries(moduleResults).forEach(([module, result]) => {
    result.deductions.forEach(d => {
      if (d.severity === 'CRITICAL') {
        blockPublish.push({ module, issue: d.issue });
      } else if (
        d.issue.includes('meta description') ||
        d.issue.includes('alt text') ||
        d.issue.includes('title too long') ||
        d.issue.includes('copyright year')
      ) {
        safeAutoFix.push({ module, issue: d.issue });
      } else {
        needsApproval.push({ module, issue: d.issue });
      }
    });
  });

  return { safeAutoFix, needsApproval, blockPublish };
}

// ── MAIN HANDLER ──────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ip = getIp(req);
  if (!rateLimit(ip)) return res.status(429).json({ error: 'Too many requests. Please slow down.' });

  try {
    const { url, internal } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    // Validate URL
    let cleanUrl;
    try {
      cleanUrl = new URL(url.startsWith('http') ? url : 'https://' + url).toString();
      // Remove trailing slash for consistency
      cleanUrl = cleanUrl.replace(/\/$/, '') || cleanUrl;
    } catch(e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Auth check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.replace('Bearer ', '');
    const isInternalCall = token === process.env.CRON_SECRET;

    if (!isInternalCall) {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: { user }, error: authError } = await sb.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Invalid session' });
    }

    console.log('Scanning:', cleanUrl);

    // ── STEP 1: Fetch homepage ──────────────────────────
    const homepageResult = await fetchPage(cleanUrl);

    if (homepageResult.blocked) {
      return res.status(200).json({
        success: false,
        blocked: true,
        error: 'This site blocked automated access. Common reasons: bot protection (Cloudflare), login required, or geographic restriction. Try scanning a specific page URL instead.',
        url: cleanUrl
      });
    }

    if (homepageResult.failed || !homepageResult.html) {
      return res.status(200).json({
        success: false,
        error: 'Could not reach this site. Please check the URL and try again.',
        url: cleanUrl
      });
    }

    const homepageHtml = homepageResult.html;

    // ── STEP 2: Crawl internal pages ───────────────────
    const internalLinks = extractInternalLinks(homepageHtml, cleanUrl);
    const uniqueLinks = [...new Set([cleanUrl, ...internalLinks])];
    const pageLimit = getPageLimit(uniqueLinks.length);
    const pagesToScan = uniqueLinks.slice(0, pageLimit);

    console.log(`Found ${uniqueLinks.length} pages, scanning ${pagesToScan.length}`);

    // Collect HTML from all pages
    const allPagesHtml = [homepageHtml];
    for (const pageUrl of pagesToScan.slice(1)) {
      try {
        const pageResult = await fetchPage(pageUrl);
        if (!pageResult.blocked && pageResult.html) {
          allPagesHtml.push(pageResult.html);
        }
      } catch(e) { continue; }
    }

    // Combine all HTML for analysis
    const combinedHtml = allPagesHtml.join('\n');

    // ── STEP 3: Run all modules ─────────────────────────
    const [seoResult, mobileResult, uxResult, maintenanceResult, performanceResult] = await Promise.all([
      Promise.resolve(runSEOModule(combinedHtml, cleanUrl)),
      Promise.resolve(runMobileModule(combinedHtml, cleanUrl)),
      Promise.resolve(runUXModule(combinedHtml, cleanUrl)),
      Promise.resolve(runMaintenanceModule(combinedHtml, cleanUrl)),
      runPerformanceModule(cleanUrl, homepageHtml)
    ]);

    const moduleResults = {
      seo: seoResult,
      performance: performanceResult,
      mobile: mobileResult,
      ux: uxResult,
      maintenance: maintenanceResult
    };

    // ── STEP 4: Calculate final score ──────────────────
    const totalScore = Math.min(100,
      seoResult.score +
      performanceResult.score +
      mobileResult.score +
      uxResult.score +
      maintenanceResult.score
    );

    const grade = totalScore >= 90 ? 'A' : totalScore >= 80 ? 'B' : totalScore >= 70 ? 'C' : totalScore >= 60 ? 'D' : 'F';

    // ── STEP 5: Automation Decision Engine ─────────────
    const automation = runAutomationEngine(moduleResults);

    // ── STEP 6: Write summary with Claude ──────────────
    const summary = await writeSummary(cleanUrl, totalScore, moduleResults, allPagesHtml.length);

    // ── STEP 7: Build all patches ──────────────────────
    const allPatches = Object.values(moduleResults).flatMap(m => m.patches);

    // ── STEP 8: Return complete result ─────────────────
    const result = {
      overall_score: totalScore,
      grade,
      site_name: new URL(cleanUrl).hostname.replace('www.', ''),
      summary,
      pages_scanned: allPagesHtml.length,
      pages_found: uniqueLinks.length,
      modules: {
        seo: { score: seoResult.score, issues: seoResult.issues, patches: seoResult.patches, deductions: seoResult.deductions },
        performance: { score: performanceResult.score, issues: performanceResult.issues, patches: performanceResult.patches, deductions: performanceResult.deductions },
        mobile: { score: mobileResult.score, issues: mobileResult.issues, patches: mobileResult.patches, deductions: mobileResult.deductions },
        ux: { score: uxResult.score, issues: uxResult.issues, patches: uxResult.patches, deductions: uxResult.deductions },
        maintenance: { score: maintenanceResult.score, issues: maintenanceResult.issues, patches: maintenanceResult.patches, deductions: maintenanceResult.deductions }
      },
      patches: allPatches,
      automation,
      critical_issues: automation.blockPublish.length,
      high_issues: Object.values(moduleResults).reduce((a, m) =>
        a + m.deductions.filter(d => d.severity === 'HIGH').length, 0)
    };

    console.log(`Scan complete: ${cleanUrl} scored ${totalScore}/100, ${allPagesHtml.length} pages scanned`);
    return res.status(200).json({ success: true, result });

  } catch(err) {
    console.error('Scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
