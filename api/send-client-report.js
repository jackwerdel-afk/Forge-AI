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
