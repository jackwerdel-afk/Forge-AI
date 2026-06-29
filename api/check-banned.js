const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Missing email' });

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Check banned_accounts table
    const { data } = await sb.from('banned_accounts')
      .select('tier, reason')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (data) {
      return res.status(200).json({ banned: true, tier: data.tier });
    }

    return res.status(200).json({ banned: false });
  } catch(e) {
    console.error('Check banned error:', e.message);
    // On error, allow signup to proceed (fail open)
    return res.status(200).json({ banned: false });
  }
};
