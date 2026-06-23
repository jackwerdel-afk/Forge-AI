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
    // Check if a confirmed account exists for this email
    const { data: { users }, error } = await sb.auth.admin.listUsers();
    if (error) throw error;

    const user = users.find(u => u.email === email.toLowerCase().trim());
    const confirmed = user && user.email_confirmed_at ? true : false;

    return res.status(200).json({ confirmed });
  } catch(err) {
    return res.status(200).json({ confirmed: false });
  }
};
