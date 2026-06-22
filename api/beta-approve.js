const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Admin auth check
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, action } = req.body; // action: 'approve' or 'reject'
  if (!id || !action) return res.status(400).json({ error: 'Missing id or action' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const RESEND_KEY = process.env.RESEND_API_KEY;

  try {
    const { data: applicant, error: fetchErr } = await sb
      .from('beta_waitlist')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !applicant) return res.status(404).json({ error: 'Applicant not found' });
    if (applicant.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

    if (action === 'approve') {
      // Check spot limit
      const { count } = await sb
        .from('beta_waitlist')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'approved');

      if (count >= 10) return res.status(400).json({ error: 'Beta is full — 10 spots already taken' });

      // Generate unique invite token
      const token = crypto.randomBytes(32).toString('hex');

      await sb.from('beta_waitlist').update({
        status: 'approved',
        invite_token: token,
        invite_sent_at: new Date().toISOString()
      }).eq('id', id);

      const inviteUrl = `https://forgeai-wgs.com/forge-ai-signup.html?beta=${token}`;

      // Send approval email
      const approveHtml = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070c;font-family:'Inter',Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:40px 20px">
  <div style="background:#0e0e18;border:1px solid rgba(255,136,63,0.2);border-radius:14px;overflow:hidden">
    <div style="background:#111117;padding:24px 32px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:20px;font-weight:800;color:#FF883F;letter-spacing:-0.02em">Forge AI</div>
      <div style="font-size:11px;color:#606070;margin-top:2px">by Werdel Global Systems</div>
    </div>
    <div style="padding:32px">
      <div style="display:inline-block;background:rgba(34,201,122,0.1);border:1px solid rgba(34,201,122,0.25);border-radius:100px;padding:5px 14px;font-size:11px;font-weight:700;color:#22c97a;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:20px">✓ Beta Access Approved</div>
      <h2 style="font-size:20px;font-weight:800;margin:0 0 12px;color:#f0f0f8;letter-spacing:-0.02em">You're in, ${applicant.name}.</h2>
      <p style="font-size:14px;color:#a0a0b0;line-height:1.7;margin:0 0 8px">Your application for <strong style="color:#f0f0f8">${applicant.agency_name}</strong> has been approved. Welcome to the Forge AI beta.</p>
      <p style="font-size:14px;color:#a0a0b0;line-height:1.7;margin:0 0 28px">As a beta member you get <strong style="color:#FF883F">50% off for your first 6 months</strong> — locked in permanently.</p>
      <div style="background:rgba(255,136,63,0.06);border:1px solid rgba(255,136,63,0.2);border-radius:10px;padding:20px;margin-bottom:28px">
        <div style="font-size:12px;font-weight:700;color:#FF883F;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px">Beta pricing</div>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div><div style="font-size:11px;color:#70708a;margin-bottom:3px">Starter</div><div style="font-size:15px;font-weight:800;color:#f0f0f8">$25<span style="font-size:11px;font-weight:400;color:#70708a">/mo</span></div></div>
          <div><div style="font-size:11px;color:#70708a;margin-bottom:3px">Agency</div><div style="font-size:15px;font-weight:800;color:#f0f0f8">$75<span style="font-size:11px;font-weight:400;color:#70708a">/mo</span></div></div>
          <div><div style="font-size:11px;color:#70708a;margin-bottom:3px">Enterprise</div><div style="font-size:15px;font-weight:800;color:#f0f0f8">$249<span style="font-size:11px;font-weight:400;color:#70708a">/mo</span></div></div>
        </div>
      </div>
      <a href="${inviteUrl}" style="display:block;background:#FF883F;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;margin-bottom:16px">Activate your beta account →</a>
      <p style="font-size:12px;color:#606070;text-align:center;line-height:1.6">This link is unique to you — don't share it. It expires in 7 days.</p>
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
          to: [applicant.email],
          subject: `✓ You're in — Forge AI beta access approved`,
          html: approveHtml
        })
      });

      return res.status(200).json({ success: true, action: 'approved', inviteUrl });

    } else if (action === 'reject') {
      await sb.from('beta_waitlist').update({ status: 'rejected' }).eq('id', id);

      // Send rejection email
      const rejectHtml = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070c;font-family:'Inter',Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:40px 20px">
  <div style="background:#0e0e18;border:1px solid rgba(255,255,255,0.07);border-radius:14px;overflow:hidden">
    <div style="background:#111117;padding:24px 32px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:20px;font-weight:800;color:#FF883F;letter-spacing:-0.02em">Forge AI</div>
      <div style="font-size:11px;color:#606070;margin-top:2px">by Werdel Global Systems</div>
    </div>
    <div style="padding:32px">
      <h2 style="font-size:18px;font-weight:700;margin:0 0 12px;color:#f0f0f8">Thanks for applying, ${applicant.name}</h2>
      <p style="font-size:14px;color:#a0a0b0;line-height:1.7;margin:0 0 20px">Thank you for your interest in the Forge AI beta. Unfortunately your application was not selected for this round.</p>
      <p style="font-size:14px;color:#a0a0b0;line-height:1.7;margin:0">We'll be opening more spots when we move to full launch. We'll keep your details and reach out if a spot opens up.</p>
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
          to: [applicant.email],
          subject: 'Your Forge AI beta application',
          html: rejectHtml
        })
      });

      return res.status(200).json({ success: true, action: 'rejected' });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    console.error('Beta approve error:', err);
    return res.status(500).json({ error: err.message });
  }
};
