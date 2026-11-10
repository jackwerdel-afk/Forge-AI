// ── RENDER FETCH ─────────────────────────────────────────────
// Headless browser content extractor for Forge AI scanner.
// Launches a real Chromium browser, fully executes JavaScript,
// then extracts rendered content from the live DOM.
//
// This is what makes Forge Agent accurate on JS-rendered sites:
// Wix, React, Next.js, Squarespace, Webflow, Shopify, etc.
//
// Called internally by scan.js — not exposed to end users.
// Returns: { title, h1, meta_description, text_preview }
// On any error: returns null so scan.js falls back to raw HTML.

'use strict';

const chromium = require('@sparticuz/chromium');
const { chromium: playwright } = require('playwright-core');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing url' });
  }

  // Basic URL validation — must be http/https
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Invalid URL protocol' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let browser = null;
  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (compatible; ForgeBot/1.0; +https://forgeai-wgs.com/bot)',
      // Block images, fonts, media — only need DOM content
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });

    // Block heavy resources we don't need for DOM content extraction.
    // Keep stylesheets — JS frameworks use CSS to show/hide elements
    // and getComputedStyle in page.evaluate depends on them being loaded.
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = await context.newPage();

    // Navigate and wait for the DOM to settle after JS executes
    await page.goto(parsedUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: 20000
    });

    // Give JS frameworks time to render their content into the DOM
    await page.waitForTimeout(2000);

    // Extract content directly from the rendered DOM
    const extracted = await page.evaluate(() => {
      // Title — from document.title (reflects JS updates)
      const title = document.title ? document.title.trim() : null;

      // Meta description — from the rendered <head>
      const metaEl = document.querySelector('meta[name="description"]');
      const metaDescription = metaEl ? (metaEl.getAttribute('content') || '').trim() : null;

      // H1 — first H1 in the rendered DOM (Wix injects this via JS)
      const h1El = document.querySelector('h1');
      const h1 = h1El ? h1El.innerText.replace(/\s+/g, ' ').trim() : null;

      // Visible text preview — walk the body, skip nav/header/footer noise
      let textPreview = '';
      try {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT;
              const tag = parent.tagName.toLowerCase();
              // Skip script, style, noscript, hidden elements
              if (['script', 'style', 'noscript'].includes(tag)) return NodeFilter.FILTER_REJECT;
              const style = window.getComputedStyle(parent);
              if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );
        const parts = [];
        let node;
        while ((node = walker.nextNode()) && textPreview.length < 500) {
          const text = node.nodeValue.replace(/\s+/g, ' ').trim();
          if (text.length > 2) parts.push(text);
          textPreview = parts.join(' ');
        }
        textPreview = textPreview.substring(0, 400).trim();
      } catch (e) {
        textPreview = '';
      }

      return { title, meta_description: metaDescription || null, h1, text_preview: textPreview };
    });

    await browser.close();
    browser = null;

    console.log('render-fetch: extracted content from', parsedUrl.hostname, '— h1:', extracted.h1 ? extracted.h1.substring(0, 60) : 'none');

    return res.status(200).json({ success: true, ...extracted });

  } catch (err) {
    console.error('render-fetch error for', url, ':', err.message);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    // Return null-equivalent so scan.js falls back to raw HTML gracefully
    return res.status(200).json({ success: false, error: err.message, title: null, h1: null, meta_description: null, text_preview: null });
  }
};
