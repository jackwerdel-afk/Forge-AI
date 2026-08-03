const Sentry = require("@sentry/node");
Sentry.init({ dsn: "https://b906d32b0d61fe5bf13af61abaf76755@o4511809521713152.ingest.us.sentry.io/4511813224431616", environment: "production" });

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

  // Single site mode — triggered by auto-add-site for immediate scan
  const singleSite = req.body && req.body.singleSite;
  if (singleSite) {
    console.log('Single site scan triggered for:', singleSite.url);
    try {
      const scanRes = await fetch('https://forgeai-wgs.com/api/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (process.env.CRON_SECRET || '')
        },
        body: JSON.stringify({ url: singleSite.url, userId: singleSite.user_id })
      });
      const scanData = await scanRes.json();
      if (scanData.result) {
        const result = scanData.result;
        const newScore = result.overall_score || result.score || null;
        const nowISO = new Date().toISOString();
        // Normalize URL — strip trailing slash for consistent matching
        const normalUrl = singleSite.url.endsWith('/') ? singleSite.url.slice(0, -1) : singleSite.url;
        await sb.from('user_sites').update({
          score: newScore,
          grade: result.grade || null,
          last_scan: nowISO,
          last_result: result,
          issues: Object.values(result.modules || {}).flatMap(m => m.issues || []),
          score_history: [{ score: newScore, date: nowISO }],
          scan_count: 1
        }).eq('url', normalUrl).eq('user_id', singleSite.user_id);
        console.log('Single site scan complete:', singleSite.url, '→', newScore);
      }
    } catch(e) {
      console.log('Single site scan error:', e.message);
    }
    return res.status(200).json({ success: true, message: 'Single site scan complete' });
  }


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

    // Fetch user emails and settings
    const userEmails = {};
    const userSettings = {};
    try {
      const { data: { users } } = await sb.auth.admin.listUsers();
      if (users) users.forEach(u => {
        userEmails[u.id] = u.email;
        userSettings[u.id] = (u.user_metadata || {}).forge_settings || {};
      });
    } catch(e) {
      console.log('Could not fetch user emails/settings:', e.message);
    }

    const results = [];
    let scanned = 0;
    let needAlerts = 0;

    // ── SCAN SINGLE SITE WITH RETRY ──────────────────────
    async function scanSiteWithRetry(site, siteUserSettings) {
      const MAX_RETRIES = 2;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const scanRes = await fetch('https://forgeai-wgs.com/api/scan', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${process.env.CRON_SECRET}`
            },
            body: JSON.stringify({ url: site.url, internal: true })
          });
          if (!scanRes.ok) {
            console.log(`Scan attempt ${attempt} failed for ${site.url}: ${scanRes.status}`);
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          const scanData = await scanRes.json();
          if (!scanData.success || !scanData.result) {
            console.log(`No result on attempt ${attempt} for ${site.url}`);
            if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          return scanData.result;
        } catch(e) {
          console.log(`Scan attempt ${attempt} error for ${site.url}:`, e.message);
          if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 3000));
        }
      }
      return null; // All retries failed
    }

    // ── PROCESS SITES IN PARALLEL BATCHES OF 3 ───────────
    const BATCH_SIZE = 3;
    const activeSites = paidSites.filter(site => {
      const siteUserSettings = userSettings[site.user_id] || {};
      if (siteUserSettings.auto_scan === false) {
        console.log(`Skipping ${site.url} — auto scan disabled by user`);
        return false;
      }
      return true;
    });

    console.log(`Processing ${activeSites.length} sites in batches of ${BATCH_SIZE}`);

    for (let i = 0; i < activeSites.length; i += BATCH_SIZE) {
      const batch = activeSites.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i/BATCH_SIZE)+1}: ${batch.map(s => s.url).join(', ')}`);

      await Promise.allSettled(batch.map(async (site) => {
      try {
        const siteUserSettings = userSettings[site.user_id] || {};

        console.log(`Scanning: ${site.url}`);

        const result = await scanSiteWithRetry(site, siteUserSettings);

        if (!result) {
          console.log(`All retries failed for ${site.url} — skipping`);
          return;
        }

        const newScore = result.overall_score;
        const allIssues = Object.values(result.modules || {}).flatMap(m => (m && m.deductions) ? m.deductions : []);
        const previousScore = (site.last_score !== null && site.last_score !== undefined) ? Number(site.last_score) : null;
        const scoreDrop = previousScore !== null ? previousScore - newScore : 0;

        // Only alert if there was a REAL previous score AND score dropped past user's threshold
        // Use explicit null check — a score of 0 is valid and should not be treated as "no previous score"
        const alertThreshold = siteUserSettings.alert_threshold || 10;
        const needsAlert = previousScore !== null && previousScore > 0 && scoreDrop >= alertThreshold;

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

        // Update user_sites so dashboard reflects the new score + trend arrows
        try {
          // Fetch existing score_history so trend arrows update correctly
          const { data: existingSite } = await sb.from('user_sites')
            .select('score_history, scan_count')
            .eq('url', site.url)
            .eq('user_id', site.user_id)
            .maybeSingle();
          
          const existingHistory = (existingSite && Array.isArray(existingSite.score_history)) 
            ? existingSite.score_history : [];
          const existingScanCount = (existingSite && existingSite.scan_count) 
            ? existingSite.scan_count : 0;
          
          // Append new score to history (keep last 10)
          const updatedHistory = [...existingHistory, { 
            score: newScore, 
            date: nowISO 
          }].slice(-10);

          await sb.from('user_sites').update({
            score: newScore,
            grade: result.grade || null,
            last_scan: nowISO,
            last_result: result,
            issues: Object.values(result.modules || {}).flatMap(m => m.issues || []),
            score_history: updatedHistory,
            scan_count: existingScanCount + 1,
            updated_at: nowISO
          }).eq('url', site.url).eq('user_id', site.user_id);

          console.log(`user_sites updated for ${site.url} — score: ${newScore}, history length: ${updatedHistory.length}`);
        } catch(usUpdateErr) {
          console.log(`user_sites update error for ${site.url}:`, usUpdateErr.message);
        }

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

        // user_sites update handled above with score_history — no duplicate needed

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

          // Save dashboard alert (respects user's dashboard_alerts setting)
          if (siteUserSettings.dashboard_alerts !== false) {
            try {
              // Skip if first scan (no real baseline)
              const isFirstScan = !site.first_scanned_at;
              
              // Deduplicate — skip if alert already exists for this site in last 24 hours
              const yesterday = new Date(Date.now() - 86400000).toISOString();
              const { data: existingAlert } = await sb.from('realtime_alerts')
                .select('id').eq('user_id', site.user_id).eq('url', site.url)
                .gte('created_at', yesterday).maybeSingle();

              if (!isFirstScan && !existingAlert) {
                await sb.from('realtime_alerts').insert({
                  user_id: site.user_id,
                  url: site.url,
                  site_name: site.name || site.url,
                  message: `Score dropped ${scoreDrop} points (from ${previousScore} to ${newScore}) on this site.`,
                  severity: scoreDrop >= 20 ? 'critical' : 'high',
                  read: false,
                  created_at: new Date().toISOString()
                });
              } else {
                console.log(`Alert skipped for ${site.url} — ${isFirstScan ? 'first scan' : 'duplicate within 24h'}`);
              }
            } catch(e) {
              console.log('Alert save error:', e.message);
            }
          }

          // Send email alert (respects user's email_alerts setting)
          if (userEmail && siteUserSettings.email_alerts !== false) {
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
      })); // end Promise.allSettled map
    } // end batch loop

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

    console.log(`Scan complete: ${scanned}/${paidSites.length} sites scanned, ${needAlerts} score-drop alerts sent`);
    console.log('Scan results summary:', results.map(r => `${r.url}: ${r.previousScore}→${r.score} (drop:${r.scoreDrop})`).join(', '));

    // Forge Agent queue: users trigger manually from the dashboard

    // Check for overdue tasks and alert creators
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: overdueTasks } = await sb.from('team_tasks')
        .select('*')
        .eq('status', 'pending')
        .lt('due_date', today)
        .not('due_date', 'is', null);

      if (overdueTasks && overdueTasks.length > 0) {
        for (const task of overdueTasks) {
          const { data: existingAlert } = await sb.from('realtime_alerts')
            .select('id')
            .eq('user_id', task.created_by)
            .ilike('message', `%overdue%${task.title}%`)
            .maybeSingle();

          if (!existingAlert) {
            await sb.from('realtime_alerts').insert({
              user_id: task.created_by,
              url: task.site_url || '',
              site_name: task.site_name || 'Task',
              message: `Task overdue: "${task.title}" — was due ${task.due_date}`,
              severity: 'high',
              read: false,
              created_at: new Date().toISOString()
            });
          }
        }
        console.log(`Overdue task alerts: ${overdueTasks.length}`);
      }
    } catch(overdueErr) {
      console.log('Overdue task check error:', overdueErr.message);
    }

    // ── SCHEDULED REPORTS ─────────────────────────────────
    try {
      const today = new Date().toISOString().split('T')[0];
      const { data: reportSites } = await sb.from('user_sites')
        .select('site_id, user_id, name, url, score, client_name, client_email, report_schedule, next_report_date')
        .eq('next_report_date', today)
        .not('report_schedule', 'is', null)
        .not('client_email', 'is', null);

      if (reportSites && reportSites.length > 0) {
        console.log('Sending scheduled reports for', reportSites.length, 'sites');
        for (const site of reportSites) {
          try {
            const { data: { users } } = await sb.auth.admin.listUsers({ perPage: 1000 });
            const owner = users && users.find(u => u.id === site.user_id);
            const agencyName = (owner && owner.user_metadata && owner.user_metadata.agency_name) || 'Forge AI';

            const { data: portal } = await sb.from('client_portals')
              .select('token').eq('user_id', site.user_id).eq('site_url', site.url).maybeSingle();
            const portalLink = portal ? 'https://forgeai-wgs.com/forge-ai-client.html?token=' + portal.token : 'https://forgeai-wgs.com';

            await fetch('https://forgeai-wgs.com/api/send-client-report', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                clientEmail: site.client_email,
                clientName: site.client_name || '',
                siteName: site.name || site.url,
                siteUrl: site.url,
                score: site.score,
                portalLink: portalLink,
                agencyName: agencyName,
                summary: '',
                userId: site.user_id,
                siteId: site.site_id
              })
            });

            // Calculate next send date based on frequency
            const nextDate = new Date(today + 'T12:00:00');
            const freq = site.report_schedule;
            if (freq === 'weekly') nextDate.setDate(nextDate.getDate() + 7);
            else if (freq === 'monthly') nextDate.setMonth(nextDate.getMonth() + 1);
            else if (freq === 'quarterly') nextDate.setMonth(nextDate.getMonth() + 3);

            await sb.from('user_sites').update({
              next_report_date: nextDate.toISOString().split('T')[0]
            }).eq('site_id', site.site_id);

            console.log('Scheduled report sent:', site.url, '| Next:', nextDate.toISOString().split('T')[0]);
          } catch(reportErr) {
            console.error('Report send error (non-fatal):', site.url, reportErr.message);
          }
        }
      }
    } catch(schedErr) {
      console.error('Scheduled reports check error (non-fatal):', schedErr.message);
    }

    return res.status(200).json({
      message: 'Scheduled scan complete',
      scanned,
      total: sites.length,
      needAlerts,
      results
    });

  } catch(err) {
    Sentry.captureException(err);
    console.error('Scheduled scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
