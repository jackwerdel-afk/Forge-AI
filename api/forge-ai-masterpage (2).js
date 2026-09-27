// ── FORGE AI — MASTERPAGE CODE ─────────────────────────────
// Paste this into your site's masterpage (masterPage.js) in Wix Studio.
// It runs on every page of your site automatically.
//
// HOW IT WORKS:
// 1. On every page load, calls Forge AI to check for approved SEO fixes
// 2. Checks for page-specific fixes first, falls back to homepage fixes
// 3. Applies them using wix-seo — rendered server-side by Wix
//
// WHAT IT APPLIES:
//   • Meta description  → wixSeo.setMetaTags()
//   • Page title        → wixSeo.setTitle()
//   • og:image          → wixSeo.setMetaTags() (og:image property)
//   • Structured data   → wixSeo.setStructuredData()
//   • H1 heading        → $w('Text') selector (best-effort)
//
// ONE-TIME SETUP:
// Studio → Dev Mode → masterPage.js → paste this code → Publish

import wixSeo from 'wix-seo';
import { fetch } from 'wix-fetch';
import wixLocation from 'wix-location';

$w.onReady(async function () {
    try {
        const siteUrl = wixLocation.baseUrl || '';
        if (!siteUrl) return;

        const cleanSiteUrl = siteUrl.replace(/\/$/, '');

        // Pass current page URL for page-specific fix matching
        const pageUrl = wixLocation.url || '';
        const cleanPageUrl = pageUrl.split('?')[0].replace(/\/$/, '');

        const params = 'site=' + encodeURIComponent(cleanSiteUrl) +
                      (cleanPageUrl ? '&page=' + encodeURIComponent(cleanPageUrl) : '');

        const res = await fetch(
            'https://forgeai-wgs.com/api/wix-seo-read?' + params,
            { method: 'GET' }
        );

        if (!res.ok) return;
        const data = await res.json();
        if (!data) return;

        // ── Apply meta tags (description + og:image in one call) ─
        // Both are set together to avoid any risk of one call
        // overwriting the other across sequential setMetaTags calls.
        const metaTags = [];
        if (data.metaDescription) {
            metaTags.push({ name: 'description', content: data.metaDescription });
        }
        if (data.ogImage) {
            metaTags.push({ property: 'og:image',        content: data.ogImage });
            metaTags.push({ property: 'og:image:width',  content: '1200'       });
            metaTags.push({ property: 'og:image:height', content: '630'        });
        }
        if (metaTags.length > 0) {
            wixSeo.setMetaTags(metaTags);
        }

        // ── Apply page title ───────────────────────────────────
        if (data.title) {
            wixSeo.setTitle(data.title);
        }

        // ── Apply structured data ──────────────────────────────
        // data.structuredData is already a parsed JS object — no JSON.parse needed.
        // wixSeo.setStructuredData expects an array of schema objects.
        if (data.structuredData && typeof data.structuredData === 'object') {
            const schemaArr = Array.isArray(data.structuredData)
                ? data.structuredData
                : [data.structuredData];
            wixSeo.setStructuredData(schemaArr);
        }

        // ── Apply H1 heading (best-effort) ─────────────────────
        // Finds Text elements whose textType is 'heading1' and updates them.
        // Skips silently if no heading1 element exists — never breaks the page.
        if (data.h1Text) {
            try {
                const textEls = $w('Text');
                let updated = false;

                // Primary: match by textType === 'heading1'
                for (let i = 0; i < textEls.length; i++) {
                    try {
                        if (textEls[i].textType === 'heading1') {
                            textEls[i].html = '<h1>' + escapeHtml(data.h1Text) + '</h1>';
                            updated = true;
                            break;
                        }
                    } catch (elErr) {}
                }

                // Fallback: match by existing <h1> tag in element HTML
                if (!updated) {
                    for (let i = 0; i < textEls.length; i++) {
                        try {
                            if (/<h1[\s>]/i.test(textEls[i].html || '')) {
                                textEls[i].html = '<h1>' + escapeHtml(data.h1Text) + '</h1>';
                                break;
                            }
                        } catch (elErr) {}
                    }
                }
            } catch (h1Err) {
                // H1 is best-effort — never surface errors to visitors
            }
        }

    } catch (e) {
        // Silent fail — never break the site
    }
});

// ── Helpers ────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}
