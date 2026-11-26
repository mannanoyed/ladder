// ladder/dashboard/score.mjs — score model v2: five components, hard gates, and a why for each.
//
// The v1 scorer was one additive function that knew nothing about the company, nothing about the
// JD, and nothing about competition; with 800 live leads it put 1 row at 80+ and 684 under 50, so
// the board could not tell the best eight from the rest. This model scores a lead on five things
// you actually weigh — resume↔JD alignment, money, timing/competition, the company, and how the
// door was opened — each 0–100 with a confidence (measured / inferred / unknown) and its own
// signed "why" chips, then combines them with your weights (kv `w_*`, default 25/25/20/20/10).
//
// Hard gates exclude rather than score: a 4+ year minimum, a services shop, an intern title, a
// Staff/Principal/Head/Director/VP title outside a startup, abroad with no remote, past the expiry
// window on a cold route, a stated band under the discovery floor. A gated lead keeps its full
// breakdown in `score_json` (so the Leads tab can show what it would have been and why it is out)
// and sorts on `score = 0`.
//
// Everything here is pure except `persistScore`. The company map is built once per process.
import { all, one, run, settings } from './db.mjs';
import { normKey } from './lib.mjs';
import { classifyEmployer, estimateBand, cached as abCached } from './sweep/estimate.mjs';
import { titleBucket, locBucket, WARM } from './recommend.mjs';
import { gateMinYears } from './sweep/portals.mjs';
import { termHits, PROFILE } from './profile.mjs';
import { peersFor } from './ask.mjs';

// Your weights, 2026-11-02: posting date up to 30 ("date of job posting is v imp"), Company down to 10
// because AmbitionBox now puts a real number on Money, which carries most of the company signal.
export const WEIGHTS_DEFAULT = { alignment: 25, money: 25, timing: 30, company: 10, route: 10 };
export function weights(s = settings()) {
  const w = {};
  for (const k of Object.keys(WEIGHTS_DEFAULT)) {
    const v = parseFloat(s[`w_${k}`]);
    w[k] = isFinite(v) && v >= 0 ? v : WEIGHTS_DEFAULT[k];
  }
  return w;
}

const DAY = 864e5;
const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
const ageDays = ts => {
  if (!ts) return null;
  const str = String(ts);
  const t = new Date(str.replace(' ', 'T') + (str.includes('Z') || str.includes('+') ? '' : 'Z')).getTime();
  return isFinite(t) ? Math.max(0, (Date.now() - t) / DAY) : null;
};
const parseHeadcount = v => {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/(\d+)\s*(k)?/i);
  if (!m) return null;
  return +m[1] * (m[2] ? 1000 : 1);
};
const monthsAgo = ym => {
  const m = String(ym || '').match(/(\d{4})-(\d{2})/);
  if (!m) return null;
  const now = new Date();
  return (now.getUTCFullYear() - +m[1]) * 12 + (now.getUTCMonth() + 1 - +m[2]);
};

// ---------- the company map ----------
// `companies` is keyed on the curated name; leads spell the same employer three ways. One normKey
// map per process, rebuilt on demand after `company set`.
let _coMap = null;
export function companyMap(force = false) {
  if (_coMap && !force) return _coMap;
  _coMap = new Map();
  for (const c of all('SELECT * FROM companies')) _coMap.set(normKey(c.name), c);
  return _coMap;
}
export function companyFor(name) {
  return companyMap().get(normKey(name)) || null;
}

// ---------- vocabulary ----------
const SENIOR_FAMILY = /\b(staff|principal|distinguished|head|director|vp|vice president|chief|cto|cxo)\b/i;
const SENIOR_WORD   = /\b(senior|sr\.?)\b/i;
const LEAD_WORD     = /\blead\b/i;
const FOUNDING      = /\b(founding|founder|first engineer)\b/i;
const STAFFING      = /staffing|consultanc|body ?shop|recruit(ing|ment) (firm|agency)|manpower|talent solutions|talent consulting|placement/i;
const EQUITY        = /\d[\d.]*\s?%\s?[-–]\s?\d[\d.]*\s?%|\bequity\b|\besops?\b/i;
const STARTUP_STAGE = /^(pre-?seed|seed|series-?[abc]|angel)$/i;

export function isStartup(lead, co, s = settings()) {
  const maxHeads = +(s.startup_headcount_max || 500);
  const text = `${lead.role || ''} ${lead.fit_note || ''} ${lead.notes || ''} ${lead.jd_text || ''}`;
  if (co) {
    if (co.kind === 'services') return false;
    const heads = parseHeadcount(co.headcount ?? co.employees ?? co.ab_employees_india);
    if (heads != null) return heads <= maxHeads;
    if (co.yc_batch || STARTUP_STAGE.test(co.funding_stage || '')) return true;
  }
  if (/^yc(-waas)?$/.test(String(lead.channel || ''))) return true;
  if (FOUNDING.test(lead.role || '')) return true;
  if (classifyEmployer(lead.company, text) === 'startup') return true;
  return lead.channel === 'wellfound' && EQUITY.test(text);
}

// ---------- gates ----------
/** Reasons a lead is out, phrased so the Leads tab can say why. Empty array = eligible. */
export function gates(lead, co, s = settings()) {
  const g = [];
  const ceiling = +(s.gate_ceiling_years || 3);
  const role = String(lead.role || '');
  const note = `${lead.fit_note || ''} ${lead.notes || ''}`;
  const years = gateMinYears(lead.gate_years);
  if (years != null && years > ceiling) g.push({ g: 'years', t: `asks ${years}+ years, ceiling ${ceiling}` });
  if (co?.kind === 'services' || classifyEmployer(lead.company, '') === 'services' || STAFFING.test(`${lead.company} ${note}`))
    g.push({ g: 'services', t: 'services / staffing / agency' });
  if (titleBucket(role) === 'title:junior') g.push({ g: 'intern', t: 'intern / trainee title' });
  if (SENIOR_FAMILY.test(role) && !FOUNDING.test(role) && !isStartup(lead, co, s))
    g.push({ g: 'senior', t: `${role.match(SENIOR_FAMILY)[0]} title outside a startup` });
  const loc = String(lead.location || '');
  if (locBucket(loc) === 'loc:abroad' && !/remote|anywhere|distributed/i.test(loc))
    g.push({ g: 'abroad', t: 'abroad, no remote' });
  const warm = isWarm(lead);
  const age = ageDays(lead.posted_at || lead.discovered_at);
  const expiry = +(s.expiry_days || 10);
  if (!warm && !lead.focus && age != null && age > expiry)
    g.push({ g: 'expired', t: `${Math.floor(age)}d old — past the ${expiry}-day window` });
  const stated = statedBand(lead);
  const dfloor = +(s.discovery_floor_lpa || 18);
  if (stated != null && stated < dfloor) g.push({ g: 'floor', t: `stated ₹${stated}L, under the ₹${dfloor}L discovery floor` });
  if (lead.jd_status === 'closed' && !warm) g.push({ g: 'closed', t: 'posting closed' });
  // Read off the JD by the enrichment pass. A gate rather than a drop: reversible from the Leads
  // tab if the read was wrong, and the row stays visible with its reason.
  if (lead.jd_status === 'agency') g.push({ g: 'agency', t: 'JD reads as an agency fronting a client' });
  return g;
}

// A Naukri "recruiter invite" arrives by mail (`source=gmail-inbound-*`) but is a keyword blast,
// not a person who chose you; it is a recruiter route and it decays like any cold lead.
const BULK_INBOUND = /^gmail-inbound/i;
export const isWarm = lead =>
  (WARM.test(`${lead.channel || ''} ${lead.source || ''}`) && !BULK_INBOUND.test(lead.source || ''))
  || /school alum|alumni (work|here)|connections? work/i.test(lead.fit_note || '');

/** Is the band on the row an estimate (the old `bands` pass) rather than something stated? */
export const isEstimated = lead =>
  /^estimated/i.test(lead.band_basis || '') || /\(est\)/i.test(lead.band_raw || '');

/** Top of a band the employer actually stated (not an estimate), in LPA. */
function statedBand(lead) {
  const basis = String(lead.band_basis || '');
  if (basis && !/^stated/.test(basis)) return null;            // estimated / ambitionbox
  if (/\(est\)|AmbitionBox/i.test(lead.band_raw || '')) return null;
  return lead.band_max_lpa ?? lead.band_min_lpa ?? null;
}

// ---------- components ----------
export function components(lead, co, s = settings()) {
  const c = {};
  const floor = parseFloat(s.floor_lpa || 25), stretch = parseFloat(s.stretch_lpa || 40), dfloor = +(s.discovery_floor_lpa || 18);
  const role = String(lead.role || '');
  const card = `${lead.fit_note || ''} ${lead.notes || ''}`;

  // --- Alignment: what the posting names against what the resume says ---
  {
    const why = [];
    let v, conf;
    if (lead.jd_text && lead.jd_text.length > 200) {
      const h = termHits(`${role} ${lead.jd_text}`);
      v = 20 + Math.min(75, h.weight * 5);
      conf = 'measured';
      if (h.hits.length) why.push({ d: Math.min(75, h.weight * 5), t: `JD names ${h.hits.slice(0, 5).join(', ')}${h.hits.length > 5 ? ` +${h.hits.length - 5}` : ''}` });
      else why.push({ d: 0, t: 'JD names none of the resume skills' });
      if (h.penalty) { v -= h.penalty; why.push({ d: -h.penalty, t: `JD needs ${h.gaps.join(', ')} — a gap` }); }
    } else {
      conf = 'inferred';
      const tb = titleBucket(role);
      if (/forward[- ]?deploy(ed|ment)|partner[- ]deployed|\bfde\b|solutions? (engineer|architect)|deployment engineer|field (ai )?engineer|customer engineer|implementation engineer|partner (deployed|engineer)/i.test(role)) { v = 80; why.push({ d: +30, t: 'FDE / solutions title' }); }
      else if (tb === 'title:ai' || /\bai\b|agent|llm|gen ?ai|machine learning|\bml\b|founding/i.test(role)) { v = 65; why.push({ d: +15, t: 'AI / agent title' }); }
      else if (tb === 'title:nontech') { v = 20; why.push({ d: -30, t: 'not an engineering title' }); }
      else { v = 45; why.push({ d: -5, t: 'generic engineering title' }); }
      const h = termHits(card);
      if (h.hits.length) { const b = Math.min(15, h.weight * 2); v += b; why.push({ d: +b, t: `card names ${h.hits.slice(0, 4).join(', ')}` }); }
      if (h.penalty) { v -= h.penalty; why.push({ d: -h.penalty, t: `card needs ${h.gaps.join(', ')} — a gap` }); }
    }
    c.alignment = { v: clamp(v), conf, why };
  }

  // --- Money: the stated band, or the best available inference ---
  {
    const why = [];
    let top = lead.band_max_lpa ?? lead.band_min_lpa ?? null, conf = 'measured', label = null;
    const basis = String(lead.band_basis || '');
    if (top != null && /ambitionbox/i.test(`${lead.band_raw || ''} ${basis}`)) conf = 'inferred';
    // A stored estimate is a cache of an older model run, not a fact: re-estimate live so the
    // employer model's improvements reach the score, and so an `unknown` employer stays unknown.
    if (top != null && /(est\)|estimated)/i.test(`${lead.band_raw || ''} ${basis}`)) top = null;
    if (top == null) {
      conf = 'inferred';
      // Price the role, not the company: engineers like this one at this employer (ask.mjs), never
      // the median of every role on the page — that mixed managers and support staff into one
      // number. Once the resolver has looked (ab_match set), its verdict stands and the old
      // company-wide cache is not consulted; a page with too few engineers falls to the model.
      const peers = peersFor(role, co);
      const kv = co?.ab_match ? null : abCached(lead.company);
      const est = estimateBand({ company: lead.company, role, gate_years: lead.gate_years, location: lead.location, text: card });
      if (peers) { top = peers.max; label = `AmbitionBox ${peers.family} (n=${peers.n})`; }
      else if (kv && kv.max != null) { top = kv.max; label = 'AmbitionBox company-wide'; }
      else if (est && !/^estimated: unknown/.test(est.basis)) { top = est.max; label = est.basis.replace(/^estimated: /, 'est. '); }
      else conf = 'unknown';
    }
    let v;
    if (top == null) { v = 50; why.push({ d: 0, t: 'no band; employer unknown, nothing to infer from' }); }
    else {
      if (top >= stretch * 1.5) v = 100;
      else if (top >= stretch) v = 85;
      else if (top >= floor) v = 70;
      else if (top >= floor * 0.8) v = 50;
      else if (top >= dfloor) v = 35;
      else v = Math.max(5, Math.round(35 * top / dfloor));
      const band = lead.band_min_lpa != null && lead.band_max_lpa != null && lead.band_min_lpa !== lead.band_max_lpa
        ? `₹${lead.band_min_lpa}–${lead.band_max_lpa}L` : `₹${top}L`;
      const tag = top >= stretch ? 'above stretch' : top >= floor ? 'above floor' : top >= floor * 0.8 ? 'near floor' : 'under floor';
      why.push({ d: v - 50, t: conf === 'measured' ? `${band} stated — ${tag}` : `~₹${top}L ${label} — ${tag}` });
      if (/US band/i.test(lead.band_raw || '')) why.push({ d: 0, t: 'India-adjusted from a US band' });
    }
    c.money = { v: clamp(v), conf, why, top };
  }

  // --- Timing: freshness and competition ---
  {
    const why = [];
    let v, conf;
    if (isWarm(lead)) { v = 80; conf = 'measured'; why.push({ d: 0, t: 'warm route — does not decay' }); }
    else {
      const basis = lead.posted_at ? 'posted' : 'discovered';
      const age = ageDays(lead.posted_at || lead.discovered_at);
      conf = lead.posted_at ? 'measured' : 'inferred';
      if (age == null) { v = 50; conf = 'unknown'; why.push({ d: 0, t: 'no date' }); }
      else if (!lead.posted_at) {
        // The day we found it is not the day it went up: a backfill reads a week of postings in
        // one night, and every one of them looked "posted today". With no posting date the row is
        // neutral (as old as 5 days), and the days since we found it are a floor on its age.
        const d = Math.floor(age);
        v = Math.min(50, Math.max(0, 100 - 10 * d)); conf = 'unknown';
        why.push({ d: v - 50, t: `no posting date — found ${d === 0 ? 'today' : `${d}d ago`}, counted as 5d+` });
      } else {
        const d = Math.floor(age);
        v = Math.max(0, 100 - 10 * d);
        why.push({ d: v - 50, t: d === 0 ? `${basis} today` : `${basis} ${d}d ago` });
      }
      const src = String(lead.source || '');
      // The collection says so for every row it holds; search and the other collections print it
      // per card ("You'd be a top applicant"), which liLead carries into the fit note.
      if (/top-applicant/i.test(src) || /LinkedIn says top applicant/i.test(card)) { v += 15; why.push({ d: +15, t: 'LinkedIn says top applicant' }); }
      if (/actively reviewing/i.test(card)) { v += 10; why.push({ d: +10, t: 'actively reviewing applicants' }); }
      if (lead.applicants != null) {
        if (lead.applicants <= 25) { v += 15; why.push({ d: +15, t: `${lead.applicants} applicants` }); }
        else if (lead.applicants > 100) { v -= 15; why.push({ d: -15, t: `${lead.applicants} applicants` }); }
        else why.push({ d: 0, t: `${lead.applicants} applicants` });
      }
      if (/early applicant/i.test(card)) { v += 10; why.push({ d: +10, t: 'early applicant' }); }
      if (/\bpromoted\b/i.test(card)) { v -= 10; why.push({ d: -10, t: 'promoted listing' }); }
    }
    c.timing = { v: clamp(v), conf, why };
  }

  // --- Company: the funded startup you want, or a fact that says otherwise ---
  {
    const why = [];
    let v = 50, conf;
    const heads = co ? parseHeadcount(co.headcount ?? co.employees ?? co.ab_employees_india) : null;
    const recent = +(s.funding_recent_months || 24);
    if (co) {
      conf = 'measured';
      if (co.kind === 'services') { v = 10; why.push({ d: -40, t: 'services company' }); }
      else {
        if (co.target) { const b = co.target_tier === 1 ? 25 : 20; v += b; why.push({ d: +b, t: `on your target list${co.target_tier ? ` (tier ${co.target_tier})` : ''}` }); }
        const stage = String(co.funding_stage || '');
        const roundAge = monthsAgo(co.last_round_at);
        const funded = STARTUP_STAGE.test(stage) || !!co.yc_batch || (roundAge != null && roundAge <= recent);
        if (heads != null && heads >= 10 && heads <= +(s.startup_headcount_max || 500) && funded) {
          v += 25; why.push({ d: +25, t: `funded startup — ${stage || co.yc_batch || 'recent round'} · ${heads} people` });
        } else if (heads != null) {
          why.push({ d: 0, t: `${heads} people${stage ? ` · ${stage}` : ''}` });
        }
        if (co.yc_batch) { v += 15; why.push({ d: +15, t: `YC ${co.yc_batch}` }); }
        if (heads != null && heads > 5000) { v -= 10; why.push({ d: -10, t: `${heads}+ people — big company` }); }
        if (co.ab_rating != null) {
          if (co.ab_rating >= 4) { v += 5; why.push({ d: +5, t: `AmbitionBox ${co.ab_rating}/5` }); }
          else if (co.ab_rating < 3) { v -= 5; why.push({ d: -5, t: `AmbitionBox ${co.ab_rating}/5` }); }
        }
        if (heads == null && !stage && !co.yc_batch && !co.target) { conf = 'inferred'; why.push({ d: 0, t: 'known company, no size or stage on file' }); }
      }
    } else {
      conf = 'inferred';
      const kind = classifyEmployer(lead.company, card);
      if (kind === 'global') { v = 70; why.push({ d: +20, t: 'global product company' }); }
      else if (kind === 'scaleup') { v = 65; why.push({ d: +15, t: 'Indian scale-up' }); }
      else if (kind === 'startup') { v = 60; why.push({ d: +10, t: 'startup tells in the card' }); }
      else if (kind === 'services') { v = 10; why.push({ d: -40, t: 'services tells' }); }
      else { v = 50; conf = 'unknown'; why.push({ d: 0, t: 'unverified' }); }
      if (/^yc(-waas)?$/.test(String(lead.channel || ''))) { v += 15; conf = 'inferred'; why.push({ d: +15, t: 'YC company (via Work at a Startup)' }); }
      else if (/yc[ -]?[wsf]\d{2}/i.test(card)) { v += 15; conf = 'inferred'; why.push({ d: +15, t: `YC ${card.match(/yc[ -]?([wsf]\d{2})/i)[1].toUpperCase()}` }); }
      if (/series [a-e]\b/i.test(card)) { v += 10; conf = 'inferred'; why.push({ d: +10, t: card.match(/series [a-e]\b/i)[0] }); }
      if (FOUNDING.test(role)) { v += 5; why.push({ d: +5, t: 'founding role' }); }
    }
    c.company = { v: clamp(v), conf, why, startup: isStartup(lead, co, s) };
  }

  // --- Route: how the door was opened ---
  {
    const why = [];
    const ch = String(lead.channel || '').toLowerCase(), src = String(lead.source || '').toLowerCase();
    let v, t;
    if (ch === 'referral' || /referral/.test(src)) { v = 100; t = 'referral'; }
    else if (BULK_INBOUND.test(src)) { v = 65; t = 'portal recruiter invite'; }
    else if (ch === 'inbound' || ch === 'inmail' || /inbound|inmail/.test(src)) { v = 95; t = 'inbound — they reached out'; }
    else if (ch === 'direct' || ch === 'email') { v = 85; t = `${ch} — a person, not a form`; }
    else if (/hiring-in-network/.test(src)) { v = 70; t = 'hiring in your network'; }
    else if (ch === 'recruiter' || /recruiter/.test(src)) { v = 65; t = 'recruiter'; }
    else if (ch === 'linkedin') { v = 40; t = 'LinkedIn, cold'; }
    else if (['wellfound', 'yc', 'yc-waas', 'hn'].includes(ch)) { v = 35; t = `${ch} form`; }
    else { v = 30; t = `${ch || 'unknown channel'} — aggregator`; }
    why.push({ d: v - 50, t });
    if (/school alum|alumni (work|here)|connections? work/i.test(lead.fit_note || '') && v < 100) {
      v = Math.min(100, v + 15); why.push({ d: +15, t: 'alumni or connections work here' });
    }
    c.route = { v: clamp(v), conf: 'measured', why };
  }
  return c;
}

// ---------- the score ----------
const CONF_RANK = { measured: 2, inferred: 1, unknown: 0 };

export function scoreV2(lead, { co = companyFor(lead.company), s = settings() } = {}) {
  const w = weights(s);
  const c = components(lead, co, s);
  const gated = gates(lead, co, s);
  const sumW = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const weighted = Object.keys(w).reduce((a, k) => a + w[k] * c[k].v, 0) / sumW;

  // Small title and location adjustments on top of the weighted blend. Senior is a −10 penalty and
  // Lead a soft −5 (your call — those are stretches, not different jobs); the senior *family*
  // (Staff / Principal / Head …) is a gate, not a penalty, unless the company is a startup.
  const adj = [];
  const role = String(lead.role || '');
  if (SENIOR_WORD.test(role)) adj.push({ d: -10, t: 'senior title' });
  if (LEAD_WORD.test(role) && !SENIOR_FAMILY.test(role)) adj.push({ d: -5, t: 'lead title' });
  if (SENIOR_FAMILY.test(role) && !gated.some(g => g.g === 'senior')) adj.push({ d: -5, t: `${role.match(SENIOR_FAMILY)[0]} title, startup — allowed` });
  if (titleBucket(role) === 'title:nontech') adj.push({ d: -15, t: 'not an engineering title' });
  const lb = locBucket(lead.location);
  // profile.homeRegion: one of locBucket's regions ('ncr', 'blr', ...) gets a small home bonus.
  if (PROFILE.homeRegion && lb === 'loc:' + PROFILE.homeRegion) adj.push({ d: +3, t: `${PROFILE.homeRegion.toUpperCase()} — home city` });
  if (lb === 'loc:abroad' && /remote/i.test(lead.location || '')) adj.push({ d: -5, t: 'abroad, remote — timezone cost' });

  const potential = clamp(weighted + adj.reduce((a, x) => a + x.d, 0));
  const confs = Object.values(c).map(x => x.conf);
  const conf = confs.every(x => x === 'measured') ? 'measured' : confs.some(x => x === 'unknown') ? 'unknown' : 'inferred';
  return {
    v: 2, potential, ungated: potential, gated, c, adj, conf, w,
    at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
}

/** The integer the board sorts on. A gated lead sorts at 0; its breakdown says why. */
export const scoreOf = r => r.gated.length ? 0 : r.potential;

/** Compact wire form for list rows: potential, gates, the five values and their confidence. */
export function summary(r) {
  if (!r) return null;
  const k = x => x.conf[0];
  return {
    p: r.potential, g: r.gated.map(g => g.g),
    c: { a: r.c.alignment.v, m: r.c.money.v, t: r.c.timing.v, c: r.c.company.v, r: r.c.route.v },
    k: { a: k(r.c.alignment), m: k(r.c.money), t: k(r.c.timing), c: k(r.c.company), r: k(r.c.route) },
    startup: !!r.c.company.startup,
    money_top: r.c.money.top ?? null,
  };
}

/** The chips a list row or a Today pick shows: the strongest component reasons first. */
export function chips(r, max = 6) {
  const out = [];
  for (const [k, comp] of Object.entries(r.c)) for (const w of comp.why) out.push({ ...w, k });
  for (const a of r.adj) out.push({ ...a, k: 'adj' });
  return out.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, max);
}

/** Write score + score_json. Returns true when something changed (the `at` stamp is ignored). */
export function persistScore(id, r) {
  const cur = one('SELECT score, score_json FROM leads WHERE id=?', id);
  if (!cur) return false;
  const score = scoreOf(r);
  const json = JSON.stringify(r);
  const strip = j => String(j || '').replace(/,"at":"[^"]*"/, '');
  if (cur.score === score && strip(cur.score_json) === strip(json)) return false;
  run('UPDATE leads SET score=?, score_json=? WHERE id=?', score, json, id);
  return true;
}

/** Parse a stored breakdown; null when absent or from an older model. */
export function parseScore(lead) {
  if (!lead?.score_json) return null;
  try { const r = JSON.parse(lead.score_json); return r && r.v === 2 ? r : null; } catch { return null; }
}
