const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    const { memberId, memberUserId, agencyId } = req.body;
    if (!memberId || !agencyId) return res.status(400).json({ error: 'Missing required fields' });

    // Verify the requester is the agency owner
    const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { data: { user } } = await sb.auth.getUser(token);
    if (!user || user.id !== agencyId) return res.status(401).json({ error: 'Unauthorized' });

    // Delete from team_members
    await sb.from('team_members').delete().eq('id', memberId).eq('agency_id', agencyId);

    // Delete auth account if memberUserId provided
    if (memberUserId) {
      // Clean up all related data first
      await sb.from('site_assignments').delete().eq('user_id', memberUserId);
      await sb.from('realtime_alerts').delete().eq('user_id', memberUserId);
      // Delete auth account
      const { error: deleteErr } = await sb.auth.admin.deleteUser(memberUserId);
      if (deleteErr) console.log('Auth delete error (non-fatal):', deleteErr.message);
      else console.log('Team member auth account deleted:', memberUserId);
    }

    return res.status(200).json({ success: true });

  } catch(err) {
    console.error('Remove member error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
