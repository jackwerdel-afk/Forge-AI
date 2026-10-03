// ── WIX INSTALL WEBHOOK ────────────────────────────────────
// Receives the App Instance Installed webhook from Wix.
//
// Flow:
//   1. Parse instanceId and wixUserId from JWT payload
//   2. Get access token using App ID + App Secret + instanceId
//   3. Match install token by instanceId (stamped by wix-redirect.js)
//      Retries up to 5s to handle timing between webhook + browser redirect
//   4. Save site to user_sites, scheduled_sites, platform_credentials
//   5. Mark install token as used
//   6. Trigger initial scan
//
// User matching:
//   - wix-redirect.js receives the browser redirect from Wix after install
//   - It writes instanceId onto the wix_install_tokens row
//   - This webhook matches on that instanceId — no query params needed
//   - Wrong-user assignment is impossible (instanceId is unique per install)
//
// Security:
//   - Always responds 200 — Wix retries on non-200
//   - No time-based fallback (prevents wrong-user bug)
//   - Install tokens expire in 30 minutes
//   - Service key used for all DB operations

'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Verify and decode Wix webhook JWT ─────────────────────────
// Wix signs webhooks as a JWT using HMAC-SHA256 with the app secret.
// Format: <base64url-header>.<base64url-payload>.<base64url-signature>
function verifyWixWebhook(rawBody, appSecret) {
  // rawBody may be a JSON-stringified string (quoted) — strip outer quotes
  const token = rawBody.trim().replace(/^"|"$/g, '');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Not a valid JWT');

  const [headerB64, payloadB64, sigB64] = parts;

  // Verify signature: HMAC-SHA256 of "<header>.<payload>"
  const expectedSig = crypto
    .createHmac('sha256', appSecret)
    .update(headerB64 + '.' + payloadB64)
    .digest('base64url');

  if (expectedSig !== sigB64) throw new Error('Invalid webhook signature');

  // Decode payload
  const padded = payloadB64 + '=='.slice((payloadB64.length % 4) || 4);
  const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));

  return payload;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ received: true });
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ── READ RAW BODY (bodyParser disabled so we get original bytes) ──
    let rawBody;
    try {
      rawBody = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
    } catch(e) {
      rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    }
    if (!rawBody) rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // ── VERIFY + PARSE WEBHOOK JWT ────────────────────────
    const appSecret = process.env.WIX_APP_SECRET;

    let instanceId = null;
    let appId = null;
    let wixUserId = null;

    try {
      if (!appSecret) throw new Error('WIX_APP_SECRET not set');

      const payload = verifyWixWebhook(rawBody, appSecret);

      let innerData = payload.data || null;
      if (typeof innerData === 'string') { try { innerData = JSON.parse(innerData); } catch(e) {} }

      instanceId = (innerData && innerData.instanceId) || payload.instanceId || null;

      let innerInnerData = (innerData && innerData.data) || null;
      if (typeof innerInnerData === 'string') { try { innerInnerData = JSON.parse(innerInnerData); } catch(e) {} }
      appId = (innerInnerData && innerInnerData.appId) || null;

      let identity = (innerData && innerData.identity) || null;
      if (typeof identity === 'string') { try { identity = JSON.parse(identity); } catch(e) {} }
      wixUserId = (identity && identity.wixUserId) || null;

      console.log('Wix webhook verified — instanceId:', instanceId, 'wixUserId:', wixUserId);
    } catch(parseErr) {
      console.error('Wix webhook verification failed:', parseErr.message);
      return res.status(200).json({ received: true }); // always 200 to Wix
    }

    if (!instanceId) {
      console.error('Wix webhook: no instanceId found after verification');
      return res.status(200).json({ received: true });
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

    // ── FIND FORGE USER VIA INSTANCE ID ───────────────────
    // wix-redirect.js (browser redirect after install) stamps the
    // instanceId onto the wix_install_tokens row. We match on it here.
    //
    // Timing: the Wix server webhook and the browser redirect fire at
    // roughly the same time. We retry up to 5 times (5s total) to give
    // wix-redirect.js a chance to write the instanceId first.
    // If still not found after retries, store as pending.

    console.log('Wix webhook: looking up install token by instanceId:', instanceId.substring(0, 8));

    let installToken = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 1000)); // wait 1s between retries
      }
      const { data } = await sb.from('wix_install_tokens')
        .select('id, forge_user_id, site_url')
        .eq('used', false)
        .eq('instance_id', instanceId)
        .maybeSingle();
      if (data) { installToken = data; break; }
      console.log('Wix webhook: instanceId not yet on token row, attempt', attempt + 1);
    }

    if (!installToken) {
      console.warn('Wix webhook: no token row found for instanceId after retries — storing as pending');
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
      return res.status(200).json({ received: true });
    }

    const forgeUserId = installToken.forge_user_id;
    const siteUrl = installToken.site_url || null;
    console.log('Install token matched — forgeUserId:', forgeUserId, 'siteUrl:', siteUrl);

    // ── SAVE SITE ─────────────────────────────────────────
    const cleanUrl = (siteUrl || '').replace(/\/$/, '');
    const siteId = 'wix_' + Buffer.from(cleanUrl || instanceId).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');
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

      // Trigger initial scan (non-blocking)
      try {
        fetch('https://forgeai-wgs.com/api/scheduled-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
          body: JSON.stringify({ singleSite: { url: cleanUrl, user_id: forgeUserId } })
        });
      } catch(e) { console.log('Scan trigger (non-fatal):', e.message); }

    } else {
      // No URL — save pending for manual URL entry
      await sb.from('wix_pending_installs').upsert({
        instance_id: instanceId,
        app_id: appId,
        wix_user_id: wixUserId || null,
        site_url: null,
        installed_at: new Date().toISOString()
      }, { onConflict: 'instance_id' });

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
    console.log('Install complete for user:', forgeUserId);

  } catch(err) {
    console.error('wix-install processing error:', err.message);
  }

  return res.status(200).json({ received: true });
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
