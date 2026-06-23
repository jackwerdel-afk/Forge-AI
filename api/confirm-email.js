// api/confirm-email.js
// When user clicks confirmation link:
// 1. Looks up their pending signup by token
// 2. Creates the actual Supabase auth account
// 3. Deletes the pending signup row
// 4. Redirects to login

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.query;

  if (!token) {
    return res.redirect(302, '/forge-ai-signup.html?confirmed=invalid');
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    // Decode token to check expiry
    let payload;
    try {
      payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    } catch {
      return res.redirect(302, '/forge-ai-signup.html?confirmed=invalid');
    }

    if (!payload.exp || Date.now() > payload.exp) {
      return res.redirect(302, '/forge-ai-signup.html?confirmed=expired');
    }

    // Look up the pending signup
    const lookupRes = await fetch(
      `${supabaseUrl}/rest/v1/pending_signups?token=eq.${encodeURIComponent(token)}&select=*`,
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

    const pending = rows[0];

    // Create the actual Supabase auth account now
    const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        email: pending.email,
        password: pending.password_hash, // This is the actual password (stored temporarily)
        email_confirm: true, // Mark as confirmed immediately
        user_metadata: {
          agency_name: pending.agency_name,
          is_beta: pending.is_beta,
          beta_token: pending.beta_token,
          terms_agreed_at: pending.terms_agreed_at,
          forge_settings: {
            pin_hash: pending.pin_hash,
          },
        },
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json();
      // If email already registered (confirmed a second time), just send to login
      if (err.msg && err.msg.includes('already been registered')) {
        await deletePending(supabaseUrl, supabaseKey, token);
        return res.redirect(302, '/forge-ai-login.html?confirmed=already');
      }
      console.error('Failed to create user:', err);
      return res.redirect(302, '/forge-ai-signup.html?confirmed=error');
    }

    const newUser = await createRes.json();

    // Create agency token
    try {
      const agencyToken = 'fat_' + newUser.id.replace(/-/g, '').slice(0, 16) + '_forgeai';
      await fetch(`${supabaseUrl}/rest/v1/agency_tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({ user_id: newUser.id, token: agencyToken }),
      });
    } catch (e) {
      console.log('Agency token error:', e.message);
    }

    // Mark beta token as used if applicable
    if (pending.is_beta && pending.beta_token) {
      try {
        await fetch(`${supabaseUrl}/rest/v1/beta_invites?token=eq.${encodeURIComponent(pending.beta_token)}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ invite_used_at: new Date().toISOString() }),
        });
      } catch (e) {
        console.log('Beta token mark error:', e.message);
      }
    }

    // Delete the pending signup row — no longer needed
    await deletePending(supabaseUrl, supabaseKey, token);

    // Success — redirect to login
    return res.redirect(302, '/forge-ai-login.html?confirmed=true');

  } catch (err) {
    console.error('confirm-email error:', err);
    return res.redirect(302, '/forge-ai-signup.html?confirmed=error');
  }
}

async function deletePending(supabaseUrl, supabaseKey, token) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/pending_signups?token=eq.${encodeURIComponent(token)}`, {
      method: 'DELETE',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
  } catch (e) {
    console.log('Delete pending error:', e.message);
  }
}
