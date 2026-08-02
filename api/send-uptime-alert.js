module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, siteName, siteUrl, type, responseTime, durationSeconds, dashboardUrl } = req.body;
  if (!to || !siteName || !siteUrl || !type) return res.status(400).json({ error: 'Missing fields' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

  const isDown = type === 'down';
  const subject = isDown
    ? `🔴 SITE DOWN — ${siteName}`
    : `🟢 Site Recovered — ${siteName}`;

  const statusColor = isDown ? '#ff4d4d' : '#22c97a';
  const statusBg = isDown ? 'rgba(255,77,77,0.1)' : 'rgba(34,201,122,0.1)';
  const statusText = isDown ? 'DOWN' : 'RECOVERED';

  const detailHtml = isDown
    ? `<p style="margin:0;color:#a0a0b0;font-size:14px">Response time: ${responseTime ? responseTime + 'ms' : 'Timed out'}</p>`
    : `<p style="margin:0;color:#a0a0b0;font-size:14px">Was down for: ${durationSeconds ? Math.round(durationSeconds / 60) + ' minutes' : 'unknown duration'}</p>`;

  const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;min-height:100vh">
    <tr><td align="center" style="padding:48px 20px">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

        <!-- Header -->
        <tr><td style="padding-bottom:32px;text-align:center">
          <span style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.04em">Forge AI</span>
          <span style="display:block;font-size:12px;color:#606070;margin-top:4px;letter-spacing:0.08em;text-transform:uppercase">Uptime Monitor</span>
        </td></tr>

        <!-- Status Card -->
        <tr><td style="background:#111117;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px">

          <!-- Status Badge -->
          <div style="text-align:center;margin-bottom:24px">
            <span style="display:inline-block;padding:8px 20px;border-radius:100px;background:${statusBg};border:1px solid ${statusColor};color:${statusColor};font-size:13px;font-weight:700;letter-spacing:0.06em">
              ● ${statusText}
            </span>
          </div>

          <!-- Site Name -->
          <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#ffffff;text-align:center;letter-spacing:-0.02em">${siteName}</h1>
          <p style="margin:0 0 24px;font-size:13px;color:#606070;text-align:center;font-family:monospace">${siteUrl}</p>

          <!-- Detail -->
          <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:16px;text-align:center;margin-bottom:24px">
            ${detailHtml}
            <p style="margin:6px 0 0;color:#606070;font-size:12px">Detected: ${new Date().toUTCString()}</p>
          </div>

          <!-- CTA -->
          <div style="text-align:center">
            <a href="${dashboardUrl}" style="display:inline-block;padding:12px 28px;background:#FF883F;color:#ffffff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:600">
              View Dashboard
            </a>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding-top:24px;text-align:center">
          <p style="margin:0;font-size:11px;color:#404050">Forge AI Uptime Monitor · Checked every 5 minutes</p>
          <p style="margin:4px 0 0;font-size:11px;color:#404050">Werdel Global Systems</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: [to],
        subject,
        html: emailHtml
      })
    });
    const emailData = await emailRes.json();
    if (!emailRes.ok) return res.status(500).json({ error: emailData.message || 'Email failed' });
    return res.status(200).json({ success: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
