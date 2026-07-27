module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization;
    const internalKey = req.headers['x-internal'];
    const isInternal = internalKey === process.env.CRON_SECRET;
    
    if (!authHeader && !isInternal) return res.status(401).json({ error: 'Unauthorized' });

    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (!isInternal) {
      const token = authHeader.replace('Bearer ', '');
      const { data: { user }, error: authError } = await sb.auth.getUser(token);
      if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });
    }

    const { clientEmail, clientName, siteName, siteUrl, score, portalLink, agencyName, summary } = req.body;
    if (!clientEmail || !portalLink) return res.status(400).json({ error: 'Missing required fields' });

    // Validate email format before calling Resend
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(clientEmail)) {
      return res.status(400).json({ error: 'Invalid client email address format.' });
    }

    const scoreColor = score >= 80 ? '#22c97a' : score >= 60 ? '#f5a623' : '#ff4d4d';
    const scoreLabel = score >= 80 ? 'Good' : score >= 60 ? 'Needs Attention' : 'Critical';

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
        <tr><td align="center" style="padding-bottom:36px">
          <img src="https://mybvzjcjfjytcfgitmpv.supabase.co/storage/v1/object/public/assets/forge-ai-logo.png" width="90" height="116" alt="" style="display:block;margin:0 auto">
        </td></tr>
        <tr><td style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.07);border-radius:16px;overflow:hidden">
          <tr><td style="padding:32px 36px 20px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#FF883F;text-transform:uppercase;letter-spacing:0.1em;font-family:monospace">Website Health Report</p>
            <h1 style="margin:0;font-size:22px;font-weight:800;color:#f0f0f5;letter-spacing:-0.03em;line-height:1.25">${siteName || siteUrl}</h1>
          </td></tr>
          <tr><td style="padding:24px 36px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:20px;text-align:center">
              <div style="font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">Health Score</div>
              <div style="font-size:56px;font-weight:900;color:${scoreColor};letter-spacing:-0.04em;line-height:1">${score || '—'}</div>
              <div style="font-size:13px;color:${scoreColor};font-weight:700;margin-top:4px">${scoreLabel}</div>
            </div>
          </td></tr>
          ${summary ? `
          <tr><td style="padding:24px 36px;border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Summary</div>
            <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.75);line-height:1.8">${summary}</p>
          </td></tr>` : ''}
          <tr><td align="center" style="padding:28px 36px 32px">
            <a href="${portalLink}" style="display:inline-block;background:#FF883F;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 36px;border-radius:10px;letter-spacing:0.01em">View Full Report →</a>
            <p style="margin:16px 0 0;font-size:12px;color:rgba(255,255,255,0.25);line-height:1.6">${siteUrl}</p>
          </td></tr>
        </td></tr>
        <tr><td align="center" style="padding-top:28px">
          <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.18);font-family:monospace;letter-spacing:0.06em">
            ${agencyName || 'Forge AI'} &nbsp;·&nbsp; <a href="https://forgeai-wgs.com" style="color:rgba(255,255,255,0.18);text-decoration:none">forgeai-wgs.com</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    // Send via Resend
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: `${agencyName || 'Forge AI'} <alerts@forgeai-wgs.com>`,
        to: [clientEmail],
        subject: `Your Website Health Report — ${siteName || siteUrl}`,
        html: emailHtml
      })
    });

    const emailData = await emailRes.json();
    if (!emailRes.ok) throw new Error(emailData.message || 'Email send failed');

    // Log report to client_reports table
    try {
      // Accept userId directly from body, or fall back to token lookup
      let userId = req.body.userId || null;
      if (!userId) {
        const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
        if (token) {
          const { data: { user } } = await sb.auth.getUser(token);
          if (user) userId = user.id;
        }
      }
      console.log('Report logging userId:', userId, 'site:', siteName);
      if (userId) {
        await sb.from('client_reports').insert({
          user_id: userId,
          site_id: req.body.siteId || null,
          site_name: siteName || siteUrl || null,
          site_url: siteUrl || null,
          client_name: clientName || null,
          client_email: clientEmail || null,
          score: score || null,
          grade: req.body.grade || null,
          sent_at: new Date().toISOString()
        });
      }
    } catch(logErr) {
      console.log('Report log error (non-fatal):', logErr.message);
    }

    return res.status(200).json({ success: true });
  } catch(e) {
    console.error('Send client report error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
