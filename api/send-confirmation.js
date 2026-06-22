// api/send-confirmation.js
// Sends a branded email confirmation via Resend, bypassing Supabase's broken SMTP

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, userId, name } = req.body;

  if (!email || !userId) {
    return res.status(400).json({ error: 'Missing email or userId' });
  }

  try {
    // Generate a secure confirmation token
    const token = Buffer.from(
      JSON.stringify({ userId, email, exp: Date.now() + 24 * 60 * 60 * 1000 })
    ).toString('base64url');

    // Store token in Supabase so we can verify it later
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const storeRes = await fetch(`${supabaseUrl}/rest/v1/email_confirmations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        email,
        token,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        confirmed: false,
      }),
    });

    if (!storeRes.ok) {
      const err = await storeRes.text();
      console.error('Failed to store token:', err);
      return res.status(500).json({ error: 'Failed to store confirmation token' });
    }

    const confirmUrl = `https://forgeai-wgs.com/forge-ai-confirm.html?token=${token}`;
    const displayName = name || email.split('@')[0];

    // Send via Resend API directly
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
                Hey ${displayName}, thanks for signing up for Forge AI. Click the button below to confirm your email address and activate your account.
              </p>
              <p style="color:#666;font-size:13px;margin:0 0 28px;">
                This link expires in 24 hours.
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${confirmUrl}"
                       style="display:inline-block;background:#f97316;color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:8px;letter-spacing:0.3px;">
                      Confirm Email Address
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Fallback link -->
              <p style="color:#555;font-size:12px;margin:28px 0 0;text-align:center;line-height:1.6;">
                Button not working? Copy and paste this link into your browser:<br>
                <a href="${confirmUrl}" style="color:#f97316;word-break:break-all;">${confirmUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #1a1a1a;text-align:center;">
              <p style="color:#444;font-size:12px;margin:0;">
                If you didn't create a Forge AI account, you can safely ignore this email.
              </p>
              <p style="color:#333;font-size:11px;margin:8px 0 0;">
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

    return res.status(200).json({ success: true, messageId: emailData.id });
  } catch (err) {
    console.error('send-confirmation error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
