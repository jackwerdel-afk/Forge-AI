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

    // Delete auth account FIRST — if this fails, data stays intact
    const { error: deleteErr } = await sb.auth.admin.deleteUser(userId);
    if (deleteErr) {
      console.error('Delete user error:', JSON.stringify(deleteErr));
      return res.status(500).json({ error: deleteErr.message || JSON.stringify(deleteErr) || 'Failed to delete account. Please contact support.' });
    }

    // Only delete data after auth account is confirmed deleted
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

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Delete account error:', err.message, JSON.stringify(err));
    return res.status(500).json({ error: err.message || JSON.stringify(err) || 'Unknown error' });
  }
};
