const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;
  if (!token) return res.redirect(302, '/forge-ai-login.html?error=invalid_link');

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Look up the pending signup by token
    const { data: rows, error: lookupErr } = await sb
      .from('pending_signups')
      .select('*')
      .eq('token', token);

    if (lookupErr || !rows || rows.length === 0) {
      return res.redirect(302, '/forge-ai-login.html?error=invalid_link');
    }

    const pending = rows[0];

    // Check expiry
    if (new Date(pending.expires_at) < new Date()) {
      await sb.from('pending_signups').delete().eq('token', token);
      return res.redirect(302, '/forge-ai-signup.html?error=link_expired');
    }

    // Create the actual Supabase auth account
    const { data: newUser, error: createErr } = await sb.auth.admin.createUser({
      email: pending.email,
      password: pending.password_plain,
      email_confirm: true,
      user_metadata: {
        agency_name: pending.agency_name,
        is_beta: pending.is_beta || false,
        beta_token: pending.beta_token || null,
        terms_agreed_at: pending.terms_agreed_at,
        forge_settings: { pin_hash: pending.pin_hash || null }
      }
    });

    if (createErr) {
      // Already registered — still send them to login
      if (createErr.message && createErr.message.includes('already')) {
        await sb.from('pending_signups').delete().eq('token', token);
        return res.redirect(302, '/forge-ai-welcome.html');
      }
      console.error('Create user error:', createErr);
      return res.redirect(302, '/forge-ai-signup.html?error=signup_failed');
    }

    // Create agency token
    try {
      const agencyToken = 'fat_' + newUser.user.id.replace(/-/g,'').slice(0,16) + '_forgeai';
      await sb.from('agency_tokens').upsert(
        { user_id: newUser.user.id, token: agencyToken },
        { onConflict: 'user_id' }
      );
    } catch(e) { console.log('Agency token error:', e.message); }

    // Delete the pending signup — no longer needed
    await sb.from('pending_signups').delete().eq('token', token);

    // Sign the user in immediately so they land on dashboard authenticated
    // Return a page that signs in and redirects to dashboard
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`<!DOCTYPE html><html><head><title>Confirmed</title></head><body style="margin:0;background:#07070c;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;color:#f0f0f8">
  <div style="font-size:48px;margin-bottom:16px;animation:pop 0.5s ease">✓</div>
  <div style="font-size:20px;font-weight:700;color:#22c97a;margin-bottom:8px">Email confirmed!</div>
  <div style="font-size:14px;color:#70708a">Setting up your account...</div>
</div>
<style>@keyframes pop{0%{transform:scale(0)}70%{transform:scale(1.2)}100%{transform:scale(1)}}</style>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>
  const SUPA_URL = 'https://mybvzjcjfjytcfgitmpv.supabase.co';
  const SUPA_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15YnZ6amNqZmp5dGNmZ2l0bXB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2MTE5MjgsImV4cCI6MjA5NDE4NzkyOH0.OHKGmKlyk86kdSXjFh5jVHqvMC-nPKhPkAtSraPVwEs';
  const EMAIL = '${pending.email}';
  const PASSWORD = '${pending.password_plain}';

  async function autoLogin() {
    try {
      const sb = supabase.createClient(SUPA_URL, SUPA_ANON);
      const { data, error } = await sb.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
      if (error) throw error;
      // Message opener if available
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage('forge_email_confirmed', '*');
        window.opener.location.href = '/forge-ai-welcome.html';
        setTimeout(() => window.close(), 500);
      } else {
        window.location.href = '/forge-ai-welcome.html';
      }
    } catch(e) {
      // Fallback to login page if auto-login fails
      window.location.href = '/forge-ai-login.html?confirmed=true';
    }
  }

  autoLogin();
</script>
</body></html>`);



  } catch (err) {
    console.error('confirm-email error:', err);
    return res.redirect(302, '/forge-ai-signup.html?error=server_error');
  }
};
