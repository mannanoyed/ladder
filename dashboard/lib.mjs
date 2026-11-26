// ladder/dashboard/lib.mjs — parsing, scoring, derived metrics.
import { all, one, run, settings } from './db.mjs';
import { scoreV2, scoreOf, persistScore, companyMap } from './score.mjs';

export const USD_INR = 88;   // rough; only used to normalise USD bands to LPA for ranking

/**
 * Parse a messy comp string into {min,max} in LPA (lakhs per annum, INR).
 * Handles: "₹27L–₹45L"  "Rs42-76L"  "$50K-$90K"  "₹4M–₹7.5M"  "₹1.8M–₹3.5M"
 *          "30-42 LPA"  "₹40L+"  "$150K–$200K"  "Not listed"
 * When a string has both a foreign and an INR figure ("$50K-$90K (~Rs42-76L)"),
 * the INR figure wins — it is the one the poster localised.
 */
export function parseBand(raw) {
  if (!raw) return { min: null, max: null };
  const s = String(raw).replace(/[–—]/g, '-').replace(/,/g, '');

  const inrChunks = [...s.matchAll(/(?:₹|Rs\.?|INR)\s*([\d.]+)\s*(L|M|Cr|LPA)?\s*(?:-\s*(?:₹|Rs\.?|INR)?\s*([\d.]+)\s*(L|M|Cr|LPA)?)?/gi)];
  if (inrChunks.length) {
    const m = inrChunks[inrChunks.length - 1];           // last INR mention is usually the localised one
    // A bare "₹400 - ₹500" is not ₹400 lakh. With no unit, anything from 100 to 999 is far more
    // likely an hourly or daily contract rate, and reading it as lakhs put a ₹500L ServiceNow
    // role at the very top of the board.
    if (!m[2] && !m[4] && parseFloat(m[1]) >= 100 && parseFloat(m[1]) < 1000) return { min: null, max: null };
    const unit = (m[4] || m[2] || 'L');
    const lo = toLakh(parseFloat(m[1]), m[2] || unit);
    const hi = m[3] != null ? toLakh(parseFloat(m[3]), unit) : null;
    return norm(lo, hi);
  }
  const usd = [...s.matchAll(/\$\s*([\d.]+)\s*(K|M)?\s*(?:-\s*\$?\s*([\d.]+)\s*(K|M)?)?/gi)];
  if (usd.length) {
    const m = usd[0];
    const u = (x, unit) => x * (/(m)/i.test(unit || '') ? 1e6 : /(k)/i.test(unit || '') ? 1e3 : 1);
    const lo = u(parseFloat(m[1]), m[2]) * USD_INR / 1e5;
    const hi = m[3] != null ? u(parseFloat(m[3]), m[4] || m[2]) * USD_INR / 1e5 : null;
    return norm(lo, hi);
  }
  const bare = s.match(/([\d.]+)\s*-\s*([\d.]+)\s*(?:L|LPA|lakh)/i) || s.match(/([\d.]+)\s*(?:L|LPA|lakh)/i);
  if (bare) return norm(parseFloat(bare[1]), bare[2] ? parseFloat(bare[2]) : null);
  return { min: null, max: null };
}
function toLakh(n, unit) {
  if (!isFinite(n)) return null;
  const u = (unit || 'L').toUpperCase();
  if (u === 'CR') return n * 100;
  if (u === 'M') return n * 10;            // ₹1M = 10 lakh
  return n;                                 // L / LPA
}
function norm(lo, hi) {
  if (lo != null && hi != null && hi < lo) [lo, hi] = [hi, lo];
  // A band above ₹500L is not a band — it is a raw rupee figure whose unit was lost, e.g.
  // "3323700-4062300" read as lakhs instead of rupees. Rescale rather than render ₹3323700L,
  // which sorts to the top of the board and makes the whole ranking untrustworthy.
  if (lo != null && lo > 500) { lo /= 1e5; if (hi != null) hi /= 1e5; }
  return { min: round1(lo), max: round1(hi ?? lo) };
}
const round1 = n => (n == null || !isFinite(n)) ? null : Math.round(n * 10) / 10;

/**
 * Rank a lead 0–100. Since 2026-09-12 this is score model v2 (score.mjs): five weighted components
 * with confidence and hard gates. The v1 additive scorer lived here; it leaned on the comp band,
 * which LinkedIn never publishes, so 282 of 284 LinkedIn leads collapsed into one block and the
 * board could not choose eight from eight hundred. A gated lead scores 0 — its breakdown in
 * `score_json` says what it would have been and why it is out.
 */
export function scoreLead(l) {
  return scoreOf(scoreV2(l));
}

export const ACTIVE = "status NOT IN ('rejected','withdrawn','ghosted')";
export const LIVE   = "status IN ('replied','screen','interview','offer')";
// An application that has actually left. `queued` rows are drafts the board deliberately shows
// before anything goes out, and `withdrawn` ones were killed before sending — neither is an
// attempt. Counting them as sent put "121 sent" on the header against 39 real submissions,
// reported the 120-application sprint goal as already met, and divided the reply count by 121
// so a 2.6% reply rate rendered as 0.8%.
export const SENT   = "status NOT IN ('queued','withdrawn')";

/** The scoreboard. One object, everything the header needs. */
export function scoreboard() {
  const s = settings();
  const floor = parseFloat(s.floor_lpa || 25);
  const n = (sql, ...p) => one(`SELECT COUNT(*) c FROM ${sql}`, ...p).c;
  const applications = n('applications WHERE archived=0');           // every row, drafts included
  const sent     = n(`applications WHERE archived=0 AND ${SENT}`);   // what actually left
  const queued   = n("applications WHERE archived=0 AND status='queued'");
  const replies  = n(`applications WHERE archived=0 AND ${LIVE}`);
  const screens  = n("applications WHERE archived=0 AND status IN ('screen','interview','offer')");
  const onsites  = n("applications WHERE archived=0 AND status IN ('interview','offer')");
  const offers   = n("applications WHERE archived=0 AND status='offer'");
  // Scoped to sent, for the same reason: 96 "above the floor" was mostly drafts. 15 have left.
  const aboveFloor = n(`applications WHERE archived=0 AND ${SENT} AND COALESCE(band_max_lpa,band_min_lpa) >= ?`, floor);
  const liveAboveFloor = n(`applications WHERE archived=0 AND ${LIVE} AND COALESCE(band_max_lpa,band_min_lpa) >= ?`, floor);
  const rejected = n("applications WHERE status='rejected'");
  const leadsOpen = n("leads WHERE status IN ('new','shortlisted')");
  const unread = n('notifications WHERE read_at IS NULL');
  const syl = one(`SELECT COUNT(*) total,
                          SUM(CASE WHEN level='solid' THEN 1 ELSE 0 END) solid,
                          SUM(CASE WHEN level='read'  THEN 1 ELSE 0 END) reading,
                          SUM(CASE WHEN level='gap'   THEN 1 ELSE 0 END) gaps
                   FROM syllabus_items`);
  const today = new Date().toISOString().slice(0, 10);
  const studyToday = one('SELECT COALESCE(SUM(minutes),0) m FROM study_log WHERE day=?', today).m;
  const study7 = one("SELECT COALESCE(SUM(minutes),0) m FROM study_log WHERE day >= date('now','-6 days')").m;

  return {
    settings: s, floor,
    applications, sent, queued, replies, screens, onsites, offers, rejected,
    aboveFloor, liveAboveFloor, leadsOpen, unread,
    replyRate: sent ? +(replies / sent * 100).toFixed(1) : 0,
    goals: {
      applications: +s.goal_applications, replies: +s.goal_replies,
      screens: +s.goal_screens, onsites: +s.goal_onsites, offers: +s.goal_offers,
    },
    syllabus: { ...syl, pct: syl.total ? Math.round((syl.solid / syl.total) * 100) : 0 },
    study: { today: studyToday, week: study7, goal: +s.goal_study_minutes_per_day, streak: streak() },
    sprint: sprintDays(s.sprint_start, s.sprint_end),
  };
}

function streak() {
  const days = all("SELECT DISTINCT day FROM study_log WHERE minutes>0 ORDER BY day DESC LIMIT 120").map(r => r.day);
  if (!days.length) return 0;
  const d = new Date(); let k = 0;
  const iso = x => x.toISOString().slice(0, 10);
  if (days[0] !== iso(d)) d.setDate(d.getDate() - 1);           // yesterday still counts today
  for (const day of days) { if (day !== iso(d)) break; k++; d.setDate(d.getDate() - 1); }
  return k;
}

function sprintDays(startS, endS) {
  const now = new Date(), start = new Date(startS), end = new Date(endS);
  const DAY = 864e5;
  const total = Math.max(1, Math.round((end - start) / DAY) + 1);
  const elapsed = Math.min(total, Math.max(0, Math.round((now - start) / DAY) + 1));
  const untilStart = Math.max(0, Math.ceil((start - now) / DAY));
  return { start: startS, end: endS, total, elapsed, left: total - elapsed, untilStart,
           pct: Math.round(elapsed / total * 100), started: now >= start };
}

/**
 * Tier a lead so the board can show weight instead of sixty identical rows.
 * The cut points are deliberately harsh: if everything is a priority, nothing is.
 */
// Cutoffs set from the score distribution the scorer actually produces, not from where a good
// lead ought to land. The v1 gates were 78 and 62 against a board whose highest lead scored 61 —
// so `prime` was 17 points beyond the maximum, nothing could reach `strong` on score, and 447 of
// 449 leads fell into one undifferentiated `volume` pile. Re-derived 2026-09-12 for score v2 from
// `ladder score --dry` (651 eligible: max 84, p99 79, p95 68, median 57): these give a head of
// 12 to read properly and 26 to skim. Every threshold that means "a strong lead" reads from here —
// the hunt's `good` count, the new-lead notification, the agenda's expiring rule — so re-check
// this one place if the scorer changes again: a gate above the maximum silently empties a tier.
export const CUTS = { prime: 76, strong: 70 };
export function tierOf(l) {
  const top = l.band_max_lpa ?? l.band_min_lpa;
  if (l.focus) return 'focus';
  if (l.score >= CUTS.prime) return 'prime';                // drop everything and apply properly
  if (l.score >= CUTS.strong || (top != null && top >= 40)) return 'strong';
  return 'volume';                                          // worth a fast application, not a day
}

/**
 * The ranked board. Focus-pinned first, then score. This is the view you actually asked for —
 * "show real big opportunities ranked" — so it carries the why, not just the numbers.
 */
export function opportunities(limit = 80) {
  const rows = all(`SELECT * FROM leads WHERE status IN ('new','shortlisted')
                    ORDER BY focus DESC, score DESC, COALESCE(band_max_lpa,0) DESC LIMIT ?`, limit);
  return rows.map(l => ({ ...l, tier: tierOf(l) }));
}

/**
 * Did the two jobs run, and did they work?
 *
 * The front page's whole question. It was previously unanswerable in one glance: hunt and mail
 * share a process and a sweeps table, so a mail-only failure rendered as total silence and a
 * successful hunt sat behind a card you had to interpret. A sweep row is a hunt if it reports any
 * portal channel and a mail run if it reports gmail.
 */
export function runStatus() {
  // Query each job directly rather than scanning a fixed window of recent rows. The portal pass
  // writes a row every time it runs and the mail pass only when it gets that far, so a short
  // window fills with hunts and reports the mail sweep as "never run" when it ran yesterday.
  const parse = s => { try { return JSON.parse(s.channels || '[]'); } catch { return []; } };
  const shape = s => {
    if (!s) return null;
    const ch = parse(s);
    const failed = ch.filter(c => !c.ok).map(c => `${c.channel}: ${c.note || 'failed'}`);
    return { at: s.finished_at || s.started_at, ok: !!s.ok && !failed.length,
             findings: s.findings ?? 0, channels: ch.length, failed };
  };
  const mail = one("SELECT * FROM sweeps WHERE channels LIKE '%\"gmail\"%' ORDER BY id DESC LIMIT 1");
  const hunt = one("SELECT * FROM sweeps WHERE channels IS NULL OR channels NOT LIKE '%\"gmail\"%' ORDER BY id DESC LIMIT 1");
  return { hunt: shape(hunt), mail: shape(mail) };
}

/**
 * YC's application allowance.
 *
 * Work at a Startup caps applications at about five a week. It is documented nowhere — not the
 * FAQ, not the portal, not the profile — and there is no counter in their UI; the number comes
 * from a screenshot on r/ycombinator. It is enforced only by a native dialog at submit time, so
 * without tracking it here the first sign of the wall is a send that fails for no visible reason.
 *
 * Two sources, and the observed one wins. The board's own count of recent sends is the estimate;
 * `yc_cap_hit_at`, written whenever the portal actually refuses, is the fact. They have already
 * disagreed once — four sends recorded, the fifth refused — so trusting the count alone would
 * keep walking into the wall.
 */
export const YC_WEEKLY_CAP = 5;
export function ycAllowance() {
  const sent = all(`SELECT company, role, applied_at FROM applications
                    WHERE archived=0 AND channel IN ('yc','yc-waas')
                      AND status NOT IN ('queued','withdrawn')
                      AND applied_at >= date('now','-7 days')
                    ORDER BY applied_at`);
  const queued = one(`SELECT COUNT(*) c FROM applications
                      WHERE archived=0 AND status='queued' AND channel IN ('yc','yc-waas')`).c;
  const s = settings();
  const capHitAt = s.yc_cap_hit_at || null;
  // A refusal inside the current window means zero left, whatever the count says.
  const refusedRecently = capHitAt
    && (Date.now() - new Date(capHitAt.replace(' ', 'T') + 'Z').getTime()) < 7 * 864e5;
  const byCount = Math.max(0, YC_WEEKLY_CAP - sent.length);
  const remaining = refusedRecently ? 0 : byCount;
  // The oldest send in the window is the one that ages out first, so that is when a slot returns.
  const oldest = sent[0]?.applied_at || null;
  const freesOn = oldest ? new Date(new Date(oldest + 'T00:00:00Z').getTime() + 7 * 864e5)
                             .toISOString().slice(0, 10) : null;
  return { cap: YC_WEEKLY_CAP, sentThisWeek: sent.length, remaining, queued, freesOn,
           refusedRecently: !!refusedRecently, capHitAt,
           disagrees: refusedRecently && byCount > 0 };
}

/** What the overnight sweep actually turned up, by channel. The 8am "hunt" answer. */
export function huntToday() {
  const since = "discovered_at >= datetime('now','-24 hours')";
  const byChannel = all(`SELECT COALESCE(channel,'—') channel, COUNT(*) n,
                                SUM(CASE WHEN score >= ? THEN 1 ELSE 0 END) good
                         FROM leads WHERE ${since} GROUP BY channel ORDER BY n DESC`, CUTS.strong);
  const total = byChannel.reduce((a, c) => a + c.n, 0);
  const good  = byChannel.reduce((a, c) => a + c.good, 0);
  const last = one('SELECT started_at, finished_at, findings, channels FROM sweeps ORDER BY id DESC LIMIT 1');
  // The counts alone answer "did it run". These answer "did it find anything" — which is the
  // question actually being asked at 08:00, and the one the board was failing to answer: every
  // new lead scored below the prime cut, so Today rendered the same cards as the day before.
  const fresh = all(`SELECT * FROM leads
                     WHERE status IN ('new','shortlisted') AND ${since}
                     ORDER BY score DESC, COALESCE(band_max_lpa,0) DESC LIMIT 6`)
    .map(l => ({ ...l, tier: tierOf(l) }));
  return { total, good, byChannel, fresh, lastSweep: last ?? null };
}

/**
 * The only list that should ever interrupt you: things that go stale if ignored today.
 * Ordered by cost of inaction, not by recency.
 */
export function actionQueue() {
  const out = [];
  for (const a of all(`SELECT * FROM applications WHERE archived=0 AND status IN ('replied','screen','interview','offer')
                       ORDER BY CASE status WHEN 'offer' THEN 0 WHEN 'interview' THEN 1 WHEN 'screen' THEN 2 ELSE 3 END`))
    out.push({ kind: 'reply', urgency: a.status === 'offer' ? 0 : 1, title: `${a.company} — ${a.role}`,
               why: a.next_action || `status is "${a.status}" and the ball is with you`,
               url: a.url, app_id: a.id, status: a.status });
  for (const o of all("SELECT * FROM outbox WHERE status='held' ORDER BY release_at"))
    out.push({ kind: 'outbox', urgency: 1, title: o.subject || o.kind,
               why: `sends automatically at ${o.release_at} unless you cancel`, outbox_id: o.id });
  for (const n of all("SELECT * FROM notifications WHERE read_at IS NULL AND level='urgent' ORDER BY ts DESC LIMIT 8"))
    out.push({ kind: 'urgent', urgency: 0, title: n.title, why: n.body, url: n.url, notif_id: n.id });
  return out.sort((a, b) => a.urgency - b.urgency);
}

/** Applications that have gone quiet — the follow-up queue. */
/**
 * Expire leads that are too old to be worth applying to.
 *
 * This is a PROBABILITY test, not a liveness test. The reasoning, and it is right: by the time
 * a req is ~10 days old the recruiter has already screened a stack of applicants, so a late
 * application converts badly whether or not the posting is technically still up. With ~2,500
 * results on a single Wellfound search, supply is not the constraint — attention is — so clearing
 * low-probability rows costs nothing and makes the board readable.
 *
 * Age is measured from `posted_at` when the card stated one, and only falls back to
 * `discovered_at` when it did not. That matters: a req scraped today that went up three weeks ago
 * is already cold, and ageing it from discovery would hand it a fresh week it has not earned.
 *
 * Never touches focus rows (your own picks), or anything applied/queued — those have left the
 * board. Nothing is deleted: rows move to status 'expired' carrying the reason, so the board
 * clears and the record survives.
 */
// A warm route, as SQL over a `leads` row. Warm routes do not decay on the expiry clock: the
// rule is about a cold application queue that a recruiter has already worked through; a person
// who introduced you three weeks ago is still a person, and an inbound recruiter is still a live
// contact. Both human contacts you have ever had came in this way, so these are the last rows
// that should be swept.
// `gmail-inbound-*` is a Naukri recruiter-invite mail — a keyword blast, not a person — so it
// is excluded here and scores as a recruiter route in score.mjs.
export const WARM_SQL = `LOWER(COALESCE(channel,'')) IN ('referral','direct','email','inmail','inbound')
                OR LOWER(COALESCE(source,'')) LIKE '%inmail%'
                OR (LOWER(COALESCE(source,'')) LIKE '%inbound%' AND LOWER(COALESCE(source,'')) NOT LIKE 'gmail-inbound%')
                OR LOWER(COALESCE(source,'')) LIKE '%referral%'`;

export function expireLeads({ days = 10, dryRun = false } = {}) {
  const AGE = `julianday('now') - julianday(COALESCE(posted_at, discovered_at))`;
  const where = `status IN ('new','shortlisted') AND focus = 0 AND NOT (${WARM_SQL}) AND ${AGE} >= ?`;
  const rows = all(`SELECT id, company, role, channel, posted_at, discovered_at,
                           CAST(${AGE} AS INT) AS age_days,
                           CASE WHEN posted_at IS NULL THEN 'discovered' ELSE 'posted' END AS basis
                    FROM leads WHERE ${where} ORDER BY age_days DESC`, days);
  if (dryRun) return {
    would_expire: rows.length,
    by_basis: { posted: rows.filter(r => r.basis === 'posted').length,
                discovered: rows.filter(r => r.basis === 'discovered').length },
    sample: rows.slice(0, 5).map(r => `${r.age_days}d  ${r.company} — ${r.role}`),
  };
  for (const r of rows)
    run(`UPDATE leads SET status='expired', dropped_reason=? WHERE id=?`,
        `${r.age_days} days old (from ${r.basis}) — past the ${days}-day window where an application still converts`, r.id);
  return { expired: rows.length };
}

export function stale(days = 7) {
  return all(`SELECT *, CAST(julianday('now') - julianday(COALESCE(last_activity_at, applied_at, created_at)) AS INT) AS quiet_days
              FROM applications
              WHERE archived=0 AND ${ACTIVE} AND status IN ('applied','viewed','queued')
                AND julianday('now') - julianday(COALESCE(last_activity_at, applied_at, created_at)) >= ?
              ORDER BY quiet_days DESC`, days);
}

export function touch(id, extra = {}) {
  const sets = ["updated_at=datetime('now')", "last_activity_at=datetime('now')"];
  const vals = [];
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k}=?`); vals.push(v); }
  run(`UPDATE applications SET ${sets.join(',')} WHERE id=?`, ...vals, id);
}

/** Loose company/role key so "Optifye.ai" == "Optifye" and "(client)" suffixes collapse. */
export const normKey = s => String(s || '').toLowerCase()
  .replace(/\([^)]*\)/g, ' ')                    // "SciSpace (Typeset)" -> "SciSpace"
  .replace(/\.(ai|io|com|dev|co)\b/g, ' ')       // "Optifye.ai" -> "Optifye"  (domain suffix, not the word "AI")
  .replace(/\b(technologies|technology|labs|inc|llc|ltd|pvt|private|limited|hq|the)\b/g, ' ')
  .replace(/[^a-z0-9]/g, '');

/**
 * Keep the leads board honest:
 *  - a lead you have already applied to is not a lead
 *  - a lead at a company validation marked DEAD is not a lead
 *  - rescore everything against the current floor
 */
export function reconcile() {
  // `applied` must mean sent. It used to include every non-archived row, `queued` ones included,
  // so a lead whose draft was merely written got stamped applied and vanished off the board —
  // two leads went that way with nothing ever submitted.
  //
  // There is deliberately no `queued` branch any more. Until 2026-09-12 a non-archived `queued`
  // application re-stamped its lead `queued` on every hunt, and 70 unsent drafts left over from
  // the retired outbound queue kept pulling the ten best leads on the board — the four warm
  // referral routes among them — out of every predicate that serves Today. The drafts are now
  // archived (`ladder drafts resolve`) and a lead's status is judgement this function no longer
  // touches, except to mark it applied or dead.
  const apps = all(`SELECT company, role, status FROM applications WHERE archived=0`);
  const applied = new Set(apps.filter(a => a.status !== 'queued' && a.status !== 'withdrawn')
                              .map(a => normKey(a.company) + '|' + normKey(a.role)));
  const appliedCo = new Set(apps.map(a => normKey(a.company)));
  const dead = new Set(all("SELECT name FROM companies WHERE status LIKE 'DEAD%' OR hires_in_india='NO'")
    .map(c => normKey(c.name)));

  let markedApplied = 0, markedDead = 0, rescored = 0;
  // One company map for the whole pass, and one v2 computation per lead: score and score_json
  // are written together so the board's integer and the drawer's five bars can never disagree.
  companyMap(true);
  const s = settings();
  for (const l of all('SELECT * FROM leads')) {
    const ck = normKey(l.company), rk = ck + '|' + normKey(l.role);
    if (applied.has(rk) && l.status !== 'applied') {
      run("UPDATE leads SET status='applied', claimed_at=NULL, claimed_note=NULL WHERE id=?", l.id); markedApplied++; continue;
    }
    if (dead.has(ck) && l.status !== 'dropped') {
      run(`UPDATE leads SET status='dropped', claimed_at=NULL, claimed_note=NULL,
           dropped_reason='company validated: no India hiring / board dead' WHERE id=?`, l.id);
      markedDead++; continue;
    }
    if (l.status !== 'new' && l.status !== 'shortlisted') continue;   // dead rows keep their last score
    if (persistScore(l.id, scoreV2(l, { s }))) rescored++;
  }

  // Company cooldown (added 2026-09-12). Pressing Applied on one req did nothing to the same
  // company's other reqs, so UnitedHealth came back three times under three titles and MongoDB's
  // Senior FDE resurfaced on Naukri the morning after the ABX send. A second application to a
  // company inside a month reads as spray, and it costs the most at the companies that matter.
  // Siblings are SNOOZED to applied_at + 30 days, never dropped: if the first application dies
  // they come back on their own. Pinned rows and warm routes are exempt — a referral is a person.
  let siblingsSnoozed = 0;
  const recent = all(`SELECT company, role, applied_at FROM applications
                      WHERE archived=0 AND status NOT IN ('withdrawn','queued')
                        AND applied_at >= date('now','-30 days')`);
  for (const l of all(`SELECT id, company, role, focus, channel FROM leads
                       WHERE status IN ('new','shortlisted')
                         AND (snoozed_until IS NULL OR snoozed_until <= date('now'))`)) {
    if (l.focus || ['referral', 'direct', 'email', 'inbound'].includes(l.channel)) continue;
    const ck = normKey(l.company), rk = normKey(l.role);
    const hit = recent.find(a => normKey(a.company) === ck && normKey(a.role) !== rk);
    if (!hit) continue;
    run(`UPDATE leads SET snoozed_until=date(?, '+30 days'),
         fit_note=COALESCE(fit_note,'') || ? WHERE id=?`,
        hit.applied_at, ` | cooldown: applied to ${hit.role} at this company on ${hit.applied_at}`, l.id);
    siblingsSnoozed++;
  }

  // A lead usually knows the comp band; the sent-application log usually does not.
  // Push the band across so the floor maths sees every req it should.
  let backfilled = 0;
  for (const a of all('SELECT id,company,role FROM applications WHERE archived=0 AND band_max_lpa IS NULL')) {
    const l = all('SELECT * FROM leads WHERE band_max_lpa IS NOT NULL')
      .find(x => normKey(x.company) === normKey(a.company) && normKey(x.role) === normKey(a.role));
    if (!l) continue;
    run('UPDATE applications SET band_raw=?, band_min_lpa=?, band_max_lpa=? WHERE id=?',
        l.band_raw, l.band_min_lpa, l.band_max_lpa, a.id);
    backfilled++;
  }

  // A claim says "Claude is mid-application on this row". Once the row has left the board there is
  // nothing left to be mid-application on, so the claim is released here rather than at each of the
  // half-dozen call sites that can move a lead off it. Cheap, and it means a forgotten claim can
  // never outlive its lead and sit highlighted forever.
  const claimsReleased = run(`UPDATE leads SET claimed_at=NULL, claimed_note=NULL
    WHERE claimed_at IS NOT NULL AND status NOT IN ('new','shortlisted')`).changes;

  // `queued` is not a lead status any more. A non-zero count here means something wrote it
  // again — a second door for the leak — and is worth a line in the sweep log.
  const queuedLeads = one("SELECT COUNT(*) c FROM leads WHERE status='queued'").c;
  if (queuedLeads > 0)
    process.stderr.write(`reconcile: WARNING ${queuedLeads} lead(s) at status 'queued' — that status is retired; run \`ladder drafts resolve\`\n`);
  return { markedApplied, markedDead, rescored, backfilled, queuedLeads, siblingsSnoozed, claimsReleased,
           appliedCompanies: appliedCo.size, openLeads: one("SELECT COUNT(*) c FROM leads WHERE status IN ('new','shortlisted')").c };
}

/**
 * When was each channel last checked *successfully*?
 *
 * All of these now run unattended. Gmail goes through the claude.ai connector; the portals go
 * through sweep/browser.mjs, which drives a real Chrome over the DevTools Protocol and so does
 * not depend on Claude's interactive-only Chrome bridge.
 *
 * `needsAuth` marks the three that only work once `./ladder browser login` has seeded the
 * scraping profile. They are still `auto` — the sweep really does attempt them every morning —
 * but when the session lapses they fail loudly and go red here rather than reporting zero jobs.
 */
export const CHANNELS = [
  { key: 'gmail',       label: 'Gmail',       auto: true },
  { key: 'naukri',      label: 'Naukri',      auto: true },
  { key: 'indeed',      label: 'Indeed',      auto: true },
  { key: 'glassdoor',   label: 'Glassdoor',   auto: true },
  { key: 'wellfound',   label: 'Wellfound',   auto: true, needsAuth: true },
  { key: 'yc-waas',     label: 'YC WaaS',     auto: true, needsAuth: true },
  { key: 'linkedin',    label: 'LinkedIn',    auto: true, needsAuth: true },
];

export function channelFreshness() {
  const rows = all('SELECT started_at, channels FROM sweeps WHERE channels IS NOT NULL ORDER BY id DESC LIMIT 60');
  const last = {};
  for (const r of rows) {
    let parsed; try { parsed = JSON.parse(r.channels); } catch { continue; }
    for (const c of parsed || []) {
      const k = String(c.channel || '').toLowerCase();
      if (c.ok && !last[k]) last[k] = { at: r.started_at, note: c.note || null };
    }
  }
  const hrs = at => at == null ? null
    : Math.round((Date.now() - new Date(at.replace(' ', 'T') + 'Z').getTime()) / 36e5);
  return CHANNELS.map(c => {
    const l = last[c.key];
    const h = hrs(l?.at);
    return { ...c, last: l?.at ?? null, note: l?.note ?? null, hours: h,
             stale: h == null || h > (c.auto ? 26 : 48) };
  });
}
