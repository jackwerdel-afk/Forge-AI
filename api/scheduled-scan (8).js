const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  // Security check
  const authHeader = req.headers.authorization;
  const secret = req.query && req.query.secret;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isAuthorized = 
    authHeader === `Bearer ${process.env.CRON_SECRET}` ||
    secret === process.env.CRON_SECRET ||
    isVercelCron;

  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Scheduled scan started:', new Date().toISOString());

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Get all active sites - deduplicated by user_id + url
    const { data: allSites, error } = await sb
      .from('scheduled_sites')
      .select('*')
      .eq('active', true);

    if (error) throw error;
    if (!allSites || allSites.length === 0) {
      return res.status(200).json({ message: 'No sites to scan', scanned: 0 });
    }

    // Deduplicate by user_id + url
    const seen = new Set();
    const sites = allSites.filter(site => {
      const key = site.user_id + '|' + site.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`Found ${sites.length} unique sites to scan (${allSites.length} total)`);

    // Load paid subscriptions — only scan sites for paid users
    const { data: paidSubs } = await sb
      .from('subscriptions')
      .select('user_id, email, plan')
      .neq('plan', 'free')
      .eq('status', 'active');

    const paidUserIds = new Set((paidSubs || []).map(s => s.user_id).filter(Boolean));
    const paidSites = sites.filter(s => paidUserIds.has(s.user_id));
    console.log(`Paid users: ${paidUserIds.size}, sites to scan: ${paidSites.length}`);

    // Fetch user emails
    const userEmails = {};
    try {
      const { data: { users } } = await sb.auth.admin.listUsers();
      if (users) users.forEach(u => { userEmails[u.id] = u.email; });
    } catch(e) {
      console.log('Could not fetch user emails:', e.message);
    }

    const results = [];
    let scanned = 0;
    let needAlerts = 0;

    for (const site of paidSites) {
      try {
        console.log(`Scanning: ${site.url}`);

        // Use the secure /api/scan endpoint for accurate consistent scores
        const scanRes = await fetch('https://forgeai-wgs.com/api/scan', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.CRON_SECRET}`
          },
          body: JSON.stringify({ url: site.url, internal: true })
        });

        if (!scanRes.ok) {
          console.log(`Scan failed for ${site.url}: ${scanRes.status}`);
          continue;
        }

        const scanData = await scanRes.json();
        if (!scanData.success || !scanData.result) {
          console.log(`No result for ${site.url}`);
          continue;
        }

        const result = scanData.result;
        const newScore = result.overall_score;
        const allIssues = Object.values(result.modules || {}).flatMap(m => (m && m.deductions) ? m.deductions : []);
        const previousScore = (site.last_score !== null && site.last_score !== undefined) ? Number(site.last_score) : null;
        const scoreDrop = previousScore !== null ? previousScore - newScore : 0;

        // Only alert if there was a REAL previous score AND score dropped 10+ points
        // Use explicit null check — a score of 0 is valid and should not be treated as "no previous score"
        const needsAlert = previousScore !== null && previousScore > 0 && scoreDrop >= 10;

        results.push({
          url: site.url,
          score: newScore,
          previousScore,
          scoreDrop,
          needsAlert
        });

        // Update scheduled_sites
        const nowISO = new Date().toISOString();
        const updateData = {
          last_score: newScore,
          last_scanned: nowISO,
          last_result: result,
          has_critical: (result.critical_issues || 0) > 0
        };
        if (!site.first_scanned_at) {
          updateData.first_scanned_at = nowISO;
        }
        await sb.from('scheduled_sites').update(updateData).eq('id', site.id);

        // Check if monthly report is due
        const clientEmail = site.client_email;
        const firstScanned = site.first_scanned_at || nowISO;
        const lastReportSent = site.last_report_sent_at;
        const daysSinceFirst = Math.floor((Date.now() - new Date(firstScanned)) / 86400000);
        const daysSinceLastReport = lastReportSent
          ? Math.floor((Date.now() - new Date(lastReportSent)) / 86400000)
          : 999;
        const shouldSendReport = clientEmail && daysSinceFirst >= 30 && daysSinceLastReport >= 28;

        if (shouldSendReport) {
          try {
            const { data: portalData } = await sb.from('client_portals')
              .select('token').eq('user_id', site.user_id).eq('site_url', site.url)
              .eq('active', true).maybeSingle();
            let portalToken = portalData?.token;
            if (!portalToken) {
              portalToken = 'cp_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
              await sb.from('client_portals').insert({ user_id: site.user_id, site_url: site.url, site_name: site.name || site.url, token: portalToken, active: true });
            }
            const portalLink = 'https://forgeai-wgs.com/forge-ai-client.html?token=' + portalToken;
            const s = newScore;
            const label = s >= 90 ? 'excellent' : s >= 80 ? 'good' : s >= 70 ? 'fair' : 'below average';
            const topIssue = allIssues.sort((a,b) => Math.abs(b.points||0) - Math.abs(a.points||0))[0];
            let summary = 'Your website scored ' + s + ' out of 100 this month, which is ' + label + '. ';
            if (topIssue) summary += 'The top priority for improvement is ' + (topIssue.issue || '').toLowerCase() + '.';
            await fetch('https://forgeai-wgs.com/api/send-client-report', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-internal': process.env.CRON_SECRET },
              body: JSON.stringify({ clientEmail, clientName: site.client_name || '', siteName: site.name || site.url, siteUrl: site.url, score: newScore, portalLink, agencyName: 'Forge AI', summary, internal: true })
            });
            await sb.from('scheduled_sites').update({ last_report_sent_at: nowISO }).eq('id', site.id);
            console.log('Monthly report sent to ' + clientEmail + ' for ' + site.url);
          } catch(reportErr) {
            console.log('Monthly report error:', reportErr.message);
          }
        }

        // Update user_sites so dashboard shows correct last scan time
        try {
          await sb.from('user_sites').update({
            score: newScore,
            grade: result.grade || null,
            last_scan: nowISO,
            last_result: result,
            updated_at: nowISO
          }).eq('url', site.url).eq('user_id', site.user_id);
        } catch(usErr) {
          console.log('user_sites update error:', usErr.message);
        }

        // Save to scan_results history
        try {
          await sb.from('scan_results').insert({
            user_id: site.user_id,
            url: site.url,
            score: newScore,
            grade: result.grade,
            modules: result.modules,
            issues: allIssues,
            scanned_at: new Date().toISOString()
          });
        } catch(e) {
          console.log('scan_results insert error:', e.message);
        }

        // Only send alerts and emails for score drops
        if (needsAlert) {
          needAlerts++;
          const userEmail = userEmails[site.user_id];

          // Save dashboard alert
          try {
            await sb.from('realtime_alerts').insert({
              user_id: site.user_id,
              url: site.url,
              site_name: site.name || site.url,
              message: `Score dropped ${scoreDrop} points (from ${previousScore} to ${newScore}) on this site.`,
              severity: scoreDrop >= 20 ? 'critical' : 'high',
              read: false,
              created_at: new Date().toISOString()
            });
          } catch(e) {
            console.log('Alert save error:', e.message);
          }

          // Send email alert
          if (userEmail) {
            try {
              await fetch('https://forgeai-wgs.com/api/send-alert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  to: userEmail,
                  siteName: site.name || site.url,
                  siteUrl: site.url,
                  score: newScore,
                  criticalIssues: allIssues.slice(0, 5),
                  dashboardUrl: 'https://forgeai-wgs.com/forge-ai-dashboard.html'
                })
              });
              console.log(`Alert email sent to ${userEmail} for ${site.url}`);
            } catch(e) {
              console.log('Email send error:', e.message);
            }
          }
        }

        scanned++;

      } catch(siteErr) {
        console.log(`Error scanning ${site.url}:`, siteErr.message);
      }
    }

    // Trigger autonomous WordPress maintenance
    try {
      await fetch('https://forgeai-wgs.com/api/auto-maintain', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.CRON_SECRET}` }
      });
      console.log('Auto-maintain triggered');
    } catch(e) {
      console.log('Auto-maintain error:', e.message);
    }

    console.log(`Scan complete: ${scanned} sites scanned, ${needAlerts} alerts sent`);

    // Trigger Forge Agent queue generation for all paid users
    const agentUserIds = new Set(paidSites.map(s => s.user_id));
    for (const userId of agentUserIds) {
      try {
        // Get a service-level token for this user to call agent-queue
        const { data: userData } = await sb.auth.admin.getUserById(userId);
        if (userData && userData.user) {
          // Generate fixes via internal call
          await fetch('https://forgeai-wgs.com/api/agent-queue', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal': process.env.CRON_SECRET
            }
          });
          console.log(`Agent queue triggered for user ${userId}`);
        }
      } catch(agentErr) {
        console.log(`Agent queue error for user ${userId}:`, agentErr.message);
      }
    }

    return res.status(200).json({
      message: 'Scheduled scan complete',
      scanned,
      total: sites.length,
      needAlerts,
      results
    });

  } catch(err) {
    console.error('Scheduled scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
