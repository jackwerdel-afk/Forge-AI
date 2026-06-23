const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // GET — validate token and return invite details
  if (req.method === 'GET') {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    try {
      const { data, error } = await sb
        .from('team_members')
        .select('id, email, role, status, invite_expires_at, agency_id')
        .eq('invite_token', token)
        .single();

      if (error || !data) return res.status(404).json({ error: 'Invitation not found' });
      if (data.status === 'active') return res.status(400).json({ error: 'This invitation has already been accepted.' });
      if (data.status === 'removed') return res.status(400).json({ error: 'This invitation is no longer valid.' });
      if (new Date(data.invite_expires_at) < new Date()) {
        return res.status(400).json({ error: 'This invitation has expired. Please ask your agency owner to send a new one.' });
      }

      // Get agency name
      const { data: { user: agencyUser } } = await sb.auth.admin.getUserById(data.agency_id);
      const agencyName = agencyUser?.user_metadata?.agency_name || 'your agency';

      return res.status(200).json({
        valid: true,
        email: data.email,
        role: data.role,
        agency_name: agencyName,
        expires_at: data.invite_expires_at
      });

    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — accept the invite
  if (req.method === 'POST') {
    const { token, name, password } = req.body;
    if (!token || !name || !password) return res.status(400).json({ error: 'Token, name, and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    try {
      // Re-validate token
      const { data: invite, error: inviteErr } = await sb
        .from('team_members')
        .select('*')
        .eq('invite_token', token)
        .single();

      if (inviteErr || !invite) return res.status(404).json({ error: 'Invitation not found' });
      if (invite.status === 'active') return res.status(400).json({ error: 'This invitation has already been accepted.' });
      if (new Date(invite.invite_expires_at) < new Date()) return res.status(400).json({ error: 'This invitation has expired.' });

      // Get agency name
      const { data: { user: agencyUser } } = await sb.auth.admin.getUserById(invite.agency_id);
      const agencyName = agencyUser?.user_metadata?.agency_name || 'Agency';

      let userId;

      // Try to create new account
      const { data: newUser, error: createErr } = await sb.auth.admin.createUser({
        email: invite.email,
        password,
        email_confirm: true,
        user_metadata: {
          name: name.trim(),
          agency_name: agencyName,
          team_role: invite.role,
          agency_id: invite.agency_id,
          is_team_member: true
        }
      });

      if (createErr) {
        if (createErr.message && createErr.message.toLowerCase().includes('already')) {
          // Account exists — find them and update their metadata
          const { data: { users } } = await sb.auth.admin.listUsers();
          const existing = users ? users.find(u => u.email === invite.email) : null;
          if (!existing) return res.status(400).json({ error: 'Account conflict. Please contact support.' });

          userId = existing.id;
          await sb.auth.admin.updateUserById(userId, {
            user_metadata: {
              ...existing.user_metadata,
              team_role: invite.role,
              agency_id: invite.agency_id,
              is_team_member: true
            }
          });
        } else {
          throw createErr;
        }
      } else {
        userId = newUser.user.id;
      }

      // Mark invite as accepted
      await sb.from('team_members').update({
        user_id: userId,
        name: name.trim(),
        status: 'active',
        invite_token: null
      }).eq('id', invite.id);

      return res.status(200).json({ success: true, email: invite.email });

    } catch (err) {
      console.error('Accept invite error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
