// ── WIX GENERATE TOKEN ─────────────────────────────────────
// Creates a short-lived install token tied to a Forge AI user.
// Called when agency clicks "Install Forge AI on Wix".
// The token is stored in DB and localStorage.
// wix-install.js looks up the most recent unused token to link
// the Wix installation to the correct Forge AI account.

'use strict';
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Verify session
    const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data: { user } } = await sb.auth.getUser(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    // Generate unique install token
    const installToken = crypto.randomUUID();

    // Save to DB — expires in 30 minutes
    const { error } = await sb.from('wix_install_tokens').insert({
      token: installToken,
      forge_user_id: user.id
    });

    if (error) {
      console.error('wix-generate-token error:', error.message);
      return res.status(500).json({ error: 'Could not generate install token' });
    }

    console.log('Wix install token generated for user:', user.id);
    return res.status(200).json({ success: true, token: installToken });

  } catch(err) {
    console.error('wix-generate-token error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
