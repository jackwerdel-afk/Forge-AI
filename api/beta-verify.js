const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, markUsed } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { data, error } = await sb
      .from('beta_waitlist')
      .select('id, status, invite_used_at, email')
      .eq('invite_token', token)
      .single();

    if (error || !data) {
      return res.status(200).json({ valid: false, reason: 'Token not found' });
    }

    if (data.status !== 'approved') {
      return res.status(200).json({ valid: false, reason: 'Not approved' });
    }

    if (data.invite_used_at) {
      return res.status(200).json({ valid: false, reason: 'Token already used' });
    }

    // Mark as used if requested
    if (markUsed) {
      await sb.from('beta_waitlist')
        .update({ invite_used_at: new Date().toISOString() })
        .eq('invite_token', token);
    }

    return res.status(200).json({ valid: true, email: data.email });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
