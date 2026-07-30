const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function encrypt(text) {
  const key = crypto.scryptSync(process.env.WP_ENCRYPTION_KEY || process.env.CRON_SECRET || 'ForgeAI2026!', 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { siteUrl, username, password } = req.body;
    if (!siteUrl || !username || !password) {
      return res.status(400).json({ error: 'Missing siteUrl, username, or password' });
    }

    // Encrypt credentials as "username:password" (same format as Basic auth base64)
    const credentials = Buffer.from(username + ':' + password).toString('base64');
    const encrypted = encrypt(credentials);

    // Save to user_sites
    const { error: usError } = await sb.from('user_sites')
      .update({ wp_username: username, wp_credentials: encrypted })
      .eq('user_id', user.id)
      .eq('url', siteUrl);

    // Also save to scheduled_sites if exists
    await sb.from('scheduled_sites')
      .update({ wp_username: username, wp_credentials: encrypted })
      .eq('user_id', user.id)
      .eq('url', siteUrl);

    if (usError) throw new Error(usError.message);

    return res.status(200).json({ success: true });
  } catch(e) {
    console.error('Save WP credentials error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
