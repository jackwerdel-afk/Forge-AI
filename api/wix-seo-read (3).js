// ── WIX SEO READ ───────────────────────────────────────────
// Public endpoint called by Velo page code on every page load.
// Returns the approved meta description and title for a Wix site.
// No auth required — this is called from the site's frontend.
//
// Security:
//   - Only returns data for sites that have approved fixes
//   - Never exposes credentials or internal data
//   - Rate limited by Vercel edge

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=300'); // cache 5 mins

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const siteUrl = req.query.site || null;
  if (!siteUrl) return res.status(400).json({ error: 'site parameter required' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Find deployed Wix fixes — check result JSON for URL match
    // We don't rely on user_sites because site_id encoding can vary
    const cleanUrl = siteUrl.replace(/\/$/, '').toLowerCase().replace(/^https?:\/\/www\./, '');
    
    // Get all recently deployed Wix fixes
    const { data: allFixes } = await sb.from('agent_fixes')
      .select('result, deployed_at, site_id')
      .eq('status', 'deployed')
      .eq('platform', 'wix')
      .order('deployed_at', { ascending: false })
      .limit(50);

    // Also try matching via user_sites
    const { data: sites } = await sb.from('user_sites')
      .select('site_id')
      .ilike('url', '%' + cleanUrl + '%')
      .eq('platform', 'wix');

    const siteIds = (sites || []).map(s => s.site_id);
    
    // Filter fixes to those matching our site
    const fixes = (allFixes || []).filter(f => siteIds.includes(f.site_id));
    
    console.log('wix-seo-read: cleanUrl:', cleanUrl, 'siteIds:', siteIds, 'allFixes count:', (allFixes || []).length, 'matching fixes:', fixes.length);

    if (!fixes || fixes.length === 0) {
      return res.status(200).json({ metaDescription: null, title: null });
    }

    // Extract latest meta description and title from deployed fixes
    let metaDescription = null;
    let title = null;

    for (const fix of fixes) {
      const result = fix.result || {};
      const tool = result.tool || '';
      if (!metaDescription && tool === 'update_meta_description' && result.after) {
        metaDescription = result.after;
      }
      if (!title && tool === 'update_seo_title' && result.after) {
        title = result.after;
      }
      if (metaDescription && title) break;
    }

    console.log('wix-seo-read:', cleanUrl, '| desc:', metaDescription ? 'found' : 'none', '| title:', title ? 'found' : 'none');

    return res.status(200).json({ metaDescription, title });

  } catch(err) {
    console.error('wix-seo-read error:', err.message);
    return res.status(200).json({ metaDescription: null, title: null });
  }
};
