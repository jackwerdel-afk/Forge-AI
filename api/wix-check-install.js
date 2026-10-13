// ── WIX CHECK INSTALL ──────────────────────────────────────
// Polls to check if a Wix app installation has been completed
// and linked to the agency's Forge AI account.
// Called every 3 seconds from forge-ai-wix.html after the
// agency opens the Wix install link.

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  console.log('wix-check-install: method=%s content-type=%s', req.method, req.headers['content-type']);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Accept both POST (normal poll) and GET (fallback for environments that strip body)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Verify session — accept from Authorization header or query param (GET fallback)
    let token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '').trim() : null;
    if (!token && req.query && req.query.token) token = req.query.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data: authData, error: authErr } = await sb.auth.getUser(token);
    const user = authData && authData.user;
    if (authErr || !user) {
      console.log('wix-check-install: auth failed:', authErr && authErr.message);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get the poll start time — from body (POST) or query string (GET)
    let body = {};
    if (req.method === 'POST') {
      body = req.body || {};
      // If body is a string (raw), try to parse it
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) { body = {}; }
      }
    }
    const pollStartedAt = body.pollStartedAt || (req.query && req.query.pollStartedAt) || null;
    console.log('wix-check-install: user=%s pollStartedAt=%s', user.id.substring(0,8), pollStartedAt);

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

    // FALLBACK: Check if install token was marked used.
    // NOTE: We do NOT filter by pollStartedAt here — the token was created BEFORE
    // polling started (user clicked Add Site, token was created, THEN polling began),
    // so created_at will always be slightly before pollStartedAt and would be excluded.
    // Security: we already verified the session above, and we filter by forge_user_id,
    // so there's no risk of surfacing another user's data.
    const { data: installToken } = await sb.from('wix_install_tokens')
      .select('used, site_url, updated_at')
      .eq('forge_user_id', user.id)
      .eq('used', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!installToken) {
      return res.status(200).json({ completed: false });
    }

    console.log('wix-check-install: token marked used for user:', user.id.substring(0,8));
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

// Explicitly enable Vercel's body parser for JSON (default, but being explicit avoids
// edge cases where Vercel returns 400 before the handler runs on malformed Content-Type)
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb'
    }
  }
};
