const { createClient } = require('@supabase/supabase-js');

// Rate limit store
const rateLimitStore = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const window = 60000;
  const max = 15; // 15 scans per minute per IP
  const record = rateLimitStore.get(ip);
  if (!record || now > record.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + window });
    return true;
  }
  if (record.count >= max) return false;
  record.count++;
  return true;
}
function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limiting
  const ip = getIp(req);
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }

  try {
    const { url, userId } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });
    
    // Validate URL
    let cleanUrl;
    try {
      cleanUrl = new URL(url.startsWith('http') ? url : 'https://' + url).toString();
    } catch(e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Validate URL format
    // Verify request - accept both user sessions and internal cron calls
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.replace('Bearer ', '');
    
    // Allow internal calls from scheduled scan using CRON_SECRET
    const isInternalCall = token === process.env.CRON_SECRET;
    
    if (!isInternalCall) {
      // Verify user session
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: { user }, error: authError } = await sb.auth.getUser(token);
      if (authError || !user) {
        return res.status(401).json({ error: 'Invalid session' });
      }
    }

    // Fetch page content server-side using multiple proxies
    let pageData = `URL: ${cleanUrl}\nAnalyze based on domain name. Be realistic and accurate.`;
    const proxies = [
      `https://api.allorigins.win/get?url=${encodeURIComponent(cleanUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(cleanUrl)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(cleanUrl)}`
    ];

    for (const proxyUrl of proxies) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const pageRes = await fetch(proxyUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (!pageRes.ok) continue;

        let html = '';
        const ct = pageRes.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const json = await pageRes.json();
          html = json.contents || '';
        } else {
          html = await pageRes.text();
        }

        if (html && html.length > 500) {
          // Parse HTML - server side we use regex since no DOMParser
          const getTag = (tag) => {
            const match = html.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
            return match ? match[1].trim() : '';
          };
          const getMeta = (name) => {
            const match = html.match(new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i')) ||
                         html.match(new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'));
            return match ? match[1].trim() : '';
          };

          const title = getTag('title');
          const metaDesc = getMeta('description') || 'MISSING';
          const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
          const imgCount = (html.match(/<img/gi) || []).length;
          const noAltCount = (html.match(/<img(?![^>]*alt=["'][^"']+["'])[^>]*>/gi) || []).length;

          // Clean text content
          const textContent = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 1500)
            .replace(/"/g, "'")
            .replace(/`/g, "'");

          pageData = `URL: ${cleanUrl}\nTitle: ${title || 'MISSING'}\nMeta Description: ${metaDesc}\nH1 Count: ${h1Count}\nImages: ${imgCount}, Missing alt: ${noAltCount}\nContent: ${textContent}`;
          break;
        }
      } catch(fetchErr) {
        // Try next proxy
      }
    }

    // Call Claude API using server-side key
    const prompt = `Analyze this website and return ONLY valid JSON with no markdown, no code blocks, no explanation.

IMPORTANT: Content may be incomplete due to JavaScript rendering. Do not penalize for items that may be JS-rendered. Be realistic and accurate in scoring.

${pageData}

Return this exact JSON structure:
{
  "overall_score": 0,
  "grade": "A",
  "site_name": "Name",
  "summary": "2-3 sentence professional summary",
  "modules": {
    "seo": {"score": 0, "issues": [], "patches": []},
    "speed": {"score": 0, "issues": [], "patches": []},
    "mobile": {"score": 0, "issues": [], "patches": []},
    "ux": {"score": 0, "issues": [], "patches": []},
    "maintenance": {"score": 0, "issues": [], "patches": []}
  },
  "patches": [],
  "critical_issues": 0,
  "high_issues": 0
}

Each module score must be 0-20. overall_score must equal the sum of all 5 module scores.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) throw new Error(claudeData.error.message);

    let raw = claudeData.content.map(c => c.text || '').join('').trim();
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse AI response');

    // Clean JSON
    let cleanedJson = '';
    for (let i = 0; i < jsonMatch[0].length; i++) {
      const c = jsonMatch[0].charCodeAt(i);
      if (c > 31 && (c < 127 || c > 159)) cleanedJson += jsonMatch[0][i];
    }
    cleanedJson = cleanedJson.replace(/,(\s*[}\]])/g, '$1');

    const result = JSON.parse(cleanedJson);

    // Always calculate score from modules
    const mods = result.modules || {};
    const seoS   = Math.min(20, Math.max(0, mods.seo?.score || 0));
    const speedS  = Math.min(20, Math.max(0, mods.speed?.score || 0));
    const mobileS = Math.min(20, Math.max(0, mods.mobile?.score || 0));
    const uxS     = Math.min(20, Math.max(0, mods.ux?.score || 0));
    const maintS  = Math.min(20, Math.max(0, mods.maintenance?.score || 0));
    const finalScore = seoS + speedS + mobileS + uxS + maintS;
    const grade = finalScore >= 90 ? 'A' : finalScore >= 80 ? 'B' : finalScore >= 70 ? 'C' : finalScore >= 60 ? 'D' : 'F';

    if (mods.seo)         mods.seo.score         = seoS;
    if (mods.speed)       mods.speed.score       = speedS;
    if (mods.mobile)      mods.mobile.score      = mobileS;
    if (mods.ux)          mods.ux.score          = uxS;
    if (mods.maintenance) mods.maintenance.score = maintS;
    result.overall_score = finalScore;
    result.grade = grade;
    result.modules = mods;

    return res.status(200).json({ success: true, result });

  } catch(err) {
    console.error('Scan error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
