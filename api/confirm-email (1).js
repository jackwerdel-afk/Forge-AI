// api/confirm-email.js
// Verifies the confirmation token and marks the account as confirmed

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    // Decode token to get userId and expiry
    let payload;
    try {
      payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    } catch {
      return res.redirect(302, '/forge-ai-signup.html?confirmed=invalid');
    }

    if (!payload.userId || !payload.email || !payload.exp) {
      return res.redirect(302, '/forge-ai-signup.html?confirmed=invalid');
    }

    if (Date.now() > payload.exp) {
      return res.redirect(302, '/forge-ai-signup.html?confirmed=expired');
    }

    // Check token exists in DB and not already used
    const lookupRes = await fetch(
      `${supabaseUrl}/rest/v1/email_confirmations?token=eq.${encodeURIComponent(token)}&select=*`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    const rows = await lookupRes.json();

    if (!rows || rows.length === 0) {
      return res.redirect(302, '/forge-ai-signup.html?confirmed=invalid');
    }

    if (rows[0].confirmed) {
      // Already confirmed — just send them to login
      return res.redirect(302, '/forge-ai-login.html?confirmed=already');
    }

    // Mark token as confirmed
    await fetch(
      `${supabaseUrl}/rest/v1/email_confirmations?token=eq.${encodeURIComponent(token)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ confirmed: true, confirmed_at: new Date().toISOString() }),
      }
    );

    // Confirm the user in Supabase Auth using admin API
    const confirmRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${payload.userId}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({ email_confirm: true }),
      }
    );

    if (!confirmRes.ok) {
      const err = await confirmRes.text();
      console.error('Failed to confirm user in Supabase Auth:', err);
      return res.redirect(302, '/forge-ai-signup.html?confirmed=error');
    }

    // All good — redirect to login with success message
    return res.redirect(302, '/forge-ai-login.html?confirmed=true');
  } catch (err) {
    console.error('confirm-email error:', err);
    return res.redirect(302, '/forge-ai-signup.html?confirmed=error');
  }
}
