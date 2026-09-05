// ── WIX INSTALL WEBHOOK ────────────────────────────────────
// Receives the App Instance Installed webhook from Wix.
//
// Flow:
//   1. Parse instanceId and wixUserId from JWT payload
//   2. Get access token using App ID + App Secret + instanceId
//   3. Get site URL using site-list API
//   4. Look up the most recent unused install token in DB
//      to identify which Forge AI user installed the app
//   5. Save site to user_sites, scheduled_sites, platform_credentials
//   6. Mark install token as used
//   7. Trigger initial scan
//
// Security:
//   - Responds 200 immediately — Wix retries on non-200
//   - All processing in setImmediate to prevent Vercel timeout
//   - Install tokens expire in 30 minutes
//   - Service key used for all DB operations

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ received: true });
  }

  // Process synchronously — Wix waits up to 10s for response
  // We respond at the end after all processing is complete
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── PARSE JWT ─────────────────────────────────────────
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    let instanceId = null;
    let appId = null;
    let wixUserId = null;

    try {
      const parts = rawBody.trim().replace(/^"|"$/g, '').split('.');
      if (parts.length === 3) {
        const payloadBase64 = parts[1];
        const padded = payloadBase64 + '=='.slice((payloadBase64.length % 4) || 4);
        const payloadJson = Buffer.from(padded, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);

        let innerData = payload.data || null;
        if (typeof innerData === 'string') { try { innerData = JSON.parse(innerData); } catch(e) {} }

        instanceId = (innerData && innerData.instanceId) || payload.instanceId || null;

        let innerInnerData = (innerData && innerData.data) || null;
        if (typeof innerInnerData === 'string') { try { innerInnerData = JSON.parse(innerInnerData); } catch(e) {} }
        appId = (innerInnerData && innerInnerData.appId) || null;

        let identity = (innerData && innerData.identity) || null;
        if (typeof identity === 'string') { try { identity = JSON.parse(identity); } catch(e) {} }
        wixUserId = (identity && identity.wixUserId) || null;

        console.log('Wix webhook — instanceId:', instanceId, 'wixUserId:', wixUserId);
      }
    } catch(parseErr) {
      console.error('Wix JWT parse error:', parseErr.message);
    }

    if (!instanceId) {
      console.error('Wix webhook: no instanceId found');
      return;
    }

    // ── GET ACCESS TOKEN ──────────────────────────────────
    let accessToken = null;
    try {
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
      if (tokenData.access_token) {
        accessToken = tokenData.access_token;
        console.log('Access token obtained for instance:', instanceId.substring(0, 8));
      } else {
        console.error('Token error:', JSON.stringify(tokenData).substring(0, 200));
      }
    } catch(tokenErr) {
      console.error('Token fetch error:', tokenErr.message);
    }

    // ── FIND FORGE USER ID AND SITE URL FROM INSTALL TOKEN ──
    // The agency entered their site URL before clicking install.
    // It was saved to wix_install_tokens along with forge_user_id.
    // We don't call any Wix URL API — the URL comes from the token.
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: installToken } = await sb.from('wix_install_tokens')
      .select('id, forge_user_id, site_url')
      .eq('used', false)
      .gte('created_at', thirtyMinsAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!installToken) {
      console.log('No install token found — storing as unlinked');
      try {
        await sb.from('wix_pending_installs').upsert({
          instance_id: instanceId,
          app_id: appId,
          wix_user_id: wixUserId || null,
          site_url: null,
          installed_at: new Date().toISOString()
        }, { onConflict: 'instance_id' });
      } catch(e) {
        console.log('wix_pending_installs upsert error (non-fatal):', e.message);
      }
      return;
    }

    const forgeUserId = installToken.forge_user_id;
    const siteUrl = installToken.site_url || null;
    console.log('Install token matched — forgeUserId:', forgeUserId, 'siteUrl:', siteUrl);

    // ── SAVE SITE ─────────────────────────────────────────
    const cleanUrl = (siteUrl || '').replace(/\/$/, '');
    // Include userId in siteId to ensure uniqueness across users
    const siteIdBase = forgeUserId.replace(/-/g, '').slice(0, 8) + '_' + (cleanUrl || instanceId);
    const siteId = 'wix_' + Buffer.from(siteIdBase).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');
    const siteName = cleanUrl ? cleanUrl.replace(/^https?:\/\//, '') : 'Wix Site';

    if (cleanUrl) {
      // Check if site already exists for this user by URL
      const { data: existing } = await sb.from('user_sites')
        .select('site_id')
        .eq('user_id', forgeUserId)
        .ilike('url', cleanUrl + '%')
        .maybeSingle();

      const finalSiteId = existing ? existing.site_id : siteId;

      await sb.from('user_sites').upsert({
        user_id: forgeUserId,
        site_id: finalSiteId,
        url: cleanUrl,
        name: siteName,
        platform: 'wix',
        auto_scan: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,url' });

      await sb.from('scheduled_sites').upsert({
        user_id: forgeUserId,
        url: cleanUrl,
        name: siteName,
        platform: 'wix',
        active: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,url' });

      // Save credentials
      await sb.from('platform_credentials').upsert({
        user_id: forgeUserId,
        site_id: finalSiteId,
        platform: 'wix',
        credentials: {
          instance_id: instanceId,
          wix_site_id: instanceId,
          installation_method: 'wix_app'
        }
      }, { onConflict: 'user_id,site_id' });

      console.log('Wix site saved:', cleanUrl, 'for user:', forgeUserId);

      // Trigger scan
      try {
        fetch('https://forgeai-wgs.com/api/scheduled-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
          body: JSON.stringify({ singleSite: { url: cleanUrl, user_id: forgeUserId } })
        });
      } catch(e) { console.log('Scan trigger (non-fatal):', e.message); }
    } else {
      // No URL — save pending install for manual URL entry
      await sb.from('wix_pending_installs').upsert({
        instance_id: instanceId,
        app_id: appId,
        wix_user_id: wixUserId || null,
        site_url: null,
        installed_at: new Date().toISOString()
      }, { onConflict: 'instance_id' });

      // Still save credentials so user can link manually
      await sb.from('platform_credentials').upsert({
        user_id: forgeUserId,
        site_id: 'wix_' + instanceId.replace(/-/g, '').slice(0, 16),
        platform: 'wix',
        credentials: {
          instance_id: instanceId,
          wix_site_id: instanceId,
          installation_method: 'wix_app',
          needs_url: true
        }
      }, { onConflict: 'user_id,site_id' });
    }

    // ── MARK TOKEN AS USED ────────────────────────────────
    await sb.from('wix_install_tokens').update({ used: true }).eq('id', installToken.id);
    console.log('Install token marked as used — install complete for user:', forgeUserId);

  } catch(err) {
    console.error('wix-install processing error:', err.message);
  }

  // Always respond 200 — Wix retries on non-200
  return res.status(200).json({ received: true });
};
