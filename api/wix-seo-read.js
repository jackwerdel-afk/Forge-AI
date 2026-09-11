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
    // Find all Wix sites matching this URL across all users
    const cleanUrl = siteUrl.replace(/\/$/, '').toLowerCase();
    const { data: sites } = await sb.from('user_sites')
      .select('site_id')
      .ilike('url', cleanUrl + '%')
      .eq('platform', 'wix');

    if (!sites || sites.length === 0) {
      return res.status(200).json({ metaDescription: null, title: null });
    }

    const siteIds = sites.map(s => s.site_id);

    // Get the most recently deployed fix across all matching sites
    const { data: fixes } = await sb.from('agent_fixes')
      .select('result, tool, deployed_at')
      .in('site_id', siteIds)
      .eq('status', 'deployed')
      .eq('platform', 'wix')
      .order('deployed_at', { ascending: false })
      .limit(10);

    if (!fixes || fixes.length === 0) {
      return res.status(200).json({ metaDescription: null, title: null });
    }

    // Extract latest meta description and title from deployed fixes
    let metaDescription = null;
    let title = null;

    for (const fix of fixes) {
      const result = fix.result || {};
      if (!metaDescription && fix.tool === 'update_meta_description' && result.after) {
        metaDescription = result.after;
      }
      if (!title && fix.tool === 'update_seo_title' && result.after) {
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
