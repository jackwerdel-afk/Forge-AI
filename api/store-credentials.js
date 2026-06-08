const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Rate limit store
const rateLimitStore = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const record = rateLimitStore.get(ip);
  if (!record || now > record.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (record.count >= 5) return false; // 5 requests per minute
  record.count++;
  return true;
}
function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Encrypt credentials before storing
function encrypt(text) {
  const key = crypto.scryptSync(process.env.CRON_SECRET || 'ForgeAI2026!', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = getIp(req);
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const { token, site_url, credentials, username } = req.body;

    if (!token || !site_url || !credentials) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate token
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: tokenData, error: tokenError } = await sb
      .from('agency_tokens')
      .select('user_id')
      .eq('token', token.trim())
      .maybeSingle();

    if (tokenError || !tokenData) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Validate site URL
    let cleanUrl;
    try {
      cleanUrl = new URL(site_url).toString();
    } catch(e) {
      return res.status(400).json({ error: 'Invalid site URL' });
    }

    // Encrypt credentials before storing
    const encryptedCredentials = encrypt(credentials);

    // Store encrypted credentials in scheduled_sites
    const { error: updateError } = await sb
      .from('scheduled_sites')
      .update({
        wp_credentials: encryptedCredentials,
        wp_username: username || '',
        auto_fix: true,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', tokenData.user_id)
      .eq('url', cleanUrl);

    if (updateError) {
      console.error('Store credentials error:', updateError.message);
      return res.status(500).json({ error: 'Could not store credentials' });
    }

    console.log('Credentials stored for:', cleanUrl);
    return res.status(200).json({ success: true, message: 'Auto-fix enabled' });

  } catch(err) {
    console.error('Store credentials error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
