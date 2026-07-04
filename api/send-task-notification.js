const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { to, assigneeName, taskTitle, taskDescription, siteName, priority, createdBy } = req.body;
    if (!to || !taskTitle) return res.status(400).json({ error: 'Missing required fields' });

    const priorityColors = { high: '#ff4d4d', medium: '#ff8800', low: '#888' };
    const priorityColor = priorityColors[priority] || priorityColors.medium;
    const priorityLabel = (priority || 'medium').charAt(0).toUpperCase() + (priority || 'medium').slice(1);

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;min-height:100vh">
  <tr><td align="center" style="padding:40px 20px">
    <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%">
      <tr><td style="background:#111;border:1px solid #222;border-radius:12px 12px 0 0;padding:24px 28px;border-bottom:none">
        <div style="font-size:11px;color:#FF883F;font-family:monospace;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:6px">Forge AI · New Task Assigned</div>
        <div style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.02em">${taskTitle}</div>
      </td></tr>
      <tr><td style="background:#111;border:1px solid #222;border-top:none;border-bottom:none;padding:20px 28px">
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #222;border-radius:8px;margin-bottom:16px">
          <tr><td style="padding:14px 18px">
            ${siteName ? `<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #1a1a1a"><span style="font-size:11px;color:#555;font-family:monospace">Site</span><br><span style="font-size:13px;color:#ccc;margin-top:2px;display:block">${siteName}</span></div>` : ''}
            <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #1a1a1a"><span style="font-size:11px;color:#555;font-family:monospace">Priority</span><br><span style="font-size:13px;font-weight:700;color:${priorityColor};margin-top:2px;display:block">${priorityLabel}</span></div>
            <div><span style="font-size:11px;color:#555;font-family:monospace">Assigned by</span><br><span style="font-size:13px;color:#ccc;margin-top:2px;display:block">${createdBy}</span></div>
          </td></tr>
        </table>
        ${taskDescription ? `<div style="font-size:13px;color:#aaa;line-height:1.7;margin-bottom:16px">${taskDescription}</div>` : ''}
        <a href="https://forgeai-wgs.com/forge-ai-dashboard.html" style="display:block;background:#FF883F;color:#fff;text-align:center;padding:13px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px">View in Forge AI →</a>
      </td></tr>
      <tr><td style="background:#0a0a0a;border:1px solid #222;border-top:none;border-radius:0 0 12px 12px;padding:14px 28px;text-align:center">
        <div style="font-size:10px;color:#444;font-family:monospace">FORGE AI · WERDEL GLOBAL SYSTEMS</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: [to],
        subject: `New task assigned: ${taskTitle}`,
        html
      })
    });

    return res.status(200).json({ success: true });
  } catch(e) {
    console.error('Task notification error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
