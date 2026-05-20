module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, siteName, siteUrl, score, criticalIssues, dashboardUrl } = req.body;

  if (!to || !siteName || !siteUrl) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const RESEND_KEY = process.env.RESEND_API_KEY;

  const issuesList = (criticalIssues || [])
    .map(issue => `<li style="margin-bottom:8px;color:#ff6b6b"><strong>${issue}</strong></li>`)
    .join('');

  const emailHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0c0c0d;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:40px 20px"><div style="background:#131315;border:1px solid rgba(255,59,59,0.3);border-radius:16px;padding:32px;margin-bottom:24px"><h1 style="color:#f0f0f2;font-size:1.4rem;font-weight:800;margin:0 0 8px">⚠ Issues found on ${siteName}</h1><p style="color:#9090a0;font-size:0.85rem;margin:0 0 24px">${siteUrl}</p><div style="background:#1a1a1d;border-radius:10px;padding:16px;margin-bottom:24px"><span style="color:#6b6b78;font-size:0.75rem">Current Score: </span><span style="font-size:1.8rem;font-weight:800;color:${score >= 75 ? '#22c97a' : score >= 50 ? '#f5a623' : '#ff3b3b'}">${score}/100</span></div><ul style="margin:0 0 24px;padding:0 0 0 20px;color:#9090a0;font-size:0.85rem;line-height:1.7">${issuesList || '<li>General performance issues detected</li>'}</ul><a href="${dashboardUrl || 'https://forge-ai-six-psi.vercel.app/forge-ai-dashboard.html'}" style="display:block;background:#ff6b35;color:#fff;text-align:center;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700">View Full Report →</a></div><p style="color:#6b6b78;font-size:0.72rem;text-align:center">Forge AI — A product of Werdel Global Systems</p></div></body></html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Forge AI <onboarding@resend.dev>',
        to: [to],
        subject: `⚠ Critical issues found on ${siteName} — Score: ${score}/100`,
        html: emailHtml
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Failed to send email');
    return res.status(200).json({ success: true, id: data.id });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
