// ── WIX SEO READ ───────────────────────────────────────────
// Public endpoint called by Velo masterpage code on every page load.
// Returns deployed SEO fixes for a Wix site: meta description, title,
// og:image URL, structured data object, and H1 text.
// No auth required — this is called from the site's frontend.
//
// Security:
//   - Only returns data for sites that have approved/deployed fixes
//   - Never exposes credentials or internal data
//   - Rate limited by Vercel edge
//   - All returned values are data, never instructions

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache for 5 minutes on regular calls; skip cache on verify checks
  if (req.query.verify !== '1') res.setHeader('Cache-Control', 'public, s-maxage=300');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const siteUrl = req.query.site || null;
  if (!siteUrl) return res.status(400).json({ error: 'site parameter required' });

  // Optional: current page URL for per-page fixes
  const pageUrl = req.query.page || null;

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const cleanSite = siteUrl.replace(/\/$/, '').toLowerCase().replace(/^https?:\/\/www\./, '');
    const cleanPage = pageUrl ? pageUrl.replace(/\/$/, '').toLowerCase().replace(/^https?:\/\/www\./, '') : null;
    const isHomepage = !cleanPage || cleanPage === cleanSite || cleanPage === cleanSite + '/';

    // Find site_ids for this domain
    const { data: sites } = await sb.from('user_sites')
      .select('site_id')
      .ilike('url', '%' + cleanSite + '%')
      .eq('platform', 'wix');

    const siteIds = (sites || []).map(s => s.site_id);

    if (!siteIds.length) {
      return res.status(200).json({ metaDescription: null, title: null, ogImage: null, structuredData: null, h1Text: null });
    }

    // Record ping — confirms Velo masterpage code is active on this site
    // Non-blocking, non-fatal — never delays the response
    sb.from('user_sites')
      .update({ last_velo_ping: new Date().toISOString() })
      .in('site_id', siteIds)
      .eq('platform', 'wix')
      .then(() => {})
      .catch(() => {});

    // If this is a verify check, return ping status immediately
    if (req.query.verify === '1') {
      return res.status(200).json({ verified: true, pinged: true });
    }

    // Get all deployed fixes for this site — all issue types
    const { data: allFixes } = await sb.from('agent_fixes')
      .select('result, issue_type, deployed_at, site_id, site_url, target_type')
      .in('site_id', siteIds)
      .eq('status', 'deployed')
      .eq('platform', 'wix')
      .order('deployed_at', { ascending: false })
      .limit(100);

    if (!allFixes || allFixes.length === 0) {
      return res.status(200).json({ metaDescription: null, title: null, ogImage: null, structuredData: null, h1Text: null });
    }

    // Separate page-specific and homepage fixes
    const pageFixes = cleanPage && !isHomepage
      ? allFixes.filter(f => {
          const fixUrl = (f.site_url || '').replace(/\/$/, '').toLowerCase().replace(/^https?:\/\/www\./, '');
          return fixUrl === cleanPage;
        })
      : [];

    const homepageFixes = allFixes.filter(f => {
      const fixUrl = (f.site_url || '').replace(/\/$/, '').toLowerCase().replace(/^https?:\/\/www\./, '');
      return fixUrl === cleanSite || fixUrl === '' || !fixUrl || f.target_type === 'homepage';
    });

    // Use page-specific fixes first, fall back to homepage fixes
    const fixes = pageFixes.length > 0 ? pageFixes : homepageFixes;

    let metaDescription = null;
    let title = null;
    let ogImage = null;        // String URL — e.g. "https://static.wixstatic.com/media/..."
    let structuredData = null; // Plain JS object — Velo receives it already parsed
    let h1Text = null;         // Plain text string — Velo wraps in <h1>

    for (const fix of fixes) {
      const result = fix.result || {};
      const tool = result.tool || '';

      if (!metaDescription && tool === 'update_meta_description' && result.after) {
        metaDescription = result.after;
      }
      if (!title && tool === 'update_seo_title' && result.after) {
        title = result.after;
      }
      if (!ogImage && tool === 'update_og_image' && result.after) {
        // result.after is the clean image URL stored by wix-actions
        ogImage = result.after;
      }
      if (!structuredData && tool === 'update_structured_data' && result.after) {
        // result.after is already a parsed JS object stored by wix-actions
        // Return it directly — Velo receives it as a parsed object via JSON response
        structuredData = result.after;
      }
      if (!h1Text && tool === 'update_h1' && result.after) {
        // result.after is plain text (no HTML tags) — Velo wraps it
        h1Text = result.after;
      }

      // Stop early if all fields are found
      if (metaDescription && title && ogImage && structuredData && h1Text) break;
    }

    console.log(
      'wix-seo-read:', cleanSite,
      '| page:', cleanPage || 'homepage',
      '| desc:', metaDescription ? 'found' : 'none',
      '| title:', title ? 'found' : 'none',
      '| ogImage:', ogImage ? 'found' : 'none',
      '| structuredData:', structuredData ? 'found' : 'none',
      '| h1Text:', h1Text ? 'found' : 'none'
    );

    return res.status(200).json({ metaDescription, title, ogImage, structuredData, h1Text });

  } catch(err) {
    console.error('wix-seo-read error:', err.message);
    // Always return a valid shape — never break the Velo page
    return res.status(200).json({ metaDescription: null, title: null, ogImage: null, structuredData: null, h1Text: null });
  }
};
