// api/send-alert.js
// Sends email alerts when critical issues are found during scheduled scans

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, siteName, siteUrl, score, criticalIssues, dashboardUrl } = req.body;

  if (!to || !siteName || !siteUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;

  // Build the critical issues list
  const issuesList = (criticalIssues || [])
    .map(issue => `<li style="margin-bottom:8px;color:#ff6b6b"><strong>${issue}</strong></li>`)
    .join('');

  // Build the email HTML
  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0c0c0d;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px">
    <!-- Forge AI Logo -->
    <div style="text-align:center;margin-bottom:28px">
      <img src="data:image/png;base64,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" width="88" height="72" alt="Forge AI" style="display:inline-block">
    </div>
   
    <!-- Logo -->
    <div style="margin-bottom:32px">
      <div style="display:inline-flex;align-items:center;gap:10px">
        <div style="width:32px;height:32px;background:#ff6b35;border-radius:8px;display:inline-block;text-align:center;line-height:32px;font-weight:800;color:#fff;font-size:15px">F</div>
        <span style="color:#f0f0f2;font-size:1.1rem;font-weight:800;letter-spacing:-0.02em">Forge AI</span>
      </div>
    </div>

    <!-- Alert Card -->
    <div style="background:#131315;border:1px solid rgba(255,59,59,0.3);border-radius:16px;padding:32px;margin-bottom:24px">
      <div style="display:inline-block;background:rgba(255,59,59,0.1);border:1px solid rgba(255,59,59,0.2);border-radius:100px;padding:4px 14px;font-size:11px;font-weight:600;color:#ff6b6b;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:16px">
        ⚠ Critical Alert
      </div>
      
      <h1 style="color:#f0f0f2;font-size:1.4rem;font-weight:800;letter-spacing:-0.03em;margin:0 0 8px">
        Issues found on ${siteName}
      </h1>
      
      <p style="color:#9090a0;font-size:0.85rem;margin:0 0 24px">
        ${siteUrl}
      </p>

      <!-- Score -->
      <div style="background:#1a1a1d;border-radius:10px;padding:16px;margin-bottom:24px;display:flex;align-items:center;justify-content:space-between">
        <span style="color:#6b6b78;font-size:0.75rem;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase">Current Score</span>
        <span style="font-size:1.8rem;font-weight:800;color:${score >= 75 ? '#22c97a' : score >= 50 ? '#f5a623' : '#ff3b3b'}">${score}<span style="font-size:0.9rem;color:#6b6b78;font-weight:400">/100</span></span>
      </div>

      <!-- Critical Issues -->
      <div style="margin-bottom:24px">
        <p style="color:#6b6b78;font-size:0.72rem;font-family:monospace;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 12px">Critical Issues Found</p>
        <ul style="margin:0;padding:0 0 0 20px;color:#9090a0;font-size:0.85rem;line-height:1.7">
          ${issuesList || '<li style="color:#9090a0">General performance issues detected</li>'}
        </ul>
      </div>

      <!-- CTA Button -->
      <a href="${dashboardUrl || 'https://forgeai-wgs.com/forge-ai-dashboard.html'}" 
         style="display:block;background:#ff6b35;color:#fff;text-align:center;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:0.9rem">
        View Full Report →
      </a>
    </div>

    <!-- Footer -->
    <div style="text-align:center">
      <p style="color:#6b6b78;font-size:0.72rem;font-family:monospace">
        Forge AI — Website Intelligence System<br>
        A product of Werdel Global Systems<br>
        <span style="color:#4b4b58">You're receiving this because you enabled auto-scanning for this site.</span>
      </p>
    </div>

  </div>
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
