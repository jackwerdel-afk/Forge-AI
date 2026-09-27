// ── Forge AI · Velo Master Page ────────────────────────────
// Installed in your Wix site at: Site > Dev Mode > masterPage.js
//
// On every page load this fetches deployed SEO fixes from Forge AI
// and applies them via the Wix SEO API:
//   • Meta description  → wixSeo.setMetaTags()
//   • Page title        → wixSeo.setTitle()
//   • og:image          → wixSeo.setMetaTags() (og:image property)
//   • Structured data   → wixSeo.setStructuredData()
//   • H1 heading        → $w('Text') selector (best-effort)
//
// This file is safe to overwrite when upgrading Forge AI.
// Do not edit the READ endpoint URL — it is locked to your agency account.

import wixSeo from 'wix-seo';
import { fetch } from 'wix-fetch';
import wixLocation from 'wix-location';

$w.onReady(async function () {
    try {
        // ── Build request URL ──────────────────────────────────
        const siteUrl = wixLocation.baseUrl || '';
        if (!siteUrl) return;

        const cleanSiteUrl = siteUrl.replace(/\/$/, '');
        const pageUrl = (wixLocation.url || '').split('?')[0].replace(/\/$/, '');

        const params = 'site=' + encodeURIComponent(cleanSiteUrl) +
                       (pageUrl ? '&page=' + encodeURIComponent(pageUrl) : '');

        // ── Fetch deployed fixes from Forge AI ─────────────────
        const res = await fetch(
            'https://forgeai-wgs.com/api/wix-seo-read?' + params,
            { method: 'GET' }
        );
        if (!res.ok) return;

        const data = await res.json();
        if (!data) return;

        // ── Apply meta description ─────────────────────────────
        if (data.metaDescription) {
            wixSeo.setMetaTags([{
                name: 'description',
                content: data.metaDescription
            }]);
        }

        // ── Apply page title ───────────────────────────────────
        if (data.title) {
            wixSeo.setTitle(data.title);
        }

        // ── Apply og:image ─────────────────────────────────────
        // Sets the social share image for Facebook, LinkedIn, Twitter,
        // iMessage, etc. wixSeo.setMetaTags accepts property-based tags.
        if (data.ogImage) {
            wixSeo.setMetaTags([
                { property: 'og:image',       content: data.ogImage },
                { property: 'og:image:width',  content: '1200'      },
                { property: 'og:image:height', content: '630'       }
            ]);
        }

        // ── Apply structured data ──────────────────────────────
        // data.structuredData is already a parsed JS object (stored that way
        // by Forge AI so Velo receives it ready to use — no JSON.parse needed).
        // wixSeo.setStructuredData expects an array of schema objects.
        if (data.structuredData && typeof data.structuredData === 'object') {
            const schemaArr = Array.isArray(data.structuredData)
                ? data.structuredData
                : [data.structuredData];
            wixSeo.setStructuredData(schemaArr);
        }

        // ── Apply H1 heading (best-effort) ─────────────────────
        // Finds Text elements whose textType is 'heading1' and replaces
        // their HTML with the Forge AI-generated H1 text.
        //
        // This is "best-effort": if no heading1 element exists on the page
        // the code skips silently — it never breaks the page.
        // Only the first heading1 element found is updated.
        if (data.h1Text) {
            try {
                // Filter Text elements by textType — the reliable Wix approach
                // for finding heading elements without depending on rendered HTML.
                const textEls = $w('Text');
                let updated = false;

                for (let i = 0; i < textEls.length; i++) {
                    const el = textEls[i];
                    try {
                        if (el.textType === 'heading1') {
                            // Wrap the plain text from Forge AI in an h1 tag.
                            // Use innerHTML-style assignment so Wix renders it
                            // as a proper heading element.
                            el.html = '<h1>' + escapeHtml(data.h1Text) + '</h1>';
                            updated = true;
                            break; // Only update the first H1 on the page
                        }
                    } catch (elErr) {
                        // Skip individual elements that throw (e.g. not accessible)
                    }
                }

                // Fallback: if no heading1 element found, try matching by
                // the existing html content containing an <h1> tag.
                // This handles themes where textType may not be set correctly.
                if (!updated) {
                    for (let i = 0; i < textEls.length; i++) {
                        const el = textEls[i];
                        try {
                            const currentHtml = el.html || '';
                            if (/<h1[\s>]/i.test(currentHtml)) {
                                el.html = '<h1>' + escapeHtml(data.h1Text) + '</h1>';
                                break;
                            }
                        } catch (elErr) {
                            // Skip
                        }
                    }
                }
            } catch (h1Err) {
                // H1 is best-effort — never let it surface as a page error
            }
        }

    } catch (e) {
        // Never surface Forge AI errors to visitors — swallow all exceptions
    }
});

// ── Helpers ────────────────────────────────────────────────

/**
 * Escapes special HTML characters in a plain-text string before
 * injecting it into an HTML attribute or tag body.
 * Prevents any embedded characters from being interpreted as markup.
 */
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&#39;');
}
