const { createClient } = require('@supabase/supabase-js');

const ADMIN_EMAILS = ['contact@siteforgex.com', 'jackwerdel@icloud.com'];

const TIER1_CATEGORIES = {
  adult: 'Adult/Pornographic Content',
  illegal: 'Illegal Content (Drugs/Weapons/Trafficking)',
  phishing: 'Phishing/Scam Site',
  malware: 'Malware/Malicious Site',
  csam: 'Child Sexual Abuse Material'
};

const TIER2_CATEGORIES = {
  gambling: 'Gambling Site',
  impersonation: 'Business Impersonation'
};

async function sendAdminAlert(tier, userEmail, userId, url, category, reason, ip) {
  const categoryLabel = tier === 1
    ? (TIER1_CATEGORIES[category] || category)
    : (TIER2_CATEGORIES[category] || category);

  const tierLabel = tier === 1 ? 'TIER 1 — PERMANENT BAN' : 'TIER 2 — WARNING ISSUED';
  const actionTaken = tier === 1
    ? 'Account permanently banned, all data deleted, email blacklisted.'
    : 'Scan blocked. Account warned. Second offense triggers 2-week suspension.';

  const subject = tier === 1
    ? `🚨 FORGE AI SECURITY: Permanent Ban Issued — ${categoryLabel}`
    : `⚠️ FORGE AI SECURITY: Policy Violation Warning — ${categoryLabel}`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;min-height:100vh">
  <tr><td align="center" style="padding:40px 20px">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

      <!-- Header -->
      <tr><td style="background:${tier === 1 ? '#1a0000' : '#1a1000'};border:1px solid ${tier === 1 ? '#ff0000' : '#ff8800'};border-radius:12px 12px 0 0;padding:24px 32px">
        <div style="font-size:11px;color:${tier === 1 ? '#ff4444' : '#ff8800'};font-family:monospace;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:8px">⚠ Forge AI Security Alert</div>
        <div style="font-size:22px;font-weight:900;color:#ffffff;letter-spacing:-0.02em">${tierLabel}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">${new Date().toUTCString()}</div>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#111;border:1px solid #222;border-top:none;padding:28px 32px">

        <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;border:1px solid #333;border-radius:8px;margin-bottom:20px">
          <tr><td style="padding:16px 20px">
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.1em;font-family:monospace;margin-bottom:12px">Violation Details</div>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding:6px 0;border-bottom:1px solid #1a1a1a">
                <span style="font-size:11px;color:#555;font-family:monospace;display:inline-block;width:140px">Category</span>
                <span style="font-size:12px;color:${tier === 1 ? '#ff4444' : '#ff8800'};font-weight:700">${categoryLabel}</span>
              </td></tr>
              <tr><td style="padding:6px 0;border-bottom:1px solid #1a1a1a">
                <span style="font-size:11px;color:#555;font-family:monospace;display:inline-block;width:140px">URL Attempted</span>
                <span style="font-size:12px;color:#ccc;font-family:monospace">${url}</span>
              </td></tr>
              <tr><td style="padding:6px 0;border-bottom:1px solid #1a1a1a">
                <span style="font-size:11px;color:#555;font-family:monospace;display:inline-block;width:140px">Detection Reason</span>
                <span style="font-size:12px;color:#ccc">${reason}</span>
              </td></tr>
              <tr><td style="padding:6px 0;border-bottom:1px solid #1a1a1a">
                <span style="font-size:11px;color:#555;font-family:monospace;display:inline-block;width:140px">User Email</span>
                <span style="font-size:12px;color:#ccc;font-family:monospace">${userEmail}</span>
              </td></tr>
              <tr><td style="padding:6px 0;border-bottom:1px solid #1a1a1a">
                <span style="font-size:11px;color:#555;font-family:monospace;display:inline-block;width:140px">User ID</span>
                <span style="font-size:12px;color:#ccc;font-family:monospace">${userId || 'unknown'}</span>
              </td></tr>
              <tr><td style="padding:6px 0">
                <span style="font-size:11px;color:#555;font-family:monospace;display:inline-block;width:140px">IP Address</span>
                <span style="font-size:12px;color:#ccc;font-family:monospace">${ip || 'unknown'}</span>
              </td></tr>
            </table>
          </td></tr>
        </table>

        <div style="background:${tier === 1 ? '#1a0000' : '#1a0f00'};border:1px solid ${tier === 1 ? '#440000' : '#442200'};border-radius:8px;padding:16px 20px;margin-bottom:20px">
          <div style="font-size:11px;color:${tier === 1 ? '#ff4444' : '#ff8800'};text-transform:uppercase;letter-spacing:0.1em;font-family:monospace;margin-bottom:6px">Action Taken</div>
          <div style="font-size:13px;color:#ddd;line-height:1.6">${actionTaken}</div>
        </div>

        <div style="font-size:12px;color:#555;line-height:1.7">
          This is an automated security notification from Forge AI. All records have been preserved in the banned_accounts table for legal compliance purposes.
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0a0a0a;border:1px solid #222;border-top:none;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center">
        <div style="font-size:10px;color:#444;font-family:monospace;letter-spacing:0.05em">FORGE AI SECURITY SYSTEM · WERDEL GLOBAL SYSTEMS · CONFIDENTIAL</div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  // Send to all admin emails
  for (const adminEmail of ADMIN_EMAILS) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: 'Forge AI Security <alerts@forgeai-wgs.com>',
          to: [adminEmail],
          subject,
          html
        })
      });
    } catch(e) {
      console.error('Admin alert email error:', e.message);
    }
  }
}

async function executeTier1Ban(sb, userId, userEmail, url, category, reason, ip) {
  console.log(`TIER 1 BAN: ${userEmail} — ${category} — ${url}`);

  try {
    // 1. Record in banned_accounts FIRST (for legal record keeping)
    await sb.from('banned_accounts').upsert({
      email: userEmail,
      user_id: userId,
      reason,
      tier: 1,
      url_attempted: url,
      ip_address: ip,
      banned_at: new Date().toISOString(),
      banned_by: 'system'
    }, { onConflict: 'email' });

    // 2. Mark in user_restrictions
    await sb.from('user_restrictions').upsert({
      user_id: userId,
      email: userEmail,
      is_banned: true,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    // 3. Delete all user data
    const tables = [
      'user_sites', 'scheduled_sites', 'realtime_alerts',
      'agent_fixes', 'client_portals', 'tesseract_conversations',
      'scan_results', 'subscriptions', 'user_restrictions'
    ];
    for (const table of tables) {
      try {
        await sb.from(table).delete().eq('user_id', userId);
      } catch(e) {
        console.log(`Delete from ${table} error:`, e.message);
      }
    }

    // 4. Delete auth user
    try {
      await sb.auth.admin.deleteUser(userId);
    } catch(e) {
      console.log('Delete auth user error:', e.message);
    }

    // 5. Send admin alert
    await sendAdminAlert(1, userEmail, userId, url, category, reason, ip);

    console.log(`TIER 1 BAN COMPLETE: ${userEmail}`);
    return true;
  } catch(e) {
    console.error('Tier 1 ban error:', e.message);
    return false;
  }
}

async function executeTier2Warning(sb, userId, userEmail, url, category, reason, ip) {
  console.log(`TIER 2 WARNING: ${userEmail} — ${category} — ${url}`);

  try {
    // Get current warnings
    const { data: existing } = await sb.from('user_restrictions')
      .select('tier2_warnings, suspended_until')
      .eq('user_id', userId)
      .maybeSingle();

    const currentWarnings = existing ? (existing.tier2_warnings || 0) : 0;
    const newWarnings = currentWarnings + 1;

    if (newWarnings >= 2) {
      // Second offense — 2 week suspension
      const suspendedUntil = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      await sb.from('user_restrictions').upsert({
        user_id: userId,
        email: userEmail,
        is_banned: false,
        suspended_until: suspendedUntil,
        tier2_warnings: newWarnings,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

      // Record in banned_accounts for logging
      await sb.from('banned_accounts').upsert({
        email: userEmail,
        user_id: userId,
        reason: reason + ' (2nd offense — 2 week suspension)',
        tier: 2,
        url_attempted: url,
        ip_address: ip,
        banned_at: new Date().toISOString(),
        banned_by: 'system'
      }, { onConflict: 'email' });

      await sendAdminAlert(2, userEmail, userId, url, category, reason + ' (2nd offense)', ip);
      return { action: 'suspended', suspendedUntil };
    } else {
      // First offense — warning only
      await sb.from('user_restrictions').upsert({
        user_id: userId,
        email: userEmail,
        is_banned: false,
        tier2_warnings: newWarnings,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });

      return { action: 'warned' };
    }
  } catch(e) {
    console.error('Tier 2 warning error:', e.message);
    return { action: 'warned' };
  }
}

async function checkUserStatus(sb, userId, email) {
  // Check if email is permanently banned
  const { data: banned } = await sb.from('banned_accounts')
    .select('tier, reason')
    .eq('email', email)
    .eq('tier', 1)
    .maybeSingle();

  if (banned) {
    return { allowed: false, reason: 'permanently_banned', message: 'This account has been permanently suspended.' };
  }

  // Check user_restrictions
  const { data: restrictions } = await sb.from('user_restrictions')
    .select('is_banned, suspended_until')
    .eq('user_id', userId)
    .maybeSingle();

  if (restrictions) {
    if (restrictions.is_banned) {
      return { allowed: false, reason: 'permanently_banned', message: 'This account has been permanently suspended.' };
    }
    if (restrictions.suspended_until && new Date(restrictions.suspended_until) > new Date()) {
      const until = new Date(restrictions.suspended_until).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      return { allowed: false, reason: 'suspended', message: `Your account is suspended until ${until}.` };
    }
  }

  return { allowed: true };
}

module.exports = { executeTier1Ban, executeTier2Warning, checkUserStatus, sendAdminAlert };
