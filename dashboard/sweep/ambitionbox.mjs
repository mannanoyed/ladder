// ladder/dashboard/sweep/ambitionbox.mjs — company stats and per-role salaries from AmbitionBox.
//
// sweep/estimate.mjs already reads AmbitionBox for one thing: a salary band for a lead that
// states none. This reads the *company* instead, and keeps the part that actually changes a
// decision — the per-role salary table. That table is how you find out that Whatfix pays a
// Solution Engineer Rs11.3-12.7L and an SDE-II Rs26.3-36.6L: same employer, same building, half
// the money, and no job description anywhere says so.
//
// Plain HTTP since 2026-11-02, no browser. AmbitionBox answers a plain GET, and every salaries
// page carries its whole dataset as JSON in __NEXT_DATA__: the role table with experience ranges
// and salary counts, the rating breakdown, India headcount, industry, and the company's own
// LinkedIn link. The old pass drove Chrome and regex-read the rendered text, guessed the slug,
// and resolved 11 of 20; the role names came out with page furniture glued on.
//
// A courtesy read: one request at a time, a real pause between them, and everything cached on
// the row so a re-run costs nothing.
import { all, run } from '../db.mjs';
import { normKey } from '../lib.mjs';

// AmbitionBox slugs drop the corporate furniture. Kept identical to estimate.mjs on purpose —
// two different slug rules would mean two different caches for the same company.
export const slug = s => String(s || '').toLowerCase().trim()
  .replace(/\b(pvt|private|ltd|limited|inc|llc|technologies|technology|solutions|labs|india)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Some names simply are not the slug: a parenthetical, a dot-com, an agency fronting the real
// employer. Guessing wrong costs a wasted request and a false "no data", so name them.
const ALIAS = {
  'cursor (anysphere)': 'cursor',
  'gnani.ai': 'gnani-ai',
  'observe.ai': 'observe-ai',
  'procedure': 'workhero',        // Procedure is the agency; WorkHero is the employer
  'sarvam ai': 'sarvam-ai',
  'fynd': 'fynd',
  'ema': 'ema',
};

export const abSlug = name => ALIAS[String(name).toLowerCase()] ?? slug(name);

// The match key. normKey, minus the words a job board and AmbitionBox disagree on: LinkedIn says
// "KPMG India", AmbitionBox says "KPMG". Never "AI" — "Sarvam AI" is not "Sarvam Safety Equipment".
export const abKey = name => normKey(String(name || '')
  .replace(/\b(india|software|solutions|systems|services|global|group|corporation|corp|company|co)\b/gi, ' '));

/** The slug of a linkedin.com/company/<slug> URL, or null. */
export const liSlug = url => (String(url || '').match(/linkedin\.com\/company\/([^/?#]+)/i) || [])[1]?.toLowerCase() || null;
// One company often runs a global page and an India page: the lead links `lenovo`, AmbitionBox
// links `lenovoin`. A country or corporate suffix is the only difference allowed; `goteleport`
// against `teleport-logistics` still conflicts.
export const liKey = s => String(s).replace(/[-_]?(india|in|ind|global|inc|hq|official|group|corp|ltd|limited|pvt)$/, '').replace(/[^a-z0-9]/g, '');

const BASE = 'https://www.ambitionbox.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lakh = n => (n == null || n === '' || !isFinite(+n)) ? null : Math.round(+n / 1e4) / 10;

// The pace is shared by every caller in the process, so two passes cannot double the rate.
// LADDER_HTTP_FAST=1 (the tests, against a stubbed fetch) drops the pause and the backoff.
const FAST = process.env.LADDER_HTTP_FAST === '1';
let lastAt = 0;
const GAP = FAST ? [0, 0] : [1000, 2500];
async function pace() {
  const wait = lastAt + GAP[0] + Math.random() * (GAP[1] - GAP[0]) - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

/**
 * One polite GET. Never throws: { status, body }. A 429 or 403 is the site asking us to stop,
 * and the caller is told so (`blocked`) rather than having it read as "no such company".
 */
async function get(url, { json = false } = {}) {
  await pace();
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html' },
                                 signal: AbortSignal.timeout(25_000) });
    const body = r.status === 200 ? (json ? await r.json().catch(() => null) : await r.text()) : null;
    return { status: r.status, body, blocked: r.status === 429 || r.status === 403 };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  }
}

/**
 * Parse one salaries page. Returns null when the page carries no company dataset.
 * `roles[].min/max` are AmbitionBox's *typical* range (what its table prints, and what the old
 * scrape stored), so ask.mjs reads the same numbers it always did; the full spread and the
 * experience range ride along.
 */
export function parseSalaries(html, url) {
  const m = String(html || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let p;
  try { p = JSON.parse(m[1])?.props?.pageProps; } catch { return null; }
  if (!p || !p.companyHeaderData) return null;
  const h = p.companyHeaderData;
  const sections = Object.fromEntries((p.companyInfo?.overview?.sectionsList || []).map(s => [s.sectionTitle, s.sectionData]));
  const more = sections['More Information'] || {}, social = sections['social links'] || {}, extra = sections['Additional Service'] || {};
  const rt = p.reviewsAggregateData?.ratingDistribution?.data?.ratings || {};
  const roles = (p.jobProfiles || []).map(j => ({
    role: j.jobProfileName, n: +j.dataPoints || 0,
    min: lakh(j.typicalMinCtc ?? j.minCtc), max: lakh(j.typicalMaxCtc ?? j.maxCtc),
    lo: lakh(j.minCtc), hi: lakh(j.maxCtc),
    exp_min: j.minExperience != null ? +j.minExperience : null, exp_max: j.maxExperience != null ? +j.maxExperience : null,
  })).filter(r => r.role && r.min != null && r.max != null);
  const india = more.indianEmployeeCount ?? null;
  return {
    name: h.companyName || more.shortName || null,
    slug: h.urlName || more.urlName || null,
    url,
    rating: h.rating ?? rt.overallCompanyRating ?? null,
    reviews: h.reviewsCount ?? null,
    salary: rt.compensationBenefitsRating ?? null, wlb: rt.workLifeRating ?? null,
    security: rt.jobSecurityRating ?? null, culture: rt.companyCultureRating ?? null,
    promotions: rt.careerGrowthRating ?? null,
    founded: more.foundedYear || null,
    employeesIndia: india != null ? String(india) : (more.indianEmployeeCountRange || null),
    linkedin: social.linkedin || null,
    website: more.website || null,
    industry: (more.primaryIndustry || []).map(x => x.name).filter(Boolean).join(', ') || null,
    // "Product, B2B, SaaS" or "Services". Shown, never gated on: AmbitionBox files Deccan AI under
    // "IT Services & Consulting", and a hard gate on that would bury an AI product company.
    business: (extra.natureOfBusiness || []).map(x => x.name).filter(Boolean).join(', ') || null,
    closed: !!h.isClosed,
    roles,
  };
}

/** Fetch and parse `/salaries/<slug>-salaries`. { s, status, blocked }. */
export async function fetchSalaries(abslug) {
  const url = `${BASE}/salaries/${abslug}-salaries`;
  const r = await get(url);
  return { s: r.body ? parseSalaries(r.body, url) : null, status: r.status, blocked: r.blocked };
}

/** AmbitionBox's own search, the box at the top of the site. [{ name, url, reviewCount, industries }] */
export async function searchCompanies(name) {
  const r = await get(`${BASE}/api/v2/search?query=${encodeURIComponent(name)}&category=all`, { json: true });
  return { hits: (r.body?.data || []).filter(x => x.type === 'company' && x.url), blocked: r.blocked, status: r.status };
}

/**
 * Find the company's AmbitionBox page and read it. The name must match after the furniture is
 * stripped; when the lead carries a LinkedIn company link, AmbitionBox's own LinkedIn link must
 * match it too, because names collide (a logistics "Teleport" is not the SSH one).
 *
 *   match 'linkedin'  — name and LinkedIn link both agree: certain
 *   match 'name'      — the name agrees and there was no link to compare: probable
 *   match 'conflict'  — the name agrees, the LinkedIn link does not: stored for a look, never scored
 *   match 'none'      — nothing on AmbitionBox under that name
 * `blocked` means the site refused us, which is "could not look", not "none".
 */
export async function resolveCompany(name, { linkedinSlug = null } = {}) {
  const want = abKey(name);
  if (!want || want.length < 2) return { match: 'none', why: 'name too short to match' };
  const judge = s => {
    if (!s || abKey(s.name) !== want) return null;
    const theirs = liSlug(s.linkedin);
    if (linkedinSlug && theirs) return liKey(theirs) === liKey(linkedinSlug) ? 'linkedin' : 'conflict';
    return 'name';
  };
  const tried = new Set();
  let conflict = null;

  // 1. The slug guess: one request, and right for most companies.
  const g = await fetchSalaries(abSlug(name));
  if (g.blocked) return { match: 'blocked', status: g.status };
  tried.add(abSlug(name));
  const gj = judge(g.s);
  if (gj && gj !== 'conflict') return { match: gj, s: g.s };
  if (gj === 'conflict') conflict = g.s;

  // 2. The search API. Exact keys only, most-reviewed first, at most two page reads.
  const q = await searchCompanies(name);
  if (q.blocked) return { match: 'blocked', status: q.status };
  const hits = q.hits.filter(x => abKey(x.name) === want && !tried.has(x.url))
                     .sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0)).slice(0, 2);
  for (const x of hits) {
    const r = await fetchSalaries(x.url);
    if (r.blocked) return { match: 'blocked', status: r.status };
    tried.add(x.url);
    const j = judge(r.s);
    if (j && j !== 'conflict') return { match: j, s: r.s };
    if (j === 'conflict' && !conflict) conflict = r.s;
  }
  return conflict ? { match: 'conflict', s: conflict } : { match: 'none', tried: [...tried] };
}

/** Write one read onto the company row. A miss still stamps `ab_checked_at`, so an empty column
 *  reads as "checked, nothing there" and not "not done". Only fields the page carried are
 *  written, so a thin page never blanks what an earlier read found. */
export function saveSalaries(id, res) {
  const s = res?.s;
  if (s && res.match !== 'conflict') {
    run(`UPDATE companies SET ab_rating=COALESCE(?, ab_rating), ab_reviews=COALESCE(?, ab_reviews),
           ab_salary_rating=COALESCE(?, ab_salary_rating), ab_wlb=COALESCE(?, ab_wlb),
           ab_job_security=COALESCE(?, ab_job_security), ab_culture=COALESCE(?, ab_culture),
           ab_promotions=COALESCE(?, ab_promotions), ab_founded=COALESCE(?, ab_founded),
           ab_employees_india=COALESCE(?, ab_employees_india), ab_roles=?, ab_url=?,
           ab_match=?, ab_linkedin=?, ab_industry=?, ab_business=?,
           ab_checked_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
        s.rating, s.reviews, s.salary, s.wlb, s.security, s.culture, s.promotions,
        s.founded, s.employeesIndia, JSON.stringify(s.roles || []), s.url,
        res.match, s.linkedin, s.industry, s.business, id);
  } else if (s) {
    // A name twin with someone else's LinkedIn link: kept for a look, used for nothing.
    run(`UPDATE companies SET ab_match='conflict', ab_url=?, ab_linkedin=?, ab_checked_at=datetime('now'),
           updated_at=datetime('now') WHERE id=?`, s.url, s.linkedin, id);
  } else {
    run(`UPDATE companies SET ab_match=?, ab_checked_at=datetime('now') WHERE id=?`, res?.match || 'none', id);
  }
}

/** The company row for a name, created when there is none (the same way enrich does). */
async function companyId(name) {
  const { companyMap } = await import('../score.mjs');
  const co = companyMap().get(normKey(name));
  return co?.id ?? Number(run(`INSERT INTO companies (name) VALUES (?)`, name).lastInsertRowid);
}

// An agency is not the employer; its AmbitionBox page describes recruiters' salaries.
export const AGENCY_NAME = /\(via |\bclient:|consult|staffing|talent|recruit/i;

const fresh = (co, days = 30) => co?.ab_checked_at && co.ab_match !== 'blocked'
  && Date.parse(co.ab_checked_at.replace(' ', 'T') + 'Z') > Date.now() - days * 864e5;

/** The best LinkedIn company slug any lead row holds for this company. */
function linkedinFor(name) {
  const r = all(`SELECT company_url FROM leads WHERE company=? AND company_url LIKE '%linkedin.com/company/%' LIMIT 1`, name)[0];
  return r ? liSlug(r.company_url) : null;
}

/**
 * Settle the 'name' matches once a lead carries the company's LinkedIn link. The JD reads and the
 * AmbitionBox reads run side by side, so a company is often priced before its JD gave up the link;
 * this compares the link on the lead with the one AmbitionBox lists, already on the row. Local
 * only, no request. Returns the companies whose match changed.
 */
export function verifyMatches({ dry = false } = {}) {
  const out = { linkedin: 0, conflict: 0, changed: [] };
  for (const co of all(`SELECT id, name, ab_linkedin FROM companies WHERE ab_match='name' AND ab_linkedin IS NOT NULL`)) {
    const mine = linkedinFor(co.name), theirs = liSlug(co.ab_linkedin);
    if (!mine || !theirs) continue;
    const m = liKey(mine) === liKey(theirs) ? 'linkedin' : 'conflict';
    out[m]++; out.changed.push({ company: co.name, match: m, lead: mine, ambitionbox: theirs });
    if (!dry) run(`UPDATE companies SET ab_match=?, updated_at=datetime('now') WHERE id=?`, m, co.id);
  }
  return out;
}

/**
 * Resolve and save a list of companies, in order. Stops when the site starts refusing (three
 * blocked answers in a row) or the budget runs out, and says which. `onEach(name, res)` runs after
 * every company, dry or not — the sort step rescores that company's leads there, or previews them.
 */
export async function refreshCompanies(names, { dry = false, budgetMs = Infinity, log = () => {}, onEach = () => {} } = {}) {
  const out = { checked: 0, linkedin: 0, name: 0, conflict: 0, none: 0, blocked: 0, stopped: null, rows: [] };
  const deadline = Date.now() + budgetMs;
  let strikes = 0;
  for (const name of names) {
    if (Date.now() > deadline) { out.stopped = 'budget'; break; }
    const res = await resolveCompany(name, { linkedinSlug: linkedinFor(name) });
    out.checked++;
    out[res.match] = (out[res.match] || 0) + 1;
    const roles = res.s?.roles?.length ?? 0;
    out.rows.push({ company: name, match: res.match, ab: res.s?.name ?? null, url: res.s?.url ?? null, roles });
    log(`${name.slice(0, 32).padEnd(33)} ${res.match.padEnd(8)} ${res.s ? `${res.s.name} · ${roles} roles · ${res.s.url}` : ''}`);
    if (res.match === 'blocked') {
      if (++strikes >= 3) { out.stopped = `AmbitionBox refused 3 in a row (HTTP ${res.status})`; break; }
      if (!FAST) await sleep(30_000 * strikes);
      continue;
    }
    strikes = 0;
    if (!dry) saveSalaries(await companyId(name), res);
    await onEach(name, res);
  }
  if (!dry) { const { companyMap } = await import('../score.mjs'); companyMap(true); }
  return out;
}

/**
 * Per-role salaries for the companies you are actually in play with, for the expected-CTC column
 * (ask.mjs). Threads that answered first, then the newest sends, then the best open leads.
 * Companies checked in the last 30 days are skipped, hit or miss, so a re-run only costs the new
 * ones. `newPage` is accepted and ignored: this no longer needs a browser.
 */
export async function refreshForAsk({ limit = 25, log = () => {} } = {}) {
  const { companyMap } = await import('../score.mjs');
  const names = all(`
    SELECT company, MIN(p) p, MAX(k) k FROM (
      SELECT company, 0 p, 0 k FROM applications WHERE archived=0
        AND status IN ('replied','screen','interview','assessment','offer')
      UNION ALL
      SELECT company, 1 p, julianday(COALESCE(applied_at, created_at)) k FROM applications
        WHERE archived=0 AND status='applied'
      UNION ALL
      SELECT company, 2 p, score k FROM leads WHERE status IN ('new','shortlisted') AND score >= 50
    ) GROUP BY company ORDER BY p, k DESC`).map(r => r.company);
  const map = companyMap(true), todo = [], seen = new Set();
  for (const name of names) {
    const k = normKey(name);
    if (!k || seen.has(k) || AGENCY_NAME.test(name)) continue;
    seen.add(k);
    if (fresh(map.get(k))) continue;
    todo.push(name);
    if (todo.length >= limit) break;
  }
  const r = await refreshCompanies(todo, { log });
  return r.rows.map(x => ({ company: x.company, ok: x.match === 'linkedin' || x.match === 'name', roles: x.roles }));
}

/** Refresh every target company. Sequential and paced on purpose. */
export async function refreshTargets({ only = null, log = () => {} } = {}) {
  const rows = all(`SELECT name FROM companies WHERE target=1 ${only ? 'AND name=?' : ''} ORDER BY target_tier, name`,
                   ...(only ? [only] : []));
  const r = await refreshCompanies(rows.map(x => x.name), { log });
  return r.rows.map(x => ({ company: x.company, ok: x.match === 'linkedin' || x.match === 'name', roles: x.roles }));
}
