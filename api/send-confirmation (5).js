const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, passwordHash, agencyName, pinHash, isBeta, betaToken, termsAgreedAt } = req.body;
  if (!email || !passwordHash || !agencyName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const RESEND_KEY = process.env.RESEND_API_KEY;

  try {
    // Generate a secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Delete any existing pending signup for this email
    await sb.from('pending_signups').delete().eq('email', email.toLowerCase().trim());

    // Save to pending_signups
    const { error: insertErr } = await sb.from('pending_signups').insert({
      email: email.toLowerCase().trim(),
      password_plain: passwordHash,
      agency_name: agencyName,
      pin_hash: pinHash || null,
      is_beta: isBeta || false,
      beta_token: betaToken || null,
      terms_agreed_at: termsAgreedAt || new Date().toISOString(),
      token,
      expires_at: expiresAt
    });

    if (insertErr) throw insertErr;

    // Send confirmation email via Resend
    const confirmUrl = `https://forgeai-wgs.com/api/confirm-email?token=${token}`;

    const emailHtml = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070c;font-family:'Inter',Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:40px 20px">
  <div style="background:#0e0e18;border:1px solid rgba(255,136,63,0.2);border-radius:14px;overflow:hidden">
    <div style="background:#111117;padding:24px 32px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:20px;font-weight:800;color:#FF883F;letter-spacing:-0.02em">Forge AI</div>
      <div style="font-size:11px;color:#606070;margin-top:2px">by Werdel Global Systems</div>
    </div>
    <div style="padding:32px">
      <h2 style="font-size:20px;font-weight:800;margin:0 0 12px;color:#f0f0f8;letter-spacing:-0.02em">Confirm your email address</h2>
      <p style="font-size:14px;color:#a0a0b0;line-height:1.7;margin:0 0 28px">Thanks for signing up for Forge AI. Click the button below to confirm your email address and activate your account.</p>
      <a href="${confirmUrl}" style="display:block;background:#FF883F;color:#fff;text-align:center;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;margin-bottom:16px">Confirm Email Address →</a>
      <p style="font-size:12px;color:#606070;text-align:center;line-height:1.6">This link expires in 24 hours. If you didn't create a Forge AI account you can safely ignore this email.</p>
    </div>
    <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:#606070;text-align:center">
      Forge AI · Werdel Global Systems · support@forgeai-wgs.com
    </div>
  </div>
</div></body></html>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: [email.toLowerCase().trim()],
        subject: 'Confirm your Forge AI account',
        html: emailHtml
      })
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(emailData.message || 'Failed to send email');

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-confirmation error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
