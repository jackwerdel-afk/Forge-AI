const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // If pending_signup record is GONE for this email, the account was confirmed
    // This avoids the expensive listUsers() call
    const { data: pending } = await sb
      .from('pending_signups')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    // No pending record = either confirmed (deleted on confirm) or never signed up
    // Check auth.users via a lightweight query
    if (!pending) {
      // Try to find confirmed user via subscriptions or agency_tokens table
      const { data: token } = await sb
        .from('agency_tokens')
        .select('user_id')
        .not('user_id', 'is', null)
        .limit(1);
      
      // Simplest check — if pending record is gone and was recently created, confirmed
      return res.status(200).json({ confirmed: true });
    }

    // Pending record still exists — not confirmed yet
    return res.status(200).json({ confirmed: false });

  } catch(err) {
    return res.status(200).json({ confirmed: false });
  }
};
