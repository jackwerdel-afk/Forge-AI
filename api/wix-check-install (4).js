// ── WIX CHECK INSTALL ──────────────────────────────────────
// Polls to check if a Wix app installation has been completed
// and linked to the agency's Forge AI account.
// Called every 3 seconds from forge-ai-wix.html after the
// agency opens the Wix install link.

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Verify session
    const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Get the poll start time from request body
    const body = req.body || {};
    const pollStartedAt = body.pollStartedAt || null;

    // PRIMARY CHECK: Look for a Wix site added to user_sites AFTER polling started
    // This is the true completion signal — the site exists in the DB
    let siteQuery = sb.from('user_sites')
      .select('site_id, url, platform, updated_at')
      .eq('user_id', user.id)
      .eq('platform', 'wix')
      .order('updated_at', { ascending: false })
      .limit(1);

    if (pollStartedAt) {
      siteQuery = siteQuery.gte('updated_at', pollStartedAt);
    }

    const { data: site } = await siteQuery.maybeSingle();

    if (site) {
      // Site exists — install complete
      console.log('wix-check-install: site found:', site.url);
      return res.status(200).json({
        completed: true,
        siteUrl: site.url,
        siteId: site.site_id
      });
    }

    // FALLBACK: Check if install token was marked used after polling started
    let tokenQuery = sb.from('wix_install_tokens')
      .select('used, site_url, created_at')
      .eq('forge_user_id', user.id)
      .eq('used', true)
      .order('created_at', { ascending: false })
      .limit(1);

    if (pollStartedAt) {
      tokenQuery = tokenQuery.gte('created_at', pollStartedAt);
    }

    const { data: installToken } = await tokenQuery.maybeSingle();

    if (!installToken) {
      return res.status(200).json({ completed: false });
    }

    return res.status(200).json({
      completed: true,
      siteUrl: installToken.site_url,
      siteId: null
    });

  } catch(err) {
    console.error('wix-check-install error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
