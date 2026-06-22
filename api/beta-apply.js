const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, agency_name, website, reason } = req.body;
  if (!name || !email || !agency_name) {
    return res.status(400).json({ error: 'Name, email, and agency name are required.' });
  }

  // Basic email validation
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Check approved spot count — hard limit of 10
    const { count } = await sb
      .from('beta_waitlist')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'approved');

    if (count >= 10) {
      return res.status(400).json({ error: 'Beta is full. All 10 spots have been claimed.' });
    }

    // Check if email already applied
    const { data: existing } = await sb
      .from('beta_waitlist')
      .select('id, status')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (existing) {
      const msg = existing.status === 'approved'
        ? 'This email has already been approved! Check your inbox for your invite.'
        : 'This email already has a pending application. We will be in touch soon.';
      return res.status(400).json({ error: msg });
    }

    // Insert application
    const { error: insertErr } = await sb.from('beta_waitlist').insert({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      agency_name: agency_name.trim(),
      website: website ? website.trim() : null,
      reason: reason ? reason.trim() : null,
      status: 'pending'
    });

    if (insertErr) throw insertErr;

    // Count pending applications
    const { count: totalCount } = await sb
      .from('beta_waitlist')
      .select('*', { count: 'exact', head: true });

    // Notify you via email
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const notifyHtml = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#07070c;font-family:'Inter',Arial,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:40px 20px">
  <div style="background:#0e0e18;border:1px solid rgba(255,136,63,0.2);border-radius:14px;overflow:hidden">
    <div style="background:#111117;padding:24px 32px;border-bottom:1px solid rgba(255,255,255,0.07)">
      <div style="font-size:18px;font-weight:800;color:#FF883F;letter-spacing:-0.02em">Forge AI</div>
      <div style="font-size:11px;color:#606070;margin-top:2px">New Beta Application</div>
    </div>
    <div style="padding:28px 32px">
      <h2 style="font-size:16px;font-weight:700;margin:0 0 20px;color:#f0f0f8">New application from ${name}</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;font-size:13px;color:#70708a;width:120px">Name</td><td style="padding:8px 0;font-size:13px;color:#f0f0f8;font-weight:600">${name}</td></tr>
        <tr><td style="padding:8px 0;font-size:13px;color:#70708a">Email</td><td style="padding:8px 0;font-size:13px;color:#f0f0f8">${email}</td></tr>
        <tr><td style="padding:8px 0;font-size:13px;color:#70708a">Agency</td><td style="padding:8px 0;font-size:13px;color:#f0f0f8">${agency_name}</td></tr>
        <tr><td style="padding:8px 0;font-size:13px;color:#70708a">Website</td><td style="padding:8px 0;font-size:13px;color:#f0f0f8">${website || '—'}</td></tr>
        ${reason ? `<tr><td style="padding:8px 0;font-size:13px;color:#70708a;vertical-align:top">Reason</td><td style="padding:8px 0;font-size:13px;color:#f0f0f8">${reason}</td></tr>` : ''}
      </table>
      <div style="margin-top:20px;padding:14px;background:rgba(255,136,63,0.08);border:1px solid rgba(255,136,63,0.2);border-radius:8px;font-size:13px;color:#FF883F">
        Total applications: <strong>${totalCount}</strong> · Approved: <strong>${count}</strong>/10 spots filled
      </div>
      <a href="https://forgeai-wgs.com/forge-ai-beta-admin.html" style="display:block;margin-top:20px;background:#FF883F;color:#fff;text-align:center;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Review in Admin →</a>
    </div>
  </div>
</div></body></html>`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'Forge AI <alerts@forgeai-wgs.com>',
        to: ['contact@siteforgex.com'],
        subject: `🚀 New beta application — ${agency_name} (${count}/10 spots filled)`,
        html: notifyHtml
      })
    });

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Beta apply error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
