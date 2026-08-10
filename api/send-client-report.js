const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

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

    const { clientEmail, clientName, siteName, siteUrl, score, portalLink, agencyName, summary, grade, lastResult } = req.body;
    if (!clientEmail || !portalLink) return res.status(400).json({ error: 'Missing required fields' });

    // Generate report HTML server-side
    function buildReportHTML() {
      try {
        const sc = score || 0;
        const gr = grade || (sc>=90?'A':sc>=80?'B':sc>=70?'C':sc>=60?'D':'F');
        const scColor = sc>=80?'#22c97a':sc>=60?'#f5a623':'#ff4d4d';
        const ag = agencyName || 'Your Agency';
        const sName = siteName || siteUrl || 'Website';
        const sDate = new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});
        const res = lastResult || {};
        const mods = res.modules || {};
        const modOrder = ['seo','performance','mobile','ux','maintenance','security'];
        const modLabels = {seo:'SEO',performance:'Performance',mobile:'Mobile',ux:'UX',maintenance:'Maintenance',security:'Security'};
        const modRows = modOrder.map(k => {
          const m = mods[k]; if (!m) return '';
          const s = typeof m.score!=='undefined'?m.score:0;
          const max = m.max_score||20;
          const c = s>=max*0.8?'#22c97a':s>=max*0.6?'#f5a623':'#ff4d4d';
          const pct = Math.round(s/max*100);
          return `<tr style="border-bottom:1px solid #eee"><td style="padding:12px 16px;font-size:13px;color:#333;font-weight:600;width:140px">${modLabels[k]}</td><td style="padding:12px 16px"><div style="background:#eee;border-radius:4px;height:8px"><div style="width:${pct}%;height:100%;background:${c};border-radius:4px"></div></div></td><td style="padding:12px 16px;text-align:right;font-size:13px;font-weight:700;color:${c};width:60px">${s}/${max}</td></tr>`;
        }).join('');
        const issues = (res.priority_summary||[]).slice(0,6).map(line => {
          const isCrit=line.includes('[CRITICAL]'),isHigh=line.includes('[HIGH]'),isMed=line.includes('[MEDIUM]');
          const sev=isCrit?'CRITICAL':isHigh?'HIGH':isMed?'MEDIUM':'LOW';
          const sevColor=isCrit?'#ff4d4d':isHigh?'#f5a623':isMed?'#4d9fff':'#888';
          const text=line.replace(/\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s*/,'').replace(/\s*\(-\d+ pts\)/,'');
          return `<tr style="border-bottom:1px solid #eee"><td style="padding:10px 16px;white-space:nowrap"><span style="font-size:10px;font-weight:800;padding:2px 8px;border-radius:4px;background:${sevColor}22;color:${sevColor};border:1px solid ${sevColor}44">${sev}</span></td><td style="padding:10px 16px;font-size:12.5px;color:#444">${text}</td></tr>`;
        }).join('');
        return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Inter",sans-serif;background:#fff;color:#222}table{width:100%;border-collapse:collapse}</style></head><body>
<div style="background:#1a1a2a;padding:28px 36px;display:flex;align-items:center;justify-content:space-between"><div style="font-size:22px;font-weight:900;color:#FF883F;letter-spacing:-0.03em">${ag}</div><div style="text-align:right"><div style="font-size:10px;color:#9090a8;letter-spacing:0.12em;font-weight:700;text-transform:uppercase">Website Health Report</div><div style="font-size:11px;color:#606070;margin-top:3px">${sDate}</div></div></div>
<div style="padding:40px 36px;text-align:center;background:#f9f9fc;border-bottom:2px solid #eee"><div style="font-size:12px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px">${sName}</div><div style="font-size:80px;font-weight:900;letter-spacing:-0.05em;color:${scColor};line-height:1">${sc}</div><div style="font-size:16px;color:#888;margin-top:6px">out of 100 &nbsp;&middot;&nbsp; Grade ${gr}</div>${summary?`<div style="margin-top:20px;font-size:13px;color:#555;max-width:600px;margin-left:auto;margin-right:auto;line-height:1.75;text-align:left">${summary}</div>`:''}</div>
<div style="padding:28px 36px;border-bottom:1px solid #eee"><div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:16px">Performance by Module</div><table>${modRows||'<tr><td style="padding:12px;color:#888;font-size:13px">No module data available</td></tr>'}</table></div>
${issues?`<div style="padding:28px 36px;border-bottom:1px solid #eee"><div style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:16px">Priority Recommendations</div><table>${issues}</table></div>`:''}
<div style="padding:20px 36px;background:#f9f9fc;text-align:center"><div style="font-size:11px;color:#aaa">Prepared by <strong style="color:#FF883F">${ag}</strong> using Forge AI &nbsp;&middot;&nbsp; ${sDate}</div><div style="font-size:11px;color:#ccc;margin-top:4px">${siteUrl||''}</div></div>
</body></html>`;
      } catch(e) { console.log('Report HTML build error:', e.message); return null; }
    }

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
          report_html: buildReportHTML() || req.body.reportHtml || null,
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
