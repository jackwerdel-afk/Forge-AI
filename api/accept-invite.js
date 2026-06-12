const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // GET - validate token
  if (req.method === 'GET') {
    const token = req.query && req.query.token;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const { data: invite, error } = await sb
      .from('team_members')
      .select('email, role, status, invite_expires_at, agency_id')
      .eq('invite_token', token)
      .maybeSingle();

    if (error || !invite) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.status === 'active') return res.status(400).json({ error: 'Invitation already accepted' });
    if (invite.status === 'removed') return res.status(400).json({ error: 'Invitation is no longer valid' });
    if (new Date(invite.invite_expires_at) < new Date()) return res.status(400).json({ error: 'Invitation has expired' });

    // Get agency name
    const { data: { user: agencyUser } } = await sb.auth.admin.getUserById(invite.agency_id);
    const agencyName = agencyUser?.user_metadata?.agency_name || agencyUser?.email || 'your agency';

    return res.status(200).json({
      valid: true,
      email: invite.email,
      role: invite.role,
      agencyName
    });
  }

  // POST - accept invite and create account
  if (req.method === 'POST') {
    const { token, name, password } = req.body;
    if (!token || !name || !password) return res.status(400).json({ error: 'Token, name and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Validate token
    const { data: invite, error: inviteError } = await sb
      .from('team_members')
      .select('*')
      .eq('invite_token', token)
      .maybeSingle();

    if (inviteError || !invite) return res.status(404).json({ error: 'Invitation not found' });
    if (invite.status === 'active') return res.status(400).json({ error: 'Invitation already accepted' });
    if (invite.status === 'removed') return res.status(400).json({ error: 'Invitation is no longer valid' });
    if (new Date(invite.invite_expires_at) < new Date()) return res.status(400).json({ error: 'Invitation has expired' });

    // Create user account
    const { data: newUser, error: signUpError } = await sb.auth.admin.createUser({
      email: invite.email,
      password: password,
      user_metadata: { 
        full_name: name,
        agency_id: invite.agency_id,
        role: invite.role
      },
      email_confirm: true
    });

    if (signUpError) {
      console.error('Create user error:', signUpError);
      if (signUpError.message.includes('already registered')) {
        return res.status(400).json({ error: 'An account with this email already exists. Please sign in instead.' });
      }
      return res.status(500).json({ error: 'Could not create account: ' + signUpError.message });
    }

    // Update team_members record
    const { error: updateError } = await sb
      .from('team_members')
      .update({
        user_id: newUser.user.id,
        name: name,
        status: 'active',
        invite_token: null,
        invite_expires_at: null
      })
      .eq('id', invite.id);

    if (updateError) {
      console.error('Update team member error:', updateError);
    }

    console.log('Team member accepted invite:', invite.email, 'role:', invite.role);
    return res.status(200).json({ success: true, message: 'Account created successfully' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
