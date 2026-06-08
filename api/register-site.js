const { createClient } = require('@supabase/supabase-js');

// Simple rate limit store
const rateLimitStore = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const window = 60000; // 1 minute
  const max = 10; // 10 requests per minute per IP
  const record = rateLimitStore.get(ip);
  if (!record || now > record.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + window });
    return true;
  }
  if (record.count >= max) return false;
  record.count++;
  return true;
}

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 
         req.headers['x-real-ip'] || 'unknown';
}

function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  url = url.trim().slice(0, 500);
  if (!url.startsWith('http')) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch(e) { return null; }
}

function sanitizeText(str) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, 200).replace(/[<>'"]/g, '');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ip = getIp(req);
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // Validate request size
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  // Sanitize inputs
  const token = typeof body.token === 'string' ? body.token.trim().slice(0, 200) : null;
  const url = sanitizeUrl(body.url);
  const name = sanitizeText(body.name);
  const platform = ['wordpress', 'wix', 'squarespace', 'webflow', 'dashboard'].includes(body.platform) 
    ? body.platform : 'wordpress';

  if (!token) return res.status(400).json({ error: 'Token is required' });
  if (!url) return res.status(400).json({ error: 'Valid URL is required' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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
    const siteId = 'wp_' + Buffer.from(url).toString('base64').slice(0, 16).replace(/[+/=]/g, '0');
    await sb.from('user_sites').upsert({
      user_id: userId,
      site_id: siteId,
      url: url,
      name: name || url,
      platform: platform,
      auto_scan: true,
      scan_count: 0,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,site_id' });

    console.log('Site registered:', url, 'platform:', platform, 'user:', userId);
    return res.status(200).json({ success: true, message: 'Site registered for monitoring' });

  } catch(err) {
    console.error('Register site error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
