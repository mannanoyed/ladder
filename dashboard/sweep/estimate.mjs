// ladder/dashboard/sweep/estimate.mjs — put a comp band on the 75% of postings that state none.
//
// Most India postings hide comp, which left three quarters of the board unfilterable and
// unrankable. Waiting for employers to disclose is not a strategy; estimating is, provided the
// estimate is always labelled as one. Every band carries a `basis` so the UI can show a guess as
// a guess — an estimate that reads as fact is worse than no estimate at all.
//
// Two tiers:
//   1. heuristic  — free, offline, applied to everything
//   2. ambitionbox — real observed salaries, cached 30 days, only for leads worth the lookup
import { all, one, run } from '../db.mjs';

// ---------------------------------------------------------------------------
// Employer model. From market research notes: "the title tells you nothing; the employer's
// business model tells you everything." Empirically confirmed on AmbitionBox — Nagarro ML
// Engineer sits at ₹9-13L while MongoDB sits at ₹20-40L for comparable work.
// ---------------------------------------------------------------------------
const SERVICES = /\b(infosys|wipro|tcs|tata consultancy|cognizant|capgemini|accenture|hcl|tech mahindra|ltimindtree|lti\b|mindtree|mphasis|persistent|zensar|nagarro|birlasoft|coforge|hexaware|cybage|sisl|sonata|happiest minds|virtusa|globallogic|luxoft|epam|iris software|xebia|thoughtworks|infogain|synechron|quinnox|incedo|damco|niit|dxc|atos|ibm|deloitte|pwc|ey\b|kpmg|genpact|wns|firstsource|concentrix|teleperformance|infotech|consulting|consultancy|solutions pvt|technologies pvt|staffing|recruit|manpower|talent|hiring|placement)\b/i;
const GLOBAL_PRODUCT = /\b(google|microsoft|amazon|meta|apple|netflix|nvidia|openai|anthropic|databricks|snowflake|mongodb|gitlab|atlassian|stripe|uber|airbnb|salesforce|adobe|oracle|sap|vmware|cisco|intuit|paypal|linkedin|twilio|datadog|elastic|confluent|hashicorp|figma|notion|canva|cohere|scale ai|hugging ?face|elevenlabs|perplexity|cursor|anysphere|sierra|glean|harvey|abridge|cognition|devin|temporal)\b/i;
const INDIAN_SCALEUP = /\b(razorpay|zerodha|cred|swiggy|zomato|flipkart|meesho|phonepe|paytm|zoho|freshworks|postman|browserstack|chargebee|darwinbox|innovaccer|highradius|sarvam|krutrim|fractal|mu sigma|tredence|quantiphi)\b/i;

/** Tells from the JD itself, for the many companies not on any list. */
const SERVICES_TELLS = /\b(client location|utilization|billable|engagement|deliver(y|ables)|staffing|deputation|onsite opportunity|shift|c2h|contract to hire|payroll|end client|our client|overlapping shifts)\b/i;
const PRODUCT_TELLS  = /\b(our product|roadmap|shape the product|product and engineering|reusable|platform team|own the|end.to.end ownership|series [a-e]\b|yc[ -]?[wsf]\d{2}|founding|equity|esop)\b/i;

export function classifyEmployer(company = '', text = '') {
  const c = String(company), t = `${company} ${text}`;
  if (GLOBAL_PRODUCT.test(c)) return 'global';
  if (INDIAN_SCALEUP.test(c)) return 'scaleup';
  if (SERVICES.test(c)) return 'services';
  const svc = (t.match(SERVICES_TELLS) || []).length;
  const prd = (t.match(PRODUCT_TELLS) || []).length;
  if (svc > prd) return 'services';
  if (prd > svc) return 'startup';
  return 'unknown';
}

// Base bands in LPA at ~2-3 yrs, India. Anchored on the disclosed datapoints in
// market research and the AmbitionBox spot-checks, not on vibes.
const BASE = {
  services: [8, 14],
  unknown:  [12, 20],
  startup:  [15, 26],
  scaleup:  [22, 38],
  global:   [30, 55],
};

const SENIOR   = /\b(senior|sr\.?|lead|staff|principal|architect|head of|manager)\b/i;
const FOUNDING = /\b(founding|founder|first engineer|member of technical staff|mts)\b/i;
const JUNIOR   = /\b(junior|jr\.?|associate|trainee|graduate|entry)\b/i;

/** Highest experience number named in a gate like "2-5 Yrs" or "5+ years". */
function gateTop(gate) {
  const nums = [...String(gate || '').matchAll(/(\d+)/g)].map(m => +m[1]).filter(n => n < 25);
  return nums.length ? Math.max(...nums) : null;
}

/**
 * Estimate a band. Returns null rather than guessing when there is genuinely nothing to go on —
 * a fabricated number on the board is worse than an honest blank.
 */
export function estimateBand({ company = '', role = '', gate_years = '', location = '', text = '' } = {}) {
  const kind = classifyEmployer(company, text);
  if (kind === 'unknown' && !role) return null;

  const [base_lo, base_hi] = BASE[kind];
  let ml = 1, mh = 1;                       // multipliers accumulate, then get damped
  const why = [kind];

  if (FOUNDING.test(role)) { ml *= 1.25; mh *= 1.45; why.push('founding'); }
  else if (SENIOR.test(role)) { ml *= 1.25; mh *= 1.30; why.push('senior title'); }
  else if (JUNIOR.test(role)) { ml *= 0.65; mh *= 0.70; why.push('junior title'); }

  const top = gateTop(gate_years);
  if (top != null) {
    if (top >= 8)      { ml *= 1.45; mh *= 1.55; why.push(`${top}y gate`); }
    else if (top >= 5) { ml *= 1.20; mh *= 1.28; why.push(`${top}y gate`); }
    else if (top <= 2) { ml *= 0.85; mh *= 0.88; why.push(`${top}y gate`); }
  }

  const loc = `${location} ${text}`;
  // "2x the high-paying postings" in Bengaluru, per market research.
  if (/bengaluru|bangalore/i.test(loc)) { ml *= 1.10; mh *= 1.12; why.push('blr'); }
  // Remote-for-global arbitrage is the single biggest lever in the intel: a US/EU company at
  // half its home band still lands at ₹40-60L.
  if (/remote/i.test(loc) && (kind === 'global' || /\b(us|usa|united states|uk|europe|emea)\b/i.test(loc))) {
    ml *= 1.35; mh *= 1.45; why.push('remote-for-global');
  }

  // Damp the stack. A senior title and a long experience gate are the same fact stated twice, so
  // multiplying them independently pushed MongoDB to ₹45-91L — roughly double what AmbitionBox
  // actually reports for it. Uplift is capped, and the whole band is capped at the real ceiling
  // for a 2-6 year IC in India.
  const CAP = 1.75;
  if (ml > CAP) ml = CAP;
  if (mh > CAP) { mh = CAP; why.push('capped'); }
  const r = n => Math.round(Math.min(n, 90) * 10) / 10;
  return { min: r(base_lo * ml), max: r(base_hi * mh), basis: `estimated: ${why.join(', ')}` };
}

// ---------------------------------------------------------------------------
// AmbitionBox — real observed salaries. Rate-limited and cached, because it is a courtesy read
// of someone else's site and 267 lookups a night is not that.
// ---------------------------------------------------------------------------
const slug = s => String(s || '').toLowerCase().trim()
  .replace(/\b(pvt|private|ltd|limited|inc|llc|technologies|technology|solutions|labs|india)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function cached(company) {
  const r = one(`SELECT value FROM kv WHERE key=? AND updated_at > datetime('now','-30 days')`,
                'ab:' + slug(company));
  return r ? JSON.parse(r.value) : undefined;
}

/** Look a company up on AmbitionBox. Returns {min,max,basis} or null; caches either way. */
export async function ambitionBox(company, newPage) {
  const key = 'ab:' + slug(company);
  const hit = cached(company);
  if (hit !== undefined) return hit;

  let result = null;
  const page = await newPage();
  try {
    await page.goto(`https://www.ambitionbox.com/salaries/${slug(company)}-salaries`, { settle: 6000 });
    const found = await page.evaluate(`
      const b = document.body; if (!b) return null;
      if (/page not found|404/i.test(document.title)) return null;
      const t = b.innerText.replace(/\\s+/g, ' ');
      // "₹27.4 L/yr - ₹30 L/yr" — collect every range the page reports, then take the middle.
      const out = [];
      const re = /₹\\s?([\\d.]+)\\s?L\\/yr\\s?[-–]\\s?₹?\\s?([\\d.]+)/gi;
      let m; while ((m = re.exec(t))) out.push([parseFloat(m[1]), parseFloat(m[2])]);
      return out.slice(0, 40);
    `);
    if (found && found.length) {
      // Median of the reported lows and highs — robust to one outlier VP row.
      const mid = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      const lo = mid(found.map(p => p[0])), hi = mid(found.map(p => p[1]));
      if (isFinite(lo) && isFinite(hi) && hi >= lo && hi < 300)
        result = { min: Math.round(lo * 10) / 10, max: Math.round(hi * 10) / 10,
                   basis: `ambitionbox: median of ${found.length} reported ranges` };
    }
  } catch { /* a miss is cached too, so a dead slug is not retried nightly */ }
  await page.close();

  run(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
      key, JSON.stringify(result));
  return result;
}


/**
 * Best available band for a lead that states none.
 *
 * AmbitionBox first, because real reported salaries for that exact company beat any inference —
 * it puts Nagarro at ₹9-13L and MongoDB at ₹20-40L, which is the product/services fork measured
 * rather than assumed. The heuristic is the fallback for companies too small or too new to have
 * reported data, which is most startups.
 */
export async function bandFor(lead, newPage, { online = true } = {}) {
  if (online) {
    const ab = await ambitionBox(lead.company, newPage).catch(() => null);
    if (ab) return ab;
  }
  return estimateBand(lead);
}
