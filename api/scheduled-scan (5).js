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

  // Respond immediately so cron doesn't timeout
  res.status(200).json({ message: 'Scan started', timestamp: new Date().toISOString() });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  try {
    // Get all active sites - deduplicated by user_id + url
    const { data: allSites, error } = await sb
      .from('scheduled_sites')
      .select('*')
      .eq('active', true);

    if (error) throw error;
    if (!allSites || allSites.length === 0) {
      console.log('No sites to scan');
      return;
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
        await sb.from('scheduled_sites').update({
          last_score: newScore,
          last_scanned: nowISO,
          has_critical: (result.critical_issues || 0) > 0
        }).eq('id', site.id);

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
    // Response already sent at top — just log completion

  } catch(err) {
    console.error('Scheduled scan error:', err.message);
    // Response already sent — just log the error
  }
};
