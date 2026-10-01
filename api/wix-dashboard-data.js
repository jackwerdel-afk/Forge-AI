// ── WIX DASHBOARD DATA ────────────────────────────────────────
// Called by the Wix dashboard iframe page (wix-dashboard.html).
// Verifies the Wix instance token (HMAC-SHA256), resolves the
// Forge AI user and site from platform_credentials, and returns
// the site's current SEO score, pending fix count, and plan.

'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Verify and decode Wix instance token ──────────────────────
// Format: <base64url-signature>.<base64url-json-payload>
// Signed with HMAC-SHA256 using the app secret.
function verifyAndDecodeInstance(encodedInstance, appSecret) {
  const dotIdx = encodedInstance.indexOf('.');
  if (dotIdx === -1) throw new Error('Malformed instance token');

  const signature = encodedInstance.substring(0, dotIdx);
  const data      = encodedInstance.substring(dotIdx + 1);

  const expectedSig = crypto
    .createHmac('sha256', appSecret)
    .update(data)
    .digest('base64url');

  if (signature !== expectedSig) throw new Error('Invalid instance signature');

  const json = Buffer.from(data, 'base64url').toString('utf-8');
  return JSON.parse(json);
  // Returns: { instanceId, signDate, uid, siteOwnerId, permissions, vendorProductId, ... }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { instance } = req.body || {};
  if (!instance) return res.status(400).json({ success: false, error: 'Missing instance token' });

  const appSecret = process.env.WIX_APP_SECRET;
  if (!appSecret) {
    console.error('wix-dashboard-data: WIX_APP_SECRET not set');
    return res.status(500).json({ success: false, error: 'Server configuration error' });
  }

  // ── Verify instance token ──────────────────────────────────
  let decoded;
  try {
    decoded = verifyAndDecodeInstance(instance, appSecret);
  } catch(e) {
    console.log('wix-dashboard-data: invalid instance token —', e.message);
    return res.status(401).json({ success: false, error: 'Invalid instance token' });
  }

  const instanceId = decoded.instanceId;
  if (!instanceId) {
    return res.status(400).json({ success: false, error: 'No instanceId in token' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // ── Find the site via platform_credentials ─────────────
    // instance_id is stored as credentials->>'instance_id' (JSON key)
    const { data: creds } = await sb.from('platform_credentials')
      .select('user_id, site_id')
      .eq('platform', 'wix')
      .filter('credentials->>instance_id', 'eq', instanceId)
      .maybeSingle();

    if (!creds) {
      console.log('wix-dashboard-data: no site found for instanceId', instanceId);
      return res.status(200).json({ success: false, noSite: true });
    }

    const { user_id, site_id } = creds;

    // ── Get site info ──────────────────────────────────────
    const { data: site } = await sb.from('user_sites')
      .select('url, name, last_scan_at')
      .eq('user_id', user_id)
      .eq('site_id', site_id)
      .maybeSingle();

    // ── Get latest scan score ──────────────────────────────
    // scan_results stores url + score (not site_id or overall_score)
    const { data: latestScan } = await sb.from('scan_results')
      .select('score, scanned_at')
      .eq('user_id', user_id)
      .eq('url', site?.url)
      .order('scanned_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // ── Get pending fixes (up to 4 for preview + total count) ─
    const { data: allPending } = await sb.from('agent_fixes')
      .select('id, issue_type, issue_description, points_impact')
      .eq('user_id', user_id)
      .eq('site_id', site_id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(20);

    // ── Get deployed fix count ─────────────────────────────
    const { count: deployedCount } = await sb.from('agent_fixes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .eq('site_id', site_id)
      .eq('status', 'deployed');

    // ── Get plan ──────────────────────────────────────────
    const { data: userAuth } = await sb.auth.admin.getUserById(user_id);
    const userEmail = userAuth?.user?.email || null;

    let plan = 'free';
    if (userEmail) {
      const { data: sub } = await sb.from('subscriptions')
        .select('plan')
        .eq('email', userEmail)
        .maybeSingle();
      if (sub?.plan) plan = sub.plan;
    }

    const pendingFixes = allPending || [];
    const score = latestScan?.score ?? null;
    const lastScan = latestScan?.scanned_at || site?.last_scan_at || null;

    console.log('wix-dashboard-data: served for instanceId', instanceId,
      '| score:', score, '| pending:', pendingFixes.length, '| plan:', plan);

    return res.status(200).json({
      success: true,
      score:         score,
      siteUrl:       site?.url || null,
      siteName:      site?.name || site?.url || null,
      lastScan:      lastScan,
      pendingCount:  pendingFixes.length,
      pendingFixes:  pendingFixes.slice(0, 4),
      deployedCount: deployedCount || 0,
      plan:          plan
    });

  } catch(err) {
    console.error('wix-dashboard-data error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
