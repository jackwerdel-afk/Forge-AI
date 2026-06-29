const { createClient } = require('@supabase/supabase-js');

// Tier 1 — Instant permanent ban
const TIER1_PATTERNS = {
  adult: [
    /\bporn\b/i, /\bxxx\b/i, /\badult.?content\b/i, /\bnude[sd]?\b/i,
    /\bescort[s]?\b/i, /\bsex.?(site|cam|video|chat)\b/i, /\bonlyfans\b/i,
    /\bstripper[s]?\b/i, /\berotica\b/i, /\bhentai\b/i
  ],
  illegal: [
    /\bbuy.{0,10}(cocaine|heroin|meth|fentanyl|drugs)\b/i,
    /\bhuman.?traffic/i, /\bweapons?.?for.?sale\b/i,
    /\bbuy.{0,10}(ak.?47|ar.?15|pistol|gun)\b/i,
    /\bcounterfeit\b/i, /\bchild.?porn/i, /\bcsam\b/i,
    /\bcp.?site\b/i, /\billegal.?(drugs?|weapons?|firearms?)\b/i
  ],
  phishing: [
    /verify.?your.?(account|password|credit.?card|bank)/i,
    /your.?account.?has.?been.?(suspended|locked|compromised)/i,
    /click.?here.?to.?unlock.?your.?account/i,
    /free.?(iphone|gift.?card|money|bitcoin)/i
  ],
  malware: [
    /download.?virus/i, /install.?malware/i, /trojan/i,
    /ransomware/i, /spyware/i, /keylogger/i
  ]
};

// Tier 2 — Soft block with warning
const TIER2_PATTERNS = {
  gambling: [
    /\bonline.?casino\b/i, /\bbet.?(now|online|here)\b/i,
    /\bsports.?betting\b/i, /\bpoker.?(room|site|online)\b/i,
    /\bslot.?(machine|games?|online)\b/i, /\bwager\b/i,
    /\bbookmaker\b/i, /\bodds.?(calculator|comparison)\b/i
  ],
  impersonation: [
    /official.?apple.?support/i, /official.?microsoft.?support/i,
    /official.?google.?support/i, /official.?amazon.?support/i,
    /official.?paypal.?support/i, /official.?bank.?support/i,
    /irs.?official/i, /fbi.?official/i
  ]
};

// Known bad TLD patterns
const BAD_TLDS = ['.onion', '.tor2web'];

// Known malware/phishing domains (small list — in production use Google Safe Browsing API)
const KNOWN_BAD_DOMAINS = [
  'freebitcoin.win', 'cryptoscam.net', 'phishing-test.com'
];

async function checkGoogleSafeBrowsing(url) {
  try {
    if (!process.env.GOOGLE_SAFE_BROWSING_KEY) return null;
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${process.env.GOOGLE_SAFE_BROWSING_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client: { clientId: 'forgeai', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
          }
        })
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data.matches && data.matches.length > 0) {
      return { flagged: true, reason: 'Google Safe Browsing: ' + data.matches[0].threatType };
    }
    return { flagged: false };
  } catch(e) {
    return null;
  }
}

function checkUrl(url) {
  const lower = url.toLowerCase();

  // Check bad TLDs
  for (const tld of BAD_TLDS) {
    if (lower.includes(tld)) {
      return { tier: 1, category: 'illegal', reason: 'Dark web / illegal TLD detected' };
    }
  }

  // Check known bad domains
  try {
    const domain = new URL(url).hostname.toLowerCase();
    if (KNOWN_BAD_DOMAINS.some(d => domain.includes(d))) {
      return { tier: 1, category: 'malware', reason: 'Known malicious domain' };
    }
  } catch(e) {}

  return null;
}

function checkContent(html, url) {
  if (!html) return null;

  // Check Tier 1 patterns against HTML content
  for (const [category, patterns] of Object.entries(TIER1_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(html)) {
        return { tier: 1, category, reason: `${category} content detected` };
      }
    }
  }

  // Check URL itself for tier 1
  for (const [category, patterns] of Object.entries(TIER1_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(url)) {
        return { tier: 1, category, reason: `${category} content in URL` };
      }
    }
  }

  // Check Tier 2 patterns
  for (const [category, patterns] of Object.entries(TIER2_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(html) || pattern.test(url)) {
        return { tier: 2, category, reason: `${category} content detected` };
      }
    }
  }

  return null;
}

module.exports = { checkUrl, checkContent, checkGoogleSafeBrowsing };
