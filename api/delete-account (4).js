const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verify the session token
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userId = user.id;

    // Delete all data first (must happen before auth deletion due to foreign key constraints)
    await sb.from('tesseract_conversations').delete().eq('user_id', userId);
    await sb.from('user_sites').delete().eq('user_id', userId);
    await sb.from('scheduled_sites').delete().eq('user_id', userId);
    await sb.from('scan_results').delete().eq('user_id', userId);
    await sb.from('realtime_alerts').delete().eq('user_id', userId);
    await sb.from('maintenance_logs').delete().eq('user_id', userId);
    await sb.from('agency_tokens').delete().eq('user_id', userId);
    await sb.from('subscriptions').delete().eq('user_id', userId);
    await sb.from('team_members').delete().eq('agency_id', userId);
    await sb.from('team_members').delete().eq('user_id', userId);
    await sb.from('site_assignments').delete().eq('agency_id', userId);
    await sb.from('site_assignments').delete().eq('user_id', userId);
    await sb.from('team_tasks').delete().eq('agency_id', userId);
    await sb.from('agent_fixes').delete().eq('user_id', userId);

    // Now delete the auth account
    const deleteRes = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
          'apikey': process.env.SUPABASE_SERVICE_KEY
        }
      }
    );

    if (!deleteRes.ok) {
      const errBody = await deleteRes.text();
      console.error('Delete user error:', deleteRes.status, errBody);
      return res.status(500).json({ error: 'Failed to delete account: ' + errBody });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Delete account error:', err.message, JSON.stringify(err));
    return res.status(500).json({ error: err.message || JSON.stringify(err) || 'Unknown error' });
  }
};
