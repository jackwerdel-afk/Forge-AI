// api/send-confirmation.js
// Saves signup details to pending_signups table and sends confirmation email via Resend.
// No Supabase auth account is created until the user clicks the confirmation link.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, agencyName, passwordHash, pinHash, isBeta, betaToken, termsAgreedAt } = req.body;

  if (!email || !agencyName || !passwordHash || !pinHash) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    // Delete any existing pending signup for this email (so they can retry freely)
    await fetch(`${supabaseUrl}/rest/v1/pending_signups?email=eq.${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    // Generate a secure confirmation token
    const token = Buffer.from(
      JSON.stringify({ email, exp: Date.now() + 24 * 60 * 60 * 1000, rand: Math.random() })
    ).toString('base64url');

    // Save pending signup details
    const storeRes = await fetch(`${supabaseUrl}/rest/v1/pending_signups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        email,
        password_hash: passwordHash,
        agency_name: agencyName,
        pin_hash: pinHash,
        is_beta: isBeta || false,
        beta_token: betaToken || null,
        terms_agreed_at: termsAgreedAt || new Date().toISOString(),
        token,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    });

    if (!storeRes.ok) {
      const err = await storeRes.text();
      console.error('Failed to store pending signup:', err);
      return res.status(500).json({ error: 'Failed to store signup', detail: err });
    }

    const confirmUrl = `https://forgeai-wgs.com/forge-ai-confirm.html?token=${token}`;
    const displayName = agencyName || email.split('@')[0];

    // Send confirmation email via Resend API directly
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: [email],
        subject: 'Confirm your Forge AI account',
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Inter',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:12px;overflow:hidden;max-width:560px;width:100%;">
          
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #1a1a1a;text-align:center;">
              <img src="https://raw.githubusercontent.com/werdel-studios/forge-ai/main/Powered%20by%20Werdel%20Global%20Systems.png"
                   alt="Forge AI" height="52" style="display:block;margin:0 auto;" />
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 12px;">
                Confirm your email address
              </h1>
              <p style="color:#888;font-size:15px;line-height:1.6;margin:0 0 28px;">
                Hey ${displayName}, thanks for signing up for Forge AI. Click the button below to confirm your email and activate your account.
              </p>
              <p style="color:#666;font-size:13px;margin:0 0 28px;">
                This link expires in 24 hours. If you didn't sign up, ignore this email.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${confirmUrl}"
                       style="display:inline-block;background:#f97316;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:8px;letter-spacing:0.3px;">
                      Confirm Email &amp; Create Account
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Fallback link -->
              <p style="color:#555;font-size:12px;margin:28px 0 0;text-align:center;line-height:1.6;">
                Button not working? Copy and paste this link:<br>
                <a href="${confirmUrl}" style="color:#f97316;word-break:break-all;">${confirmUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #1a1a1a;text-align:center;">
              <p style="color:#333;font-size:11px;margin:0;">
                © 2025 Forge AI · Powered by Werdel Global Systems
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
        `,
      }),
    });

    const emailData = await emailRes.json();

    if (!emailRes.ok) {
      console.error('Resend error:', emailData);
      return res.status(500).json({ error: 'Failed to send confirmation email', detail: emailData });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('send-confirmation error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
