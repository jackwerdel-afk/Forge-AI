const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

const { createClient } = require('@supabase/supabase-js');

// Simple rate limit store
// ── SUPABASE RATE LIMITING ─────────────────────────────────
// Uses Supabase instead of in-memory Map — works correctly
// across all serverless function instances and cold starts.
async function rateLimitDB(sb, key, maxRequests, windowMs) {
  try {
    const now = new Date();
    const resetAt = new Date(Date.now() + windowMs);

    // Try to get existing record
    const { data: existing } = await sb
      .from('rate_limits')
      .select('count, reset_at')
      .eq('key', key)
      .maybeSingle();

    if (!existing || new Date(existing.reset_at) < now) {
      // No record or expired — create/reset
      await sb.from('rate_limits').upsert({
        key,
        count: 1,
        reset_at: resetAt.toISOString()
      }, { onConflict: 'key' });
      return { allowed: true, remaining: maxRequests - 1 };
    }

    if (existing.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt: existing.reset_at };
    }

    // Increment count
    await sb.from('rate_limits')
      .update({ count: existing.count + 1 })
      .eq('key', key);

    return { allowed: true, remaining: maxRequests - existing.count - 1 };
  } catch(e) {
    // If rate limiting fails, allow the request rather than blocking legitimate users
    console.error('Rate limit DB error (allowing request):', e.message);
    return { allowed: true, remaining: -1 };
  }
}


module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Validate request size
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // Sanitize inputs
  const token = typeof body.token === 'string' ? body.token.trim().slice(0, 200) : null;
  const url = sanitizeUrl(body.url);
  const name = sanitizeText(body.name);
  const VALID_PLATFORMS = ['wordpress','wix','squarespace','webflow','ghost','framer','shopify','duda','bigcommerce','drupal','joomla','hubspot','bubble','weebly','dashboard','other'];
  const platform = VALID_PLATFORMS.includes(body.platform) ? body.platform : 'other';

  if (!token) return res.status(400).json({ error: 'Token is required' });
  if (!url) return res.status(400).json({ error: 'Valid URL is required' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Rate limiting — sb now available
    const ip = getIp(req);
    const rlResult = await rateLimitDB(sb, 'register:' + ip, 10, 60000);
    if (!rlResult.allowed) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    // Validate token — must exist in agency_tokens
    const { data: tokenData, error: tokenError } = await sb
      .from('agency_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle();

    if (tokenError || !tokenData) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userId = tokenData.user_id;

    // ── SERVER-SIDE SITE LIMIT ENFORCEMENT ─────────────────
    // Get user's plan and site limit
    const { data: subData } = await sb.from('subscriptions')
      .select('plan, sites_limit')
      .eq('user_id', userId)
      .maybeSingle();

    const plan = (subData && subData.plan) ? subData.plan : 'free';
    const planLimits = { free: 3, starter: 10, agency: 25, enterprise: 999999 };
    const siteLimit = (subData && subData.sites_limit) ? subData.sites_limit : (planLimits[plan] || 3);

    // Count existing sites
    const { count: siteCount } = await sb.from('user_sites')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (siteCount !== null && siteCount >= siteLimit) {
      return res.status(403).json({
        error: 'Site limit reached',
        message: `Your ${plan} plan allows up to ${siteLimit} sites. Please upgrade to add more.`,
        limit: siteLimit,
        current: siteCount
      });
    }

    // Register in scheduled_sites
    const { error: schedError } = await sb.from('scheduled_sites').upsert({
      user_id: userId,
      url: url,
      name: name || url,
      platform: platform,
      active: true,
      created_at: new Date().toISOString()
    }, { onConflict: 'user_id,url' });

    if (schedError) {
      console.error('scheduled_sites error:', schedError.message);
      return res.status(500).json({ error: 'Could not register site' });
    }

    // Also add to user_sites so it appears on dashboard
    const normalizedUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    const siteId = 'wp_' + Buffer.from(normalizedUrl).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');
    await sb.from('user_sites').upsert({
      user_id: userId,
      site_id: siteId,
      url: url,
      name: name || url,
      platform: platform,
      auto_scan: true,
      scan_count: 0
    }, { onConflict: 'user_id,url' });

    // Save platform credentials if provided (e.g. Ghost API key)
    const ghostApiKey = body.ghostApiKey || body.ghost_api_key || null;
    if (ghostApiKey && platform === 'ghost') {
      await sb.from('platform_credentials').upsert({
        user_id: userId,
        site_id: siteId,
        platform: 'ghost',
        credentials: { api_key: ghostApiKey }
      }, { onConflict: 'user_id,site_id' });
      console.log('Ghost API key saved for site:', siteId);
    }

    console.log('Site registered:', url, 'platform:', platform, 'user:', userId);

    // If the request comes from a team member, auto-assign the site to them
    if (body.requestingUserId && body.requestingUserId !== userId) {
      try {
        await sb.from('site_assignments').upsert({
          agency_id: userId,
          user_id: body.requestingUserId,
          site_id: siteId
        }, { onConflict: 'agency_id,user_id,site_id' });
        console.log('Auto-assigned site to team member:', body.requestingUserId);
      } catch(assignErr) {
        console.log('Auto-assign error (non-fatal):', assignErr.message);
      }
    }

    // Respond immediately so client can redirect to dashboard while scan runs
    res.status(200).json({ success: true, message: 'Site registered. Scan starting...' });

    // Trigger scan after response — Vercel keeps the function alive until complete
    try {
      const scanRes = await fetch('https://forgeai-wgs.com/api/scheduled-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '')
        },
        body: JSON.stringify({ singleSite: { url: url, user_id: userId, site_id: siteId } })
      });
      const scanData = await scanRes.json();
      console.log('Auto-scan result:', scanData.message || 'done');
    } catch(e) {
      console.log('Auto-scan error:', e.message);
    }

  } catch(err) {
    Sentry.captureException(err);
    console.error('Register site error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
