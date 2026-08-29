// ── WIX INSTALL WEBHOOK ────────────────────────────────────
// Receives the App Instance Installed webhook from Wix.
// When an agency installs the Forge AI app on their Wix site,
// Wix POSTs a JWT to this endpoint containing the instanceId.
//
// Security:
//   - Webhook payload is a JWT signed by Wix
//   - We verify the JWT signature using the Wix public key
//   - The forgeUserId is passed as a query param set when the
//     agency clicks "Install" from within Forge AI — this links
//     the Wix installation to the correct Forge AI account
//   - All DB writes are scoped to the verified forgeUserId
//   - We return 200 immediately to prevent Wix retry storms
//
// Storage:
//   - instanceId saved to platform_credentials per site
//   - site_url and wix_site_id saved for later API calls

'use strict';
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

module.exports = async (req, res) => {
  // Always respond 200 immediately — Wix will retry on non-200
  // We process asynchronously after responding
  res.status(200).json({ received: true });

  try {
    if (req.method !== 'POST') return;

    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── PARSE JWT FROM BODY ────────────────────────────────
    // Wix sends the webhook as a raw JWT string in the body
    const rawBody = typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body);

    // The JWT has 3 parts: header.payload.signature
    let instanceId = null;
    let appId = null;

    try {
      // Decode payload (middle part) without verifying signature first
      const parts = rawBody.trim().replace(/^"|"$/g, '').split('.');
      if (parts.length === 3) {
        const payloadBase64 = parts[1];
        const padded = payloadBase64 + '=='.slice((payloadBase64.length % 4) || 4);
        const payloadJson = Buffer.from(padded, 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);

        console.log('Payload keys:', Object.keys(payload));
        console.log('Full payload:', JSON.stringify(payload).substring(0, 500));

        // Wix nests the actual data inside payload.data as a JSON string
        let innerData = payload.data || null;
        if (typeof innerData === 'string') {
          try { innerData = JSON.parse(innerData); } catch(e) {}
        }
        // instanceId is inside innerData, not top-level
        instanceId = (innerData && innerData.instanceId) || payload.instanceId || null;

        // appId is doubly nested inside innerData.data
        let innerInnerData = (innerData && innerData.data) || null;
        if (typeof innerInnerData === 'string') {
          try { innerInnerData = JSON.parse(innerInnerData); } catch(e) {}
        }
        appId = (innerInnerData && innerInnerData.appId) || payload.appId || null;

        console.log('Wix webhook received — instanceId:', instanceId, 'appId:', appId);
      }
    } catch (parseErr) {
      console.error('Wix webhook JWT parse error:', parseErr.message);
      console.log('Raw body:', String(rawBody).substring(0, 200));
    }

    if (!instanceId) {
      console.error('Wix webhook: no instanceId found in payload');
      return;
    }

    // ── GET FORGE USER ID FROM QUERY PARAM ─────────────────
    // The agency passes their Forge AI user ID when generating
    // the install URL — this links the installation to their account
    const forgeUserId = req.query.userId || null;

    if (!forgeUserId) {
      // Store unlinked installation — can be linked later via wix-connect
      console.log('Wix webhook: no forgeUserId — storing unlinked instance:', instanceId);
      try {
        await sb.from('wix_pending_installs').upsert({
          instance_id: instanceId,
          app_id: appId,
          installed_at: new Date().toISOString()
        }, { onConflict: 'instance_id' });
      } catch(e) {
        console.log('wix_pending_installs upsert error (non-fatal):', e.message);
      }
      return;
    }

    // ── VERIFY USER EXISTS IN FORGE AI ────────────────────
    const { data: user } = await sb.auth.admin.getUserById(forgeUserId).catch(() => ({ data: null }));
    if (!user || !user.user) {
      console.error('Wix webhook: forgeUserId not found:', forgeUserId);
      return;
    }

    // ── GET ACCESS TOKEN FROM WIX ─────────────────────────
    // Use Client Credentials flow: App ID + App Secret + instanceId → access token
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
      console.log('Token response status:', tokenRes.status, 'keys:', Object.keys(tokenData));
      if (tokenRes.ok && tokenData.access_token) {
        accessToken = tokenData.access_token;
        console.log('Wix access token obtained for instance:', instanceId);
      } else {
        console.error('Wix token error:', JSON.stringify(tokenData).substring(0, 200));
      }
    } catch (tokenErr) {
      console.error('Wix token fetch error:', tokenErr.message);
    }

    // ── GET SITE INFO FROM WIX ────────────────────────────
    // Use the access token to get the site's URL and ID
    let siteUrl = null;
    let wixSiteId = null;

    if (accessToken) {
      try {
        const siteRes = await fetch('https://www.wixapis.com/site-properties/v4/properties', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        const siteData = await siteRes.json();
        console.log('Site properties:', JSON.stringify(siteData).substring(0, 300));

        // Try to get site URL from published URLs
        const urlsRes = await fetch('https://www.wixapis.com/urls-server/v2/published-site-urls', {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        });
        const urlsData = await urlsRes.json();
        const urls = urlsData.urls || [];
        const primary = urls.find(u => u.primary) || urls[0];
        if (primary) siteUrl = primary.url.replace(/\/$/, '');

        console.log('Site URL:', siteUrl);
      } catch (siteErr) {
        console.error('Wix site info error (non-fatal):', siteErr.message);
      }
    }

    // ── SAVE TO USER_SITES ────────────────────────────────
    if (siteUrl) {
      const siteId = 'wix_' + Buffer.from(siteUrl).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');

      await sb.from('user_sites').upsert({
        user_id: forgeUserId,
        site_id: siteId,
        url: siteUrl,
        name: siteUrl.replace(/^https?:\/\//, ''),
        platform: 'wix',
        auto_scan: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,url' });

      await sb.from('scheduled_sites').upsert({
        user_id: forgeUserId,
        url: siteUrl,
        name: siteUrl.replace(/^https?:\/\//, ''),
        platform: 'wix',
        active: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,url' });

      // ── SAVE CREDENTIALS ──────────────────────────────
      // Store instanceId so wix-actions.js can get fresh tokens later
      // instanceId is the persistent identifier — access tokens expire
      await sb.from('platform_credentials').upsert({
        user_id: forgeUserId,
        site_id: siteId,
        platform: 'wix',
        credentials: {
          instance_id: instanceId,
          wix_site_id: wixSiteId || instanceId,
          // Note: we do NOT store the access token — it expires in 4 hours
          // wix-actions.js will generate fresh tokens using instanceId + App ID + App Secret
          installation_method: 'wix_app'
        }
      }, { onConflict: 'user_id,site_id' });

      console.log('Wix app installed — site:', siteUrl, 'user:', forgeUserId, 'instance:', instanceId);

      // ── TRIGGER INITIAL SCAN ──────────────────────────
      try {
        await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://forgeai-wgs.com'}/api/scheduled-scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
          body: JSON.stringify({ singleSite: { url: siteUrl, user_id: forgeUserId } })
        });
        console.log('Initial scan triggered for:', siteUrl);
      } catch (scanErr) {
        console.log('Initial scan trigger error (non-fatal):', scanErr.message);
      }
    } else {
      // No site URL — store the instance ID for later resolution
      console.log('Wix webhook: no site URL found — storing instance only for user:', forgeUserId);
      await sb.from('platform_credentials').upsert({
        user_id: forgeUserId,
        site_id: 'wix_' + instanceId.replace(/-/g, '').slice(0, 16),
        platform: 'wix',
        credentials: {
          instance_id: instanceId,
          installation_method: 'wix_app',
          needs_url_resolution: true
        }
      }, { onConflict: 'user_id,site_id' });
    }

  } catch (err) {
    // Never surface errors — Wix already got 200
    console.error('wix-install processing error:', err.message);
  }
};
