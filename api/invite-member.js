const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

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
  const RESEND_KEY = process.env.RESEND_API_KEY;

  // Verify the requester is logged in
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { email, role, agency_name } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'Email and role are required' });
  if (!['manager', 'developer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) return res.status(400).json({ error: 'Invalid email address' });

  try {
    // Check the agency owner's plan and enforce team member limits
    const { data: sub } = await sb.from('subscriptions')
      .select('plan')
      .eq('email', user.email)
      .maybeSingle();

    const plan = (sub && sub.plan) ? sub.plan : 'free';

    // Team is only available on agency and enterprise plans
    if (plan === 'free' || plan === 'starter') {
      return res.status(403).json({ error: 'Team access requires the Agency plan or higher. Please upgrade to invite team members.' });
    }

    const TEAM_LIMITS = { agency: 3, enterprise: Infinity };
    const limit = TEAM_LIMITS[plan] || 0;

    if (limit !== Infinity) {
      const { count } = await sb.from('team_members')
        .select('id', { count: 'exact', head: true })
        .eq('agency_id', user.id)
        .in('status', ['pending', 'active']);

      if ((count || 0) >= limit) {
        return res.status(403).json({
          error: `Your ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan allows up to ${limit} team members. Upgrade to Enterprise for unlimited team members.`
        });
      }
    }

    // Block inviting the owner's own email
    if (email.toLowerCase().trim() === user.email.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot invite yourself as a team member.' });
    }

    // Block inviting any email that already has a Forge AI account
    const { data: { users: existingUsers } } = await sb.auth.admin.listUsers();
    const emailAlreadyRegistered = existingUsers && existingUsers.some(u => 
      u.email && u.email.toLowerCase() === email.toLowerCase().trim()
    );
    if (emailAlreadyRegistered) {
      return res.status(400).json({ error: 'This email already has a Forge AI account. Team members must use a new email address.' });
    }

    // Check if already invited with active or pending status
    const { data: existing } = await sb
      .from('team_members')
      .select('id, status')
      .eq('agency_id', user.id)
      .eq('email', email.toLowerCase().trim())
      .in('status', ['pending', 'active'])
      .single();

    if (existing) {
      const msg = existing.status === 'active'
        ? 'This person is already an active team member.'
        : 'This email already has a pending invitation.';
      return res.status(400).json({ error: msg });
    }

    // Generate invite token — expires in 5 days
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();

    // Save to team_members
    const { error: insertErr } = await sb.from('team_members').insert({
      agency_id: user.id,
      email: email.toLowerCase().trim(),
      role,
      status: 'pending',
      invite_token: inviteToken,
      invite_expires_at: expiresAt
    });

    if (insertErr) throw insertErr;

    // Send invite email
    const inviteUrl = `https://forgeai-wgs.com/forge-ai-accept-invite.html?token=${inviteToken}`;
    const agencyDisplay = agency_name || 'your agency';
    const roleDisplay = role.charAt(0).toUpperCase() + role.slice(1);

    const emailHtml = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070c;font-family:'Inter',Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:40px 20px">
  <div style="background:#0e0e18;border:1px solid rgba(255,136,63,0.2);border-radius:14px;overflow:hidden">
    <div style="background:#111117;padding:24px 32px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:20px;font-weight:800;color:#FF883F;letter-spacing:-0.02em">Forge AI</div>
      <div style="font-size:11px;color:#606070;margin-top:2px">by Werdel Global Systems</div>
    </div>
    <div style="padding:32px">
      <div style="display:inline-block;background:rgba(255,136,63,0.1);border:1px solid rgba(255,136,63,0.25);border-radius:100px;padding:5px 14px;font-size:11px;font-weight:700;color:#FF883F;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:20px">Team Invitation</div>
      <h2 style="font-size:20px;font-weight:800;margin:0 0 12px;color:#f0f0f8;letter-spacing:-0.02em">You've been invited to join Forge AI</h2>
      <p style="font-size:14px;color:#a0a0b0;line-height:1.7;margin:0 0 20px">You've been invited to join <strong style="color:#f0f0f8">${agencyDisplay}</strong> on Forge AI as a <strong style="color:#FF883F">${roleDisplay}</strong>.</p>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px 20px;margin-bottom:28px">
        <div style="font-size:12px;color:#70708a;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600">Your role: ${roleDisplay}</div>
        ${role === 'manager'
          ? '<div style="font-size:13px;color:#a0a0b0;line-height:1.6">You\'ll have access to all client sites, reports, and platform connections. You cannot manage billing or invite other team members.</div>'
          : '<div style="font-size:13px;color:#a0a0b0;line-height:1.6">You\'ll have access to the client sites assigned to you. You can scan sites, view reports, and fix issues.</div>'
        }
      </div>
      <a href="${inviteUrl}" style="display:block;background:#FF883F;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;margin-bottom:16px">Accept Invitation →</a>
      <p style="font-size:12px;color:#606070;text-align:center;line-height:1.6">This invitation expires in 5 days. If you didn't expect this email you can safely ignore it.</p>
    </div>
    <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:#606070;text-align:center">
      Forge AI · Werdel Global Systems · support@forgeai-wgs.com
    </div>
  </div>
</div></body></html>`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: [email.toLowerCase().trim()],
        subject: `You've been invited to join ${agencyDisplay} on Forge AI`,
        html: emailHtml
      })
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Invite error:', err);
    return res.status(500).json({ error: err.message });
  }
};
