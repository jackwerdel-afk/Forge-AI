module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, url, score, previousScore, scoreDrop, fixes, criticalCount, platform } = req.body;
  if (!to || !url) return res.status(400).json({ error: 'Missing required fields' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const autoFixes = (fixes || []).filter(f => f.can_auto_apply);
  const scoreColor = score >= 75 ? '#22c97a' : score >= 50 ? '#f5a623' : '#ff3b3b';

  const fixesHtml = (fixes || []).map(f => `
    <div style="background:#1a1a1d;border-radius:8px;padding:16px;margin-bottom:12px;border-left:3px solid ${f.severity === 'critical' ? '#ff3b3b' : f.severity === 'high' ? '#f5a623' : '#4d9fff'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <strong style="color:#f0f0f2;font-size:14px">${f.issue}</strong>
        <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${f.can_auto_apply ? 'rgba(34,201,122,.15)' : 'rgba(77,159,255,.15)'};color:${f.can_auto_apply ? '#22c97a' : '#4d9fff'}">${f.can_auto_apply ? 'AUTO-FIXED' : 'ACTION NEEDED'}</span>
      </div>
      <div style="font-size:12px;color:#6b6b78;margin-bottom:6px">Current: <span style="color:#9090a0">${f.current || 'MISSING'}</span></div>
      <div style="font-size:12px;color:#6b6b78;margin-bottom:6px">Fixed: <span style="color:#22c97a">${f.fixed_value}</span></div>
      <div style="font-size:12px;color:#6b6b78">${f.explanation}</div>
    </div>`).join('');

  const emailHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#000000;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:40px 20px">
  <div style="text-align:center;margin-bottom:36px">
    <img src="https://mybvzjcjfjytcfgitmpv.supabase.co/storage/v1/object/public/assets/forge-ai-logo.png" alt="" width="90" height="116" style="display:inline-block">
  </div>
  <div style="background:#131315;border:1px solid rgba(255,107,53,0.3);border-radius:16px;padding:32px;margin-bottom:24px">
    <div style="margin-bottom:20px">
      <div style="font-size:11px;color:#6b6b78;font-family:monospace;margin-bottom:4px">SITE MONITORED</div>
      <div style="color:#f0f0f2;font-size:14px;word-break:break-all">${url}</div>
    </div>
    <div style="display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap">
      <div style="background:#1a1a1d;border-radius:10px;padding:16px;flex:1;min-width:120px">
        <div style="font-size:11px;color:#6b6b78;margin-bottom:6px">Current Score</div>
        <div style="font-size:28px;font-weight:800;color:${scoreColor}">${score}<span style="font-size:14px;color:#6b6b78">/100</span></div>
      </div>
      ${previousScore ? `<div style="background:#1a1a1d;border-radius:10px;padding:16px;flex:1;min-width:120px"><div style="font-size:11px;color:#6b6b78;margin-bottom:6px">Previous Score</div><div style="font-size:28px;font-weight:800;color:#9090a0">${previousScore}<span style="font-size:14px;color:#6b6b78">/100</span></div></div>` : ''}
      ${scoreDrop > 0 ? `<div style="background:#1a1a1d;border-radius:10px;padding:16px;flex:1;min-width:120px"><div style="font-size:11px;color:#6b6b78;margin-bottom:6px">Score Drop</div><div style="font-size:28px;font-weight:800;color:#ff3b3b">-${scoreDrop}</div></div>` : ''}
    </div>
    ${fixes && fixes.length > 0 ? `<div style="font-size:12px;color:#6b6b78;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px">Maintenance Actions</div>${fixesHtml}` : ''}
    <a href="https://forgeai-wgs.com/forge-ai-dashboard.html" style="display:block;background:#ff6b35;color:#fff;text-align:center;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin-top:8px">View Full Report →</a>
  </div>
  <p style="color:#6b6b78;font-size:12px;text-align:center;font-family:monospace">Forge AI Autonomous Maintenance — Werdel Global Systems</p>
</div></body></html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Forge AI <onboarding@resend.dev>',
        to: [to],
        subject: `🔧 Forge AI Maintenance Report — ${url.replace(/https?:\/\//,'')} (Score: ${score}/100)`,
        html: emailHtml
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Failed to send email');
    return res.status(200).json({ success: true });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
