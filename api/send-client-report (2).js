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

    const scoreColor = score >= 80 ? '#22c97a' : score >= 60 ? '#f5a623' : '#ff4d4d';
    const scoreLabel = score >= 80 ? 'Good' : score >= 60 ? 'Needs Attention' : 'Critical';
    
    const LOGO_B64 = "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";

    const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#09090f;font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#09090f;min-height:100vh">
  <tr><td align="center" style="padding:40px 20px">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
      
      <!-- Header -->
      <tr><td style="background:#111117;border:1px solid rgba(255,255,255,0.07);border-radius:16px 16px 0 0;padding:28px 32px;text-align:center;border-bottom:1px solid rgba(255,255,255,0.05)">
        <img src="data:image/png;base64,${LOGO_B64}" alt="Forge AI" width="48" height="48" style="display:inline-block;margin-bottom:12px">
        <div style="font-size:11px;color:#50506a;letter-spacing:0.1em;text-transform:uppercase;font-family:monospace">${agencyName || 'Forge AI'}</div>
      </td></tr>

      <!-- Score Hero -->
      <tr><td style="background:#111117;border-left:1px solid rgba(255,255,255,0.07);border-right:1px solid rgba(255,255,255,0.07);padding:32px">
        <p style="margin:0 0 8px;font-size:13px;color:#70708a">Hi ${clientName || 'there'},</p>
        <p style="margin:0 0 24px;font-size:13px;color:#a0a0b0;line-height:1.7">Here is your monthly website health report for <strong style="color:#f0f0f5">${siteName || siteUrl}</strong>.</p>
        
        <!-- Score display -->
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#17171f;border:1px solid rgba(255,255,255,0.07);border-radius:12px;margin-bottom:24px">
          <tr>
            <td style="padding:24px;text-align:center;border-right:1px solid rgba(255,255,255,0.07)">
              <div style="font-size:48px;font-weight:900;color:${scoreColor};line-height:1;letter-spacing:-0.04em">${score || '—'}</div>
              <div style="font-size:11px;color:#70708a;margin-top:4px;font-family:monospace;text-transform:uppercase;letter-spacing:0.06em">Forge Score</div>
            </td>
            <td style="padding:24px;text-align:center">
              <div style="display:inline-block;background:${scoreColor}20;border:1px solid ${scoreColor}40;color:${scoreColor};font-size:13px;font-weight:700;padding:6px 16px;border-radius:100px">${scoreLabel}</div>
              <div style="font-size:11px;color:#70708a;margin-top:8px">out of 100</div>
            </td>
          </tr>
        </table>

        ${summary ? `<p style="margin:0 0 24px;font-size:13px;color:#a0a0b0;line-height:1.7;background:#17171f;border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:16px">${summary}</p>` : ''}

        <!-- CTA Button -->
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center" style="padding:8px 0">
            <a href="${portalLink}" style="display:inline-block;background:#FF883F;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:14px 32px;border-radius:10px;letter-spacing:0.01em">View Full Report →</a>
          </td></tr>
        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0e0e18;border:1px solid rgba(255,255,255,0.07);border-top:none;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center">
        <p style="margin:0;font-size:11px;color:#50506a;font-family:monospace">Powered by Forge AI &nbsp;·&nbsp; <a href="https://forgeai-wgs.com" style="color:#50506a;text-decoration:none">forgeai-wgs.com</a></p>
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
      const token = req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : null;
      let userId = null;
      if (token) {
        const { data: { user } } = await sb.auth.getUser(token);
        if (user) userId = user.id;
      }
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
