const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email, role, agencyName } = req.body;

    // Validate inputs
    if (!email || !role) return res.status(400).json({ error: 'Email and role are required' });
    if (!['manager', 'developer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    // Verify the requester is authenticated and is an owner
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.replace('Bearer ', '');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

    // Check this person is not already a team member
    const { data: existing } = await sb
      .from('team_members')
      .select('id, status')
      .eq('agency_id', user.id)
      .eq('email', email.toLowerCase().trim())
      .maybeSingle();

    if (existing && existing.status !== 'removed') {
      return res.status(400).json({ error: 'This person is already on your team' });
    }

    // Generate unique invite token
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days

    // Save to team_members
    const { error: insertError } = await sb.from('team_members').upsert({
      agency_id: user.id,
      email: email.toLowerCase().trim(),
      role: role,
      status: 'pending',
      invite_token: inviteToken,
      invite_expires_at: expiresAt.toISOString(),
      created_at: new Date().toISOString()
    }, { onConflict: 'invite_token' });

    if (insertError) {
      console.error('Insert error:', insertError);
      return res.status(500).json({ error: 'Could not create invitation' });
    }

    // Send invite email via Resend
    const inviteUrl = `https://forgeai-wgs.com/forge-ai-accept-invite.html?token=${inviteToken}`;
    const ownerName = agencyName || user.email;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: [email.toLowerCase().trim()],
        subject: `You've been invited to join ${ownerName} on Forge AI`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:40px 20px;background:#0c0c0d;color:#f0f0f2">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:32px">
              <div style="width:32px;height:32px;background:#ff6b35;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff">F</div>
              <span style="font-size:1.1rem;font-weight:800">Forge AI</span>
            </div>
            <h1 style="font-size:1.5rem;font-weight:800;margin-bottom:12px;letter-spacing:-0.02em">You've been invited</h1>
            <p style="color:#9090a0;line-height:1.7;margin-bottom:24px">
              <strong style="color:#f0f0f2">${ownerName}</strong> has invited you to join their team on Forge AI as a <strong style="color:#ff6b35">${role.charAt(0).toUpperCase() + role.slice(1)}</strong>.
            </p>
            <p style="color:#9090a0;line-height:1.7;margin-bottom:32px">
              Forge AI is an advanced website intelligence platform that monitors client sites, detects issues, and fixes them automatically.
            </p>
            <a href="${inviteUrl}" style="display:inline-block;background:#ff6b35;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.95rem;margin-bottom:24px">Accept Invitation →</a>
            <p style="color:#6b6b78;font-size:0.78rem;line-height:1.6">
              This invitation expires in 5 days. If you did not expect this invitation you can safely ignore this email.
            </p>
            <hr style="border:none;border-top:1px solid rgba(255,255,255,0.08);margin:24px 0">
            <p style="color:#4a4a55;font-size:0.72rem">A product of Werdel Global Systems · forgeai-wgs.com</p>
          </div>
        `
      })
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) {
      console.error('Email error:', emailData);
      return res.status(500).json({ error: 'Could not send invitation email' });
    }

    console.log('Invitation sent to:', email, 'role:', role);
    return res.status(200).json({ success: true, message: 'Invitation sent successfully' });

  } catch(err) {
    console.error('Invite member error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
};
