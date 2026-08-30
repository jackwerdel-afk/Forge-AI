// ── WIX LINK ───────────────────────────────────────────────
// Links a pending Wix app installation to a Forge AI account.
//
// Called automatically when the agency returns to the Wix
// connections page after installing the Forge AI app.
//
// Flow:
//   1. Receive forgeUserId from authenticated request
//   2. Look up the most recent unlinked install in wix_pending_installs
//   3. Get an access token using App ID + App Secret + instanceId
//   4. Get the site URL from Wix published URLs API
//   5. Save site to user_sites + scheduled_sites
//   6. Save instanceId to platform_credentials
//   7. Trigger initial scan
//   8. Mark install as linked

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
    // ── AUTH ────────────────────────────────────────────────
    const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const forgeUserId = user.id;

    // ── FIND PENDING INSTALL ────────────────────────────────
    // Get most recent unlinked install — within last 30 minutes
    const thirtyMinsAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24 hours for testing
    const { data: pending } = await sb.from('wix_pending_installs')
      .select('*')
      .eq('linked', false)
      .gte('installed_at', thirtyMinsAgo)
      .order('installed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!pending) {
      return res.status(404).json({
        error: 'No pending Wix installation found. Please install the Forge AI app on your Wix site first, then return here within 30 minutes.'
      });
    }

    const instanceId = pending.instance_id;
    console.log('Linking Wix install — instanceId:', instanceId, 'forgeUserId:', forgeUserId);

    // ── GET ACCESS TOKEN FROM WIX ───────────────────────────
    const tokenRes = await fetch('https://www.wixapis.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: process.env.WIX_APP_ID,
        client_secret: process.env.WIX_APP_SECRET,
        instance_id: instanceId
      })
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Wix token error:', JSON.stringify(tokenData).substring(0, 200));
      return res.status(500).json({ error: 'Could not authenticate with Wix. Please try reinstalling the app.' });
    }

    const accessToken = tokenData.access_token;

    // ── GET SITE URL FROM WIX ───────────────────────────────
    const urlsRes = await fetch('https://www.wixapis.com/urls-server/v2/published-site-urls', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'wix-site-id': instanceId,
        'Content-Type': 'application/json'
      }
    });
    const urlsData = await urlsRes.json();
    console.log('URLs API status:', urlsRes.status, 'data:', JSON.stringify(urlsData).substring(0, 300));
    const urls = urlsData.urls || [];
    const primary = urls.find(u => u.primary) || urls[0];
    const siteUrl = primary ? primary.url.replace(/\/$/, '') : null;

    console.log('Site URL from Wix:', siteUrl);

    if (!siteUrl) {
      // Try site-properties as fallback
      try {
        const propsRes = await fetch('https://www.wixapis.com/site-properties/v4/properties', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'wix-site-id': instanceId,
            'Content-Type': 'application/json'
          }
        });
        const propsData = await propsRes.json();
        console.log('Site properties fallback:', JSON.stringify(propsData).substring(0, 300));
      } catch(e) {}
      return res.status(500).json({ error: 'Could not determine site URL from Wix. Make sure your site has a published domain.' });
    }

    // ── SAVE SITE TO USER_SITES ─────────────────────────────
    const siteId = 'wix_' + Buffer.from(siteUrl).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');
    const siteName = siteUrl.replace(/^https?:\/\//, '');

    const { error: upsertErr } = await sb.from('user_sites').upsert({
      user_id: forgeUserId,
      site_id: siteId,
      url: siteUrl,
      name: siteName,
      platform: 'wix',
      auto_scan: true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,url' });

    if (upsertErr) {
      console.error('user_sites upsert error:', upsertErr.message);
      return res.status(500).json({ error: 'Could not save site. Please try again.' });
    }

    await sb.from('scheduled_sites').upsert({
      user_id: forgeUserId,
      url: siteUrl,
      name: siteName,
      platform: 'wix',
      active: true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,url' });

    // ── SAVE CREDENTIALS ────────────────────────────────────
    await sb.from('platform_credentials').upsert({
      user_id: forgeUserId,
      site_id: siteId,
      platform: 'wix',
      credentials: {
        instance_id: instanceId,
        wix_site_id: instanceId,
        installation_method: 'wix_app'
      }
    }, { onConflict: 'user_id,site_id' });

    // ── MARK INSTALL AS LINKED ──────────────────────────────
    await sb.from('wix_pending_installs').update({
      linked: true
    }).eq('id', pending.id);

    console.log('Wix site linked successfully:', siteUrl, 'user:', forgeUserId);

    // ── TRIGGER INITIAL SCAN ────────────────────────────────
    try {
      fetch('https://forgeai-wgs.com/api/scheduled-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CRON_SECRET}`
        },
        body: JSON.stringify({ singleSite: { url: siteUrl, user_id: forgeUserId } })
      });
    } catch(scanErr) {
      console.log('Initial scan trigger (non-fatal):', scanErr.message);
    }

    return res.status(200).json({
      success: true,
      siteUrl,
      siteId,
      message: 'Wix site connected successfully'
    });

  } catch(err) {
    console.error('wix-link error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
