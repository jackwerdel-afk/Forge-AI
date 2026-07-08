const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function decrypt(text) {
  try {
    const key = crypto.scryptSync(process.env.CRON_SECRET || 'ForgeAI2026!', 'salt', 32);
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch(e) {
    return null;
  }
}

async function applyFix(siteUrl, credentials, fix) {
  const authHeader = 'Basic ' + credentials;
  const { issue_type, target_id, proposed_fix } = fix;

  if (issue_type === 'meta_description') {
    // Try post first, then page — write to excerpt as a universally writable field
    // Also attempt Yoast meta if available
    const postBody = {
      excerpt: proposed_fix,
      meta: { _yoast_wpseo_metadesc: proposed_fix, _forge_meta_description: proposed_fix }
    };
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/posts/${target_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify(postBody)
    });
    if (!res.ok) {
      const res2 = await fetch(`${siteUrl}/wp-json/wp/v2/pages/${target_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
        body: JSON.stringify(postBody)
      });
      return res2.ok;
    }
    return true;
  }

  if (issue_type === 'page_title') {
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/posts/${target_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ title: proposed_fix })
    });
    if (!res.ok) {
      const res2 = await fetch(`${siteUrl}/wp-json/wp/v2/pages/${target_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
        body: JSON.stringify({ title: proposed_fix })
      });
      return res2.ok;
    }
    return true;
  }

  if (issue_type === 'alt_text') {
    const res = await fetch(`${siteUrl}/wp-json/wp/v2/media/${target_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify({ alt_text: proposed_fix })
    });
    return res.ok;
  }

  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  // Forge Agent requires Agency or Enterprise plan
  // For team members, check the agency owner's plan instead
  const { data: memberRecord } = await sb.from('team_members')
    .select('agency_id, role')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  let planEmail = user.email;
  if (memberRecord && memberRecord.agency_id) {
    // Get agency owner's email
    const { data: { users: allUsers } } = await sb.auth.admin.listUsers();
    const ownerUser = allUsers && allUsers.find(u => u.id === memberRecord.agency_id);
    if (ownerUser) planEmail = ownerUser.email;
  }

  const { data: userSub } = await sb.from('subscriptions')
    .select('plan')
    .eq('email', planEmail)
    .maybeSingle();
  const userPlan = (userSub && userSub.plan) ? userSub.plan : 'free';
  if (userPlan !== 'agency' && userPlan !== 'enterprise') {
    return res.status(403).json({ error: 'Forge Agent requires the Agency plan or higher.' });
  }

  const { fixId, action } = req.body;
  if (!fixId || !action) return res.status(400).json({ error: 'Missing fixId or action' });

  // Use owner's user_id for team members
  const ownerUserId = memberRecord ? memberRecord.agency_id : user.id;

  // Get the fix
  const { data: fix, error: fixError } = await sb.from('agent_fixes')
    .select('*')
    .eq('id', fixId)
    .eq('user_id', ownerUserId)
    .single();

  if (fixError || !fix) return res.status(404).json({ error: 'Fix not found' });

  // Handle reject
  if (action === 'reject') {
    await sb.from('agent_fixes').update({ status: 'rejected' }).eq('id', fixId);
    await sb.from('team_activity').insert({ agency_id: ownerUserId, user_id: user.id, action: 'fix_rejected', details: 'Rejected fix: ' + (fix.fix_type || '') + ' on ' + (fix.page_url || ''), site_url: fix.page_url || '', site_name: fix.site_name || fix.page_url || '' }).catch(function(){});
    return res.status(200).json({ success: true, status: 'rejected' });
  }

  // Handle approve — mark as approved but don't deploy yet
  if (action === 'approve') {
    await sb.from('agent_fixes').update({
      status: 'approved',
      approved_at: new Date().toISOString()
    }).eq('id', fixId);
    await sb.from('team_activity').insert({ agency_id: ownerUserId, user_id: user.id, action: 'fix_approved', details: 'Approved fix: ' + (fix.fix_type || '') + ' on ' + (fix.page_url || ''), site_url: fix.page_url || '', site_name: fix.site_name || fix.page_url || '' }).catch(function(){});
    return res.status(200).json({ success: true, status: 'approved' });
  }

  // Handle deploy — actually push the fix to WordPress
  if (action === 'deploy') {
    if (fix.status !== 'approved') {
      return res.status(400).json({ error: 'Fix must be approved before deploying' });
    }

    try {
      // Get WordPress credentials for this site
      // Check both user_sites and scheduled_sites for credentials
      let wpCredentials = null;

      const { data: userSite } = await sb.from('user_sites')
        .select('wp_credentials')
        .eq('user_id', user.id)
        .eq('url', fix.site_url)
        .maybeSingle();

      if (userSite && userSite.wp_credentials) {
        wpCredentials = userSite.wp_credentials;
      } else {
        const { data: schedSite } = await sb.from('scheduled_sites')
          .select('wp_credentials')
          .eq('user_id', user.id)
          .eq('url', fix.site_url)
          .maybeSingle();
        if (schedSite && schedSite.wp_credentials) {
          wpCredentials = schedSite.wp_credentials;
        }
      }

      if (!wpCredentials) {
        await sb.from('agent_fixes').update({
          status: 'failed',
          error_message: 'No WordPress credentials found for this site'
        }).eq('id', fixId);
        return res.status(400).json({ error: 'No credentials found' });
      }

      const credentials = decrypt(wpCredentials);
      if (!credentials) {
        await sb.from('agent_fixes').update({
          status: 'failed',
          error_message: 'Could not decrypt WordPress credentials'
        }).eq('id', fixId);
        return res.status(400).json({ error: 'Could not decrypt credentials' });
      }

      // Get current score before deploying
      let scoreBefore = null;
      try {
        const { data: siteData } = await sb.from('user_sites')
          .select('score').eq('url', fix.site_url).eq('user_id', user.id).maybeSingle();
        if (siteData) scoreBefore = siteData.score;
      } catch(e) {}

      // Apply the fix
      const deployed = await applyFix(fix.site_url, credentials, fix);

      if (deployed) {
        await sb.from('agent_fixes').update({
          status: 'deployed',
          deployed_at: new Date().toISOString(),
          score_before: scoreBefore
        }).eq('id', fixId);

        // Save alert
        try {
          await sb.from('realtime_alerts').insert({
            user_id: user.id,
            url: fix.site_url,
            site_name: fix.site_name || fix.site_url,
            message: `Forge Agent deployed fix: ${fix.issue_description}`,
            severity: 'low',
            read: false,
            created_at: new Date().toISOString()
          });
        } catch(alertErr) {
          console.log('Alert save error:', alertErr.message);
        }

        // Verify — rescan the site and record new score
        let verifiedScore = null;
        try {
          const scanRes = await fetch('https://forgeai-wgs.com/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
            body: JSON.stringify({ url: fix.site_url, internal: true })
          });
          if (scanRes.ok) {
            const scanData = await scanRes.json();
            if (scanData.success && scanData.result) {
              verifiedScore = scanData.result.overall_score;
              await sb.from('agent_fixes').update({ verified_score: verifiedScore }).eq('id', fixId);
              // Update user_sites with new score
              await sb.from('user_sites').update({
                score: verifiedScore,
                last_scan: new Date().toISOString(),
                last_result: scanData.result
              }).eq('url', fix.site_url).eq('user_id', user.id);
            }
          }
        } catch(verifyErr) {
          console.log('Verification scan error:', verifyErr.message);
        }

        await sb.from('team_activity').insert({ agency_id: ownerUserId, user_id: user.id, action: 'fix_deployed', details: 'Deployed ' + (fix.fix_type || '') + ' fix. Score: ' + (scoreBefore || '?') + ' → ' + (verifiedScore || '?'), site_url: fix.page_url || '', site_name: fix.site_name || fix.page_url || '' }).catch(function(){});
        return res.status(200).json({ success: true, status: 'deployed', verifiedScore, scoreBefore });
      } else {
        await sb.from('agent_fixes').update({
          status: 'failed',
          error_message: 'WordPress API returned an error'
        }).eq('id', fixId);
        return res.status(500).json({ error: 'Deploy failed — WordPress API error' });
      }

    } catch(e) {
      await sb.from('agent_fixes').update({
        status: 'failed',
        error_message: e.message
      }).eq('id', fixId);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action' });
};
