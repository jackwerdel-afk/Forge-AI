// ── FORGE AI — MASTERPAGE CODE ─────────────────────────────
// Paste this into your site's masterpage (site.js) in Wix Studio.
// It runs on every page of your site automatically.
//
// HOW IT WORKS:
// 1. On every page load, calls Forge AI to check for approved SEO fixes
// 2. If a fix exists for this page, applies it using wix-seo
// 3. Wix renders it server-side — Google sees the updated meta tags
//
// ONE-TIME SETUP:
// Studio → Dev Mode → site.js → paste this code → Publish

import wixSeo from 'wix-seo';
import { fetch } from 'wix-fetch';
import wixLocation from 'wix-location';

$w.onReady(async function () {
    try {
        // Get the current site's base URL dynamically
        // Works on any site — no hardcoding needed
        const siteUrl = wixLocation.baseUrl || '';
        if (!siteUrl) return;

        // Strip trailing slash for consistent matching
        const cleanSiteUrl = siteUrl.replace(/\/$/, '');

        // Call Forge AI to get approved SEO fixes for this site
        const res = await fetch(
            'https://forgeai-wgs.com/api/wix-seo-read?site=' + encodeURIComponent(cleanSiteUrl),
            { method: 'GET' }
        );

        if (!res.ok) return;
        const data = await res.json();

        // Apply meta description if one has been approved and deployed
        if (data && data.metaDescription) {
            wixSeo.setMetaTags([{
                'name': 'description',
                'content': data.metaDescription
            }]);
        }

        // Apply SEO title if one has been approved and deployed
        if (data && data.title) {
            wixSeo.setTitle(data.title);
        }

    } catch (e) {
        // Silent fail — never break the site
    }
});
