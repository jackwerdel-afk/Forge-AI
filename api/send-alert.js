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
