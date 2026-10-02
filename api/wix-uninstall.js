// ── WIX UNINSTALL WEBHOOK ──────────────────────────────────
// Receives the App Instance Deleted webhook from Wix when a
// user uninstalls the Forge AI app from their Wix site.
//
// Flow:
//   1. Verify HMAC-SHA256 signature (same as wix-install.js)
//   2. Extract instanceId from the verified payload
//   3. Find the site in platform_credentials by instanceId
//   4. Deactivate scheduled scanning for that site
//   5. Mark platform_credentials as uninstalled
//   6. Always return 200 (Wix retries on non-200)
//
// We do NOT delete user data — scan history, fixes, and site
// records are preserved. We just stop active scanning.

'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Verify and decode Wix webhook JWT ─────────────────────────
// Identical to wix-install.js — HMAC-SHA256 with app secret.
function verifyWixWebhook(rawBody, appSecret) {
  const token = rawBody.trim().replace(/^"|"$/g, '');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Not a valid JWT');

  const [headerB64, payloadB64, sigB64] = parts;

  const expectedSig = crypto
    .createHmac('sha256', appSecret)
    .update(headerB64 + '.' + payloadB64)
    .digest('base64url');

  if (expectedSig !== sigB64) throw new Error('Invalid webhook signature');

  const padded = payloadB64 + '=='.slice((payloadB64.length % 4) || 4);
  const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));

  return payload;
}

module.exports = async (req, res) => {
  // Always return 200 — Wix retries on anything else
  if (req.method !== 'POST') {
    return res.status(200).json({ received: true });
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const appSecret = process.env.WIX_APP_SECRET;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // ── VERIFY WEBHOOK SIGNATURE ──────────────────────────
    let instanceId = null;
    try {
      if (!appSecret) throw new Error('WIX_APP_SECRET not set');

      const payload = verifyWixWebhook(rawBody, appSecret);

      let innerData = payload.data || null;
      if (typeof innerData === 'string') { try { innerData = JSON.parse(innerData); } catch(e) {} }

      instanceId = (innerData && innerData.instanceId) || payload.instanceId || null;

      console.log('Wix uninstall webhook verified — instanceId:', instanceId);
    } catch(e) {
      console.error('Wix uninstall: verification failed —', e.message);
      return res.status(200).json({ received: true });
    }

    if (!instanceId) {
      console.error('Wix uninstall: no instanceId in payload');
      return res.status(200).json({ received: true });
    }

    // ── FIND SITE BY INSTANCE ID ──────────────────────────
    const { data: creds } = await sb.from('platform_credentials')
      .select('user_id, site_id')
      .eq('platform', 'wix')
      .filter('credentials->>instance_id', 'eq', instanceId)
      .maybeSingle();

    if (!creds) {
      console.log('Wix uninstall: no site found for instanceId', instanceId, '— nothing to do');
      return res.status(200).json({ received: true });
    }

    const { user_id, site_id } = creds;
    console.log('Wix uninstall: deactivating site', site_id, 'for user', user_id);

    // ── GET SITE URL FOR SCHEDULED_SITES LOOKUP ───────────
    const { data: site } = await sb.from('user_sites')
      .select('url')
      .eq('user_id', user_id)
      .eq('site_id', site_id)
      .maybeSingle();

    // ── DEACTIVATE SCHEDULED SCANNING ─────────────────────
    if (site?.url) {
      await sb.from('scheduled_sites')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('user_id', user_id)
        .eq('url', site.url);
    }

    // ── MARK CREDENTIALS AS UNINSTALLED ───────────────────
    // Keep the row but flag it — preserves the install history
    await sb.from('platform_credentials')
      .update({
        credentials: {
          instance_id: instanceId,
          installation_method: 'wix_app',
          uninstalled: true,
          uninstalled_at: new Date().toISOString()
        }
      })
      .eq('user_id', user_id)
      .eq('site_id', site_id);

    // ── UPDATE USER_SITES PLATFORM ─────────────────────────
    // Remove the wix platform tag so it doesn't show as active Wix site
    await sb.from('user_sites')
      .update({
        platform: null,
        auto_scan: false,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', user_id)
      .eq('site_id', site_id);

    console.log('Wix uninstall complete for instanceId', instanceId, '| user:', user_id);

  } catch(err) {
    console.error('wix-uninstall error:', err.message);
    // Still return 200 — never let Wix retry due to our internal errors
  }

  return res.status(200).json({ received: true });
};
