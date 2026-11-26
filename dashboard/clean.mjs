// ladder/dashboard/clean.mjs — the cleaning half of "load wide, clean after".
//
// The scrapers now keep everything that is not certainly junk (2026-11-02). This pass runs in the
// hunt right after they load, before reconcile and enrichment, and does three things:
//
//   1. Lane.   Every unclassified open lead gets a lane (lane.mjs). Off-lane is dropped with the
//              reason on the row: "clean: off-lane — <why>". Nothing is deleted.
//   2. Dedupe. One req seen on several channels, or on one channel under two spellings ("NewPage -
//              Forward Deployed Engineer" at "Newpage Solutions"), keeps its best row; the others
//              are dropped as "clean: duplicate of #id". UNIQUE(company, role) only catches
//              byte-identical pairs.
//   3. Undo.   Any rule's drops can be restored in one command if the rule misfired, and
//              `recheck` re-runs the lanes after lane.mjs changes, in both directions.
//
// Exempt from every drop: your focus picks, rows Claude has claimed, and routes that are a person
// (referral, inbound, direct). Not LinkedIn's "3 school alumni work here" card flag, which isWarm
// also counts: that is a path worth scoring, but it does not make a C++ role your lane.
import { all, run } from './db.mjs';
import { normKey } from './lib.mjs';
import { laneOf } from './lane.mjs';
import { companyMap, companyFor, isWarm } from './score.mjs';
import { WARM } from './recommend.mjs';

const OPEN = `status IN ('new','shortlisted')`;
const RESTORED = 'restored by hand';
const exempt = l => !!(l.focus || l.claimed_at || WARM.test(`${l.channel || ''} ${l.source || ''}`));

/** The title with the noise that differs between spellings of one req taken out. */
export function roleKey(role, company = '') {
  let r = String(role || '').toLowerCase()
    .replace(/\(verified job\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')                       // "[India]", "[Fixed Term Contract - 12 months]"
    // Req ids ("IRC302348") are KEPT: GlobalLogic posts several FDE reqs that differ only by id.
    .replace(/[|–—-]\s*(remote|hybrid|on-?site|india|bengaluru|bangalore|gurugram|gurgaon|noida|pune|hyderabad|chennai|mumbai|delhi)[^|–—-]*$/g, ' ');
  // "NewPage - Forward Deployed Engineer" at Newpage Solutions: drop a leading company name.
  const first = normKey(company).slice(0, 6);
  const m = r.match(/^([^-–|:]+)\s*[-–|:]\s*(.+)$/);
  if (m && first && normKey(m[1]).startsWith(first)) r = m[2];
  // NOT normKey: it deletes parentheticals, and on a title they are often the whole difference.
  // KPMG's "Generative AI Engineer (3-6 Years)" and "(6-10 Years)" are two reqs, and Archer's
  // "(Python Frameworks, 2-4 yrs)" collapsed into "(ASP.NET MVC, 5-7 yrs)" in the first dry run,
  // which would have dropped the in-range one.
  return r.replace(/\bsr\.?\b/g, 'senior').replace(/[^a-z0-9]/g, '');
}

/**
 * Classify and drop. `all: true` re-classifies every open row (after a lane.mjs change), not
 * just the ones never cleaned. `dry: true` reports what would happen and writes nothing.
 */
export function cleanLeads({ dry = false, everything = false } = {}) {
  companyMap(true);
  const res = { classified: 0, lanes: {}, offDropped: 0, offKept: 0, dupesDropped: 0, sample: { off: [], dupes: [] } };

  // --- 1. lanes ---
  const rows = all(`SELECT * FROM leads WHERE ${OPEN} AND (${everything ? '1' : 'lane IS NULL'})
                      AND COALESCE(lane_why,'') NOT LIKE '${RESTORED}%'`);
  for (const l of rows) {
    const { lane, why } = laneOf(l, companyFor(l.company));
    res.classified++;
    res.lanes[lane] = (res.lanes[lane] || 0) + 1;
    if (lane === 'off' && !exempt(l)) {
      res.offDropped++;
      if (res.sample.off.length < 15) res.sample.off.push(`${l.role} @ ${l.company} — ${why}`);
      if (!dry) run(`UPDATE leads SET lane='off', lane_why=?, status='dropped', dropped_reason=? WHERE id=?`,
                    why, `clean: off-lane — ${why}`, l.id);
      continue;
    }
    if (lane === 'off') res.offKept++;
    if (!dry) run('UPDATE leads SET lane=?, lane_why=? WHERE id=?', lane, why, l.id);
  }

  // --- 2. seen before: a req you (or a rule) already judged, back under another spelling ---
  // upsertLead's history checks are byte-exact on (company, role), so "Weekday AI (YC W21)" walked
  // past a "Weekday AI" row dropped at a 6+ year gate, and a req already marked
  // "Not for me" came back under a new spelling. On one hunt 37 of 493 new rows were exactly this. The old verdict carries
  // over, except for an expired req that has genuinely been reposted since (a newer posted_at).
  const judged = new Map();
  const remember = (r, from) => {
    const k = normKey(r.company) + '|' + roleKey(r.role, r.company);
    if (!r.dropped_reason || /^clean: (duplicate|seen before)/.test(r.dropped_reason)) return;
    const prev = judged.get(k);
    if (!prev || (r.id ?? 0) > (prev.id ?? 0)) judged.set(k, { ...r, from });
  };
  for (const r of all(`SELECT id, company, role, status, dropped_reason, posted_at, discovered_at FROM leads
                       WHERE status IN ('dropped','expired')`)) remember(r, r.status);
  for (const r of all(`SELECT id, company, role, archived_from status, dropped_reason, posted_at, discovered_at
                       FROM leads_archive`)) remember(r, r.status);
  for (const l of all(`SELECT * FROM leads WHERE ${OPEN} AND COALESCE(lane_why,'') NOT LIKE '${RESTORED}%'`)) {
    if (exempt(l)) continue;
    const old = judged.get(normKey(l.company) + '|' + roleKey(l.role, l.company));
    if (!old || old.id === l.id) continue;
    const expired = /expired/.test(old.status || '');
    const oldDate = old.posted_at || old.discovered_at;
    if (expired && l.posted_at && oldDate && l.posted_at > oldDate) continue;     // reposted: fresh
    res.seenBefore = (res.seenBefore || 0) + 1;
    if ((res.sample.seen ||= []).length < 10) res.sample.seen.push(`${l.role} @ ${l.company} — was ${old.status}: ${old.dropped_reason.slice(0, 70)}`);
    if (!dry) run(`UPDATE leads SET status=?, dropped_reason=? WHERE id=?`, expired ? 'expired' : 'dropped',
                  `clean: seen before (#${old.id}, ${old.status}) — ${old.dropped_reason}`, l.id);
  }

  // --- 3. cross-channel dedupe, over the whole open board ---
  // The keeper is the row you would want to act on: claimed, pinned, then warm, then the one whose
  // JD has been read, then the higher score, then the one found first.
  const groups = new Map();
  for (const l of all(`SELECT * FROM leads WHERE ${OPEN}`)) {
    const k = normKey(l.company) + '|' + roleKey(l.role, l.company);
    if (!normKey(l.company) || /^\(unknown/.test(l.company)) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(l);
  }
  const rank = l => [l.claimed_at ? 1 : 0, l.focus ? 1 : 0, isWarm(l) ? 1 : 0, l.jd_status === 'read' ? 1 : 0, l.score ?? 0, -l.id];
  const better = (a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = g.reduce((best, l) => better(l, best) ? l : best);
    for (const l of g) {
      if (l.id === keep.id || exempt(l)) continue;
      res.dupesDropped++;
      const why = `clean: duplicate of #${keep.id} (same req${l.channel !== keep.channel ? ` on ${keep.channel}` : ''})`;
      if (res.sample.dupes.length < 10) res.sample.dupes.push(`#${l.id} ${l.channel} ${l.role} @ ${l.company} → #${keep.id} ${keep.channel} ${keep.role}`);
      if (!dry) run(`UPDATE leads SET status='dropped', dropped_reason=? WHERE id=?`, why, l.id);
    }
  }
  return res;
}

/**
 * Put back what a rule dropped. `rule` is the text after "clean: " — 'off-lane' or 'duplicate'.
 * Restored rows are marked so the next clean leaves them alone: your call outranks the rule.
 */
export function undoClean({ rule = 'off-lane', since = null, dry = false } = {}) {
  const where = `status='dropped' AND dropped_reason LIKE ?` + (since ? ` AND COALESCE(last_seen_at, discovered_at) >= ?` : '');
  const args = [`clean: ${rule}%`, ...(since ? [since] : [])];
  const rows = all(`SELECT id FROM leads WHERE ${where}`, ...args);
  if (!dry) run(`UPDATE leads SET status='new', dropped_reason=NULL,
                 lane_why='${RESTORED}: ' || COALESCE(lane_why,'') WHERE ${where}`, ...args);
  return { restored: rows.length, dry };
}

/**
 * After lane.mjs changes: rows the old rules dropped as off-lane that the new rules place in a
 * lane come back, and open rows the new rules call off-lane go. Hand restores are left alone.
 */
export function recheckLanes({ dry = false } = {}) {
  companyMap(true);
  let back = 0;
  for (const l of all(`SELECT * FROM leads WHERE status='dropped' AND dropped_reason LIKE 'clean: off-lane%'`)) {
    const { lane, why } = laneOf(l, companyFor(l.company));
    if (lane === 'off') continue;
    back++;
    if (!dry) run(`UPDATE leads SET status='new', dropped_reason=NULL, lane=?, lane_why=? WHERE id=?`, lane, why, l.id);
  }
  return { restored: back, ...cleanLeads({ dry, everything: true }) };
}
