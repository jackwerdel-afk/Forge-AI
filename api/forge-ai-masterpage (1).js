// ── FORGE AI — MASTERPAGE CODE ─────────────────────────────
// Paste this into your site's masterpage (masterPage.js) in Wix Studio.
// It runs on every page of your site automatically.
//
// HOW IT WORKS:
// 1. On every page load, calls Forge AI to check for approved SEO fixes
// 2. Checks for page-specific fixes first, falls back to homepage fixes
// 3. Applies them using wix-seo — rendered server-side by Wix
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

        if (data && data.metaDescription) {
            wixSeo.setMetaTags([{
                'name': 'description',
                'content': data.metaDescription
            }]);
        }

        if (data && data.title) {
            wixSeo.setTitle(data.title);
        }

    } catch (e) {
        // Silent fail — never break the site
    }
});
