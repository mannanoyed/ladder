// ladder/dashboard/ask.mjs — what to type into an "expected CTC" field, per row.
//
// A suggestion, never an answer: `sweep/apply.mjs` still escalates every salary question to you,
// and this only puts a defensible number in front of you when you get there.
//
// The number is anchored to what THIS role pays, not to your floor. The field is a filter before
// it is a negotiation: an ask above the band gets a form screened out by someone who never reads
// the resume, and there is no later conversation to negotiate in. The floor (`floor_lpa`) is what
// you will accept, and the row flags when a role cannot reach it. That is a decision about whether
// to apply, and it should not be hidden inside the typed number.
//
// Sources, strongest first. The first one that has data wins, and every suggestion says which:
//   posted   the band on the posting                     → 75% of the way up it
//   peers    AmbitionBox, similar engineers at that co.  → 75% up what they report, never above
//   company  AmbitionBox, company-wide median            → the same, on a weaker range
//   model    the employer model in sweep/estimate.mjs    → 60% of the way up, it is a guess
import { one, settings } from './db.mjs';
import { PROFILE } from './profile.mjs';
import { estimateBand, cached as abCached } from './sweep/estimate.mjs';

const CURRENT_LPA = Number(PROFILE.currentCtcLpa) || 0;   // profile: current fixed pay, LPA
const YEARS = Number(PROFILE.yearsExperience) || 0;      // profile: experience, for AmbitionBox's ranges

// Role families. A "nearby engineer" is someone in the same family at the same company. The
// other engineering families are the fallback when the family itself has too few salaries.
const FAMILY = [
  ['fde', /forward[- ]deployed|\bfde\b|solutions? (engineer|architect)|technical solutions|customer engineer|deployment engineer|implementation engineer|field (ai )?engineer/i],
  ['ai',  /\bai\b|\bml\b|machine learning|data scientist|gen ?ai|\bllm\b|\bnlp\b|applied scientist|research engineer/i],
  ['swe', /software|\bsde\b|developer|back ?end|full ?stack|platform engineer|devops|site reliability|\bsre\b|data engineer|cloud engineer|product engineer|member of technical staff|\bmts\b/i],
];
// Bare "engineer" is not a family — it let Manufacturing Engineers stand in for software peers at
// Applied Materials. A target title that names no family is treated as software.
export const MIN_N = 5;                                           // salaries needed before peers count
const NOT_ENG = /analyst|account|sales|consultant|recruit|\bhr\b|human resource|operations|executive|designer|marketing|finance|support|test|qa\b|workday/i;
const TOO_SENIOR = /\b(manager|director|head|principal|staff|vp|lead|architect)\b/i;
const TOO_JUNIOR = /\b(intern|trainee|associate|junior|jr\.?|graduate|fresher)\b/i;
const SENIOR = /\b(senior|sr\.?)\b/i;

const familyOf = t => (FAMILY.find(([, re]) => re.test(t)) || [null])[0];
// A title with its seniority and punctuation stripped, for the exact-role match.
const bare = t => String(t).toLowerCase().replace(SENIOR, ' ').replace(/\([^)]*\)|[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const lakh = n => Math.round(n * 10) / 10;

/** Similar engineers at the company, from the AmbitionBox per-role table. */
export function peersFor(role, co) {
  // A name twin whose LinkedIn link is someone else's is not this company's pay.
  if (co?.ab_match === 'conflict') return null;
  let roles = [];
  try { roles = JSON.parse(co?.ab_roles || '[]'); } catch { /* a bad cache is no data */ }
  roles = roles.filter(r => r.min != null && r.max != null && r.n > 0);

  // The same job, when AmbitionBox has it: "Cloud Support Engineer" for "Cloud Support Engineer,
  // AI/ML (Night Shift)". Nothing is closer than that, whatever family it falls in.
  const b = bare(role);
  const exact = roles.filter(r => { const x = bare(r.role); return x.length > 5 && (b.includes(x) || x.includes(b)); });
  if (exact.reduce((s, r) => s + r.n, 0) >= MIN_N) return summarise(exact.map(r => ({ ...r, w: r.n * (SENIOR.test(r.role) && !SENIOR.test(role) ? 0.5 : 1) })), 'same-title peers');

  const fam = familyOf(role) || 'swe';
  const senior = SENIOR.test(role) || TOO_SENIOR.test(role);
  const junior = TOO_JUNIOR.test(role);
  const eng = roles
    .filter(r => !NOT_ENG.test(r.role) || /engineer|developer/i.test(r.role) && !/support|test|qa/i.test(r.role))
    .filter(r => familyOf(r.role))
    .filter(r => senior || !TOO_SENIOR.test(r.role))
    .filter(r => junior || !TOO_JUNIOR.test(r.role))
    // Senior titles are ~3-6 years at most Indian employers, so they count for a mid-level role,
    // at half weight.
    .map(r => ({ ...r, w: r.n * (SENIOR.test(r.role) && !senior ? 0.5 : 1), same: familyOf(r.role) === fam }));
  const same = eng.filter(r => r.same);
  let use = same.reduce((s, r) => s + r.n, 0) >= MIN_N ? same : eng;
  if (use.reduce((s, r) => s + r.n, 0) < MIN_N) return null;
  // Since 2026-11-02 each AmbitionBox role carries its experience range. Prefer the rows whose
  // range covers your years, when there are enough of them: an "SDE (5-10 yrs)" row is not your pay.
  const covers = use.filter(r => r.exp_min != null && r.exp_max != null && r.exp_min <= YEARS && r.exp_max >= YEARS);
  const label = use === same ? `${fam} peers` : 'engineering peers';
  if (covers.reduce((s, r) => s + r.n, 0) >= MIN_N) use = covers;
  return summarise(use, label);
}

/** n-weighted range over the chosen roles. */
function summarise(use, family) {
  const W = use.reduce((s, r) => s + r.w, 0);
  return {
    min: lakh(use.reduce((s, r) => s + r.min * r.w, 0) / W),
    max: lakh(use.reduce((s, r) => s + r.max * r.w, 0) / W),
    n: use.reduce((s, r) => s + r.n, 0), family,
    roles: [...use].sort((a, b) => b.n - a.n),
  };
}

/** Is the row's band something the employer stated? (Not an estimate, not an AmbitionBox fill.) */
function posted(row) {
  if (row.band_min_lpa == null && row.band_max_lpa == null) return null;
  const tell = `${row.band_basis || ''} ${row.band_raw || ''}`;
  if (/estimated|\(est\)|ambitionbox|cleared/i.test(tell)) return null;
  const lo = row.band_min_lpa ?? row.band_max_lpa, hi = row.band_max_lpa ?? row.band_min_lpa;
  return hi > 0 ? { min: lo, max: hi } : null;
}

/** Round to a whole lakh, the way the number is typed, without crossing the band's top. */
function typed(v, cap) {
  let r = Math.round(v);
  if (cap != null && r > cap) r = Math.floor(cap);
  return Math.max(r, 1);
}

/**
 * The suggestion for one row (a lead or an application). Returns null when there is nothing to go
 * on, because a made-up number in a salary field is worse than your own judgement.
 *   { lpa, src, basis, under, floor, hike }
 */
export function suggestAsk(row, co, s = settings()) {
  const floor = parseFloat(s.floor_lpa || 25);
  const band = posted(row);
  const peers = peersFor(row.role || '', co);
  const bits = [];
  let lpa = null, src = null;

  if (band) {
    src = 'posted';
    lpa = band.min === band.max ? typed(band.max) : typed(band.min + 0.75 * (band.max - band.min), band.max);
    bits.push(band.min === band.max ? `posted ₹${band.max}L` : `posted ₹${band.min}–${band.max}L, upper quarter, never above the top`);
    if (peers) bits.push(`${peers.family} there report ₹${peers.min}–${peers.max}L (n=${peers.n})`);
  } else if (peers) {
    src = 'peers';
    lpa = typed(peers.min + 0.75 * (peers.max - peers.min), peers.max);
    bits.push(`no band posted; ${peers.family} there report ₹${peers.min}–${peers.max}L on AmbitionBox (n=${peers.n}: ` +
              peers.roles.slice(0, 3).map(r => `${r.role} ${r.n}`).join(', ') + ')');
  } else {
    const kv = abCached(row.company) ||
      (/ambitionbox/i.test(row.band_basis || '') && row.band_max_lpa ? { min: row.band_min_lpa, max: row.band_max_lpa } : null);
    if (kv && kv.max) {
      src = 'company';
      lpa = typed(kv.min + 0.75 * (kv.max - kv.min), kv.max);
      bits.push(`no band posted; AmbitionBox company-wide median ₹${kv.min}–${kv.max}L, all roles, not just engineers`);
    } else {
      const est = estimateBand({ company: row.company, role: row.role, gate_years: row.gate_years, location: row.location });
      if (est && !/^estimated: unknown$/.test(est.basis)) {
        src = 'model';
        lpa = typed(est.min + 0.6 * (est.max - est.min), est.max);
        bits.push(`no band, no usable AmbitionBox peers; employer model says ₹${est.min}–${est.max}L (${est.basis.replace(/^estimated: /, '')}), a guess`);
      }
    }
  }
  if (lpa == null) return null;

  const under = lpa < floor;
  const hike = CURRENT_LPA ? Math.round((lpa / CURRENT_LPA - 1) * 100) : null;
  if (hike != null) bits.push(`+${hike}% on your ₹${CURRENT_LPA}L`);
  if (under) bits.push(`under your ₹${floor}L floor: decide whether to apply, don't inflate the field`);
  return { lpa, src, basis: bits.join(' · '), under, floor, hike };
}

/** What you have already typed elsewhere, so the next ask can be consistent with the last. */
export function priorAsks() {
  return one(`SELECT COUNT(*) n, MIN(lpa_min) lo, MAX(lpa_min) hi FROM comp_points WHERE kind='asked'`);
}
