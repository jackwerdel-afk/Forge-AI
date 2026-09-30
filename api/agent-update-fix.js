// ── AGENT UPDATE FIX ──────────────────────────────────────────
// Allows editing the proposed_fix text on a pending agent fix.
// Only the fix owner (or a team member of the owner) may edit,
// and only while the fix is still in 'pending' status.

'use strict';
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Verify session token
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Unauthorized' });

  // Resolve owner (direct user or team member acting on behalf of agency owner)
  const { data: memberRecord } = await sb.from('team_members')
    .select('agency_id, role')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  const ownerUserId = memberRecord ? memberRecord.agency_id : user.id;

  // Validate request body
  const { fixId, proposedFix } = req.body || {};
  if (!fixId) return res.status(400).json({ error: 'Missing fixId' });
  if (typeof proposedFix !== 'string' || !proposedFix.trim()) {
    return res.status(400).json({ error: 'proposedFix must be a non-empty string' });
  }
  const cleanText = proposedFix.trim().substring(0, 300); // hard cap

  // Fetch the fix — must belong to this owner
  const { data: fix, error: fixError } = await sb.from('agent_fixes')
    .select('id, status, issue_type, site_url, site_name')
    .eq('id', fixId)
    .eq('user_id', ownerUserId)
    .single();

  if (fixError || !fix) return res.status(404).json({ error: 'Fix not found' });
  if (fix.status !== 'pending') {
    return res.status(409).json({ error: 'Only pending fixes can be edited' });
  }

  // Apply the update
  const { error: updateError } = await sb.from('agent_fixes')
    .update({ proposed_fix: cleanText })
    .eq('id', fixId);

  if (updateError) {
    console.error('agent-update-fix: update error', updateError.message);
    return res.status(500).json({ error: 'Failed to update fix' });
  }

  // Log to team activity (non-fatal)
  try {
    await sb.from('team_activity').insert({
      agency_id: ownerUserId,
      user_id: user.id,
      action: 'fix_edited',
      details: 'Edited proposed fix text: ' + (fix.issue_type || '') + ' on ' + (fix.site_url || ''),
      site_url: fix.site_url || '',
      site_name: fix.site_name || fix.site_url || ''
    });
  } catch(e) {}

  console.log('agent-update-fix: updated fix', fixId, 'for user', user.id);
  return res.status(200).json({ success: true });
};
