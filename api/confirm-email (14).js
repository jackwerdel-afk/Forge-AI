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
    // Minimal metadata — onboarding flow collects agency name, PIN, etc.
    const { data: newUser, error: createErr } = await sb.auth.admin.createUser({
      email: pending.email,
      password: pending.password_plain,
      email_confirm: true,
      user_metadata: {
        is_beta: pending.is_beta || false,
        beta_token: pending.beta_token || null,
        terms_agreed_at: pending.terms_agreed_at,
        onboarding_complete: false,
        forge_settings: {}
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
    const agencyToken = 'fat_' + newUser.user.id.replace(/-/g,'').slice(0,16) + '_forgeai';
    const { error: tokenErr } = await sb.from('agency_tokens').upsert(
      { user_id: newUser.user.id, token: agencyToken },
      { onConflict: 'user_id' }
    );
    if (tokenErr) {
      console.error('Agency token error:', tokenErr.message);
    } else {
      console.log('Agency token created:', agencyToken, 'for user:', newUser.user.id);
    }

    // Delete the pending signup
    await sb.from('pending_signups').delete().eq('token', token);

    // Redirect to login with confirmed flag — user signs in and goes to onboarding
    return res.redirect(302, '/forge-ai-login.html?confirmed=true');

  } catch (err) {
    console.error('confirm-email error:', err);
    return res.redirect(302, '/forge-ai-signup.html?error=server_error');
  }
};
