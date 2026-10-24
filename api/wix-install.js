// ── WIX INSTALL WEBHOOK ────────────────────────────────────
// Receives the App Instance Installed webhook from Wix.
//
// CRITICAL: Responds 200 to Wix IMMEDIATELY after reading + verifying
// the body, then processes everything in the background. This prevents
// Wix from spinning/timing out while waiting for a response.
//
// Flow:
//   1. Read raw body + verify RS256 JWT signature
//   2. Respond 200 to Wix immediately
//   3. (background) Retry up to 10s for wix-redirect.js to stamp instanceId
//   4. (background) Save site to user_sites, scheduled_sites, platform_credentials
//   5. (background) Mark install token as used → poll detects success
//   6. (background) Trigger initial scan
//
// User matching:
//   - wix-redirect.js receives the browser redirect from Wix after install
//   - It writes instanceId onto the wix_install_tokens row
//   - This webhook matches on that instanceId
//   - Wrong-user assignment is impossible (instanceId is unique per install)
//
// Security:
//   - Always responds 200 — Wix retries on non-200
//   - Wix signs webhooks with RS256 (RSA + SHA256) using their private key
//   - We verify with the public key from Wix Dev Center → View ID & keys
//   - Install tokens expire in 30 minutes
//   - Service key used for all DB operations

'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Verify and decode Wix webhook JWT (RS256) ─────────────────
function verifyWixWebhook(rawBody, publicKey) {
  const token = rawBody.trim().replace(/^"|"$/g, '');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Not a valid JWT');

  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') {
    throw new Error('Unexpected JWT algorithm: ' + header.alg);
  }

  const signingInput = headerB64 + '.' + payloadB64;
  const signature = Buffer.from(sigB64, 'base64url');

  const verified = crypto.verify(
    'sha256',
    Buffer.from(signingInput),
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    signature
  );

  if (!verified) throw new Error('Invalid webhook signature');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  return payload;
}

// ── Background processing after 200 is sent to Wix ────────────
async function processInstall(instanceId, appId, wixUserId) {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Retry up to 10 times (1s apart) waiting for wix-redirect.js to stamp instanceId.
  // In practice wix-redirect fires before this webhook, so it usually hits on attempt 1.
  let installToken = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
    const { data } = await sb.from('wix_install_tokens')
      .select('id, forge_user_id, site_url')
      .eq('used', false)
      .eq('instance_id', instanceId)
      .maybeSingle();
    if (data) { installToken = data; break; }
    console.log('Wix install: waiting for wix-redirect to stamp instanceId, attempt', attempt + 1);
  }

  if (!installToken) {
    console.warn('Wix install: no token found for instanceId after 10s — storing as pending');
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
  console.log('Wix install: token matched — forgeUserId:', forgeUserId, 'siteUrl:', siteUrl);

  // ── SAVE SITE ───────────────────────────────────────────
  const cleanUrl = (siteUrl || '').replace(/\/$/, '');
  const siteId = 'wix_' + Buffer.from(cleanUrl || instanceId).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');
  const siteName = cleanUrl ? cleanUrl.replace(/^https?:\/\//, '') : 'Wix Site';

  if (cleanUrl) {
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

    console.log('Wix install: site saved:', cleanUrl, 'for user:', forgeUserId);

    // Trigger initial scan (non-blocking)
    try {
      fetch('https://forgeai-wgs.com/api/scheduled-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
        body: JSON.stringify({ singleSite: { url: cleanUrl, user_id: forgeUserId } })
      });
    } catch(e) { console.log('Scan trigger (non-fatal):', e.message); }

  } else {
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

  // ── MARK TOKEN AS USED — poll detects this ──────────────
  await sb.from('wix_install_tokens').update({ used: true }).eq('id', installToken.id);
  console.log('Wix install: complete for user:', forgeUserId);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ received: true });
  }

  // ── READ RAW BODY ────────────────────────────────────────
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

  // ── VERIFY JWT ───────────────────────────────────────────
  const publicKey = process.env.WIX_PUBLIC_KEY;
  let instanceId = null;
  let appId = null;
  let wixUserId = null;

  try {
    if (!publicKey) throw new Error('WIX_PUBLIC_KEY not set');

    const payload = verifyWixWebhook(rawBody, publicKey);

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
    return res.status(200).json({ received: true });
  }

  if (!instanceId) {
    console.error('Wix webhook: no instanceId found');
    return res.status(200).json({ received: true });
  }

  // ── RESPOND 200 IMMEDIATELY, THEN PROCESS IN BACKGROUND ────
  // Wix requires a response within 30s or it shows "There was an issue
  // adding this app". processInstall() can take up to 10s+ (retry loop +
  // DB writes + scan trigger), so we must respond first and process after.
  res.status(200).json({ received: true });

  try {
    await processInstall(instanceId, appId, wixUserId);
  } catch(err) {
    console.error('Wix install processing error:', err.message);
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
