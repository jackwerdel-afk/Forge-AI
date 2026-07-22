// api/send-alert.js
// Sends email alerts when critical issues are found during scheduled scans

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, siteName, siteUrl, score, previousScore, criticalIssues, dashboardUrl } = req.body;

  if (!to || !siteName || !siteUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;

  // Build premium email using Forge AI template

  const scoreColor = score >= 80 ? '#22c97a' : score >= 60 ? '#f5a623' : '#ff4d4d';
  const scoreBg = score >= 80 ? 'rgba(34,201,122,0.1)' : score >= 60 ? 'rgba(245,166,35,0.1)' : 'rgba(255,77,77,0.1)';
  const scoreBorder = score >= 80 ? 'rgba(34,201,122,0.25)' : score >= 60 ? 'rgba(245,166,35,0.25)' : 'rgba(255,77,77,0.25)';

  const issuesHtml = (criticalIssues || []).map(issue =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <span style="color:#ff6b6b;font-size:13px;font-weight:500">● ${issue}</span>
    </td></tr>`
  ).join('');

  const emailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="dark">
</head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;min-height:100vh">
    <tr><td align="center" style="padding:48px 20px">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

        <!-- Logo -->
        <tr><td align="center" style="padding-bottom:36px">
          <img src="https://mybvzjcjfjytcfgitmpv.supabase.co/storage/v1/object/public/assets/forge-ai-logo.png" width="90" height="116" alt="" style="display:block;margin:0 auto">
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.07);border-radius:16px;overflow:hidden">

          <!-- Headline -->
          <tr><td style="padding:32px 36px 20px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#FF883F;text-transform:uppercase;letter-spacing:0.1em;font-family:monospace">Score Alert</p>
            <h1 style="margin:0;font-size:22px;font-weight:800;color:#f0f0f5;letter-spacing:-0.03em;line-height:1.25">
              ${siteName} needs attention
            </h1>
          </td></tr>

          <!-- Score -->
          <tr><td style="padding:24px 36px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:${scoreBg};border:1px solid ${scoreBorder};border-radius:12px;padding:16px 20px;width:48%;vertical-align:middle">
                  <div style="font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Current Score</div>
                  <div style="font-size:40px;font-weight:900;color:${scoreColor};letter-spacing:-0.04em;line-height:1">${score}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:2px">out of 100</div>
                </td>
                <td style="width:4%"></td>
                <td style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px 20px;width:48%;vertical-align:middle">
                  <div style="font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">Previous Score</div>
                  <div style="font-size:40px;font-weight:900;color:rgba(255,255,255,0.5);letter-spacing:-0.04em;line-height:1">${previousScore || '—'}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,0.3);margin-top:2px">out of 100</div>
                </td>
              </tr>
            </table>
          </td></tr>

          ${issuesHtml ? `
          <!-- Issues -->
          <tr><td style="padding:24px 36px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px">Issues Found</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${issuesHtml}
            </table>
          </td></tr>` : ''}

          <!-- CTA -->
          <tr><td align="center" style="padding:28px 36px 32px">
            <a href="https://forgeai-wgs.com/forge-ai-dashboard.html" style="display:inline-block;background:#FF883F;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.01em">
              View Dashboard →
            </a>
            <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6">
              ${siteUrl}
            </p>
          </td></tr>

        </td></tr>

        <!-- Footer -->
        <tr><td align="center" style="padding-top:28px">
          <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.18);font-family:monospace;letter-spacing:0.06em">
            FORGE AI &nbsp;·&nbsp; <a href="https://forgeai-wgs.com" style="color:rgba(255,255,255,0.18);text-decoration:none">forgeai-wgs.com</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: [to],
        subject: `⚠ Critical issues found on ${siteName} — Score: ${score}/100`,
        html: emailHtml
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Failed to send email');
    }

    console.log('Alert sent to:', to, 'for site:', siteUrl);
    return res.status(200).json({ success: true, id: data.id });

  } catch (err) {
    console.error('Email error:', err);
    return res.status(500).json({ error: err.message });
  }
};
