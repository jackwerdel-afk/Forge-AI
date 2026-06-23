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
        return res.redirect(302, '/forge-ai-login.html?confirmed=true');
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

    // Return a page that messages the opener tab and closes itself
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(`<!DOCTYPE html><html><head><title>Confirmed</title></head><body style="margin:0;background:#07070c;font-family:'Inter',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;color:#f0f0f8">
  <div style="font-size:48px;margin-bottom:16px;animation:pop 0.5s ease">✓</div>
  <div style="font-size:20px;font-weight:700;color:#22c97a;margin-bottom:8px">Email confirmed!</div>
  <div style="font-size:14px;color:#70708a">Taking you back to Forge AI...</div>
</div>
<style>@keyframes pop{0%{transform:scale(0)}70%{transform:scale(1.2)}100%{transform:scale(1)}}</style>
<script>
  // Message the opener tab
  if (window.opener && !window.opener.closed) {
    window.opener.postMessage('forge_email_confirmed', '*');
    setTimeout(() => window.close(), 1500);
  } else {
    // No opener — redirect directly to login
    setTimeout(() => { window.location.href = '/forge-ai-login.html?confirmed=true'; }, 1500);
  }
</script>
</body></html>`);



  } catch (err) {
    console.error('confirm-email error:', err);
    return res.redirect(302, '/forge-ai-signup.html?error=server_error');
  }
};
