const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  // Allow CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { token, url, name, platform } = req.body;

    if (!token || !url) {
      return res.status(400).json({ error: 'Token and URL are required' });
    }

    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Look up user by token
    const { data: tokenData, error: tokenError } = await sb
      .from('agency_tokens')
      .select('user_id')
      .eq('token', token)
      .maybeSingle();

    if (tokenError || !tokenData) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userId = tokenData.user_id;

    // Register site in scheduled_sites for daily scanning
    const { error: upsertError } = await sb
      .from('scheduled_sites')
      .upsert({
        user_id: userId,
        url: url,
        name: name || url,
        platform: platform || 'wordpress',
        active: true,
        created_at: new Date().toISOString()
      }, { onConflict: 'user_id,url' });

    if (upsertError) {
      console.error('Register site error:', upsertError);
      return res.status(500).json({ error: 'Could not register site' });
    }

    // Also add to user_sites so it shows on dashboard immediately
    const { error: userSiteError } = await sb
      .from('user_sites')
      .upsert({
        user_id: userId,
        site_id: 'wp_' + Buffer.from(url).toString('base64').slice(0, 16),
        url: url,
        name: name || url,
        platform: platform || 'wordpress',
        auto_scan: true,
        scan_count: 0,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id,site_id' });

    if (userSiteError) {
      console.log('user_sites upsert error:', userSiteError.message);
    }

    console.log('Site registered:', url, 'for user:', userId, 'platform:', platform);

    return res.status(200).json({ 
      success: true, 
      message: 'Site registered for monitoring',
      url: url,
      platform: platform
    });

  } catch(err) {
    console.error('Register site error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
