// ladder/dashboard/analytics.mjs — the real numbers behind the funnel.
//
// The rule this whole file obeys: **never print a rate without its sample size.** A 50% reply rate
// off 4 sends and a 50% reply rate off 400 are different facts, and a dashboard that renders them
// identically is worse than one that shows nothing. Every derived rate here carries `n`, a Wilson
// confidence interval, and an `enough` flag; the UI greys out and says what is still missing
// rather than inventing precision.
//
// That matters more than usual right now: 69 sends have produced 3 live threads, 47 of those sends
// were never scored, and there are 0 offers. Most of these panels are therefore scaffolding that
// fills in as the funnel runs — which is the point. You cannot start measuring the day you need
// the answer.
import { all, one } from './db.mjs';

// ---------- statistics ----------

/**
 * Wilson score interval — the honest way to put error bars on a proportion.
 *
 * The naive interval (p ± 1.96·√(p(1−p)/n)) collapses to ±0 when k=0, so 0 replies off 21 sends
 * would render as "0%, certain", which is exactly backwards: 21 sends is not enough to conclude
 * a channel is dead. Wilson keeps a sane upper bound at the extremes.
 */
export function wilson(k, n, z = 1.96) {
  if (!n) return { p: 0, lo: 0, hi: 1, n: 0 };
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const halfWidth = (z / d) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { p, lo: Math.max(0, c - halfWidth), hi: Math.min(1, c + halfWidth), n };
}

/** A rate plus everything needed to decide whether to believe it. */
function rate(k, n, minN) {
  const w = wilson(k, n);
  return {
    k, n, pct: n ? +(k / n * 100).toFixed(1) : null,
    lo: +(w.lo * 100).toFixed(1), hi: +(w.hi * 100).toFixed(1),
    enough: n >= minN,
    need: n >= minN ? null : `${minN - n} more`,
  };
}

const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : +((s[m - 1] + s[m]) / 2).toFixed(1);
};
const pctl = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const SENT = "status NOT IN ('queued','withdrawn')";
const LIVE = "status IN ('replied','screen','interview','offer')";

// ---------- 1. the funnel, as conversion rather than counts ----------
//
// Counts say where things are. Rates say where they *stop*, which is the only thing you can act
// on. Each step is measured against the step before it, so a bad number localises the problem.
export function funnelConversion() {
  const n = (sql, ...p) => one(`SELECT COUNT(*) c FROM ${sql}`, ...p).c;
  const scraped   = n("leads WHERE status IN ('new','shortlisted')");
  // Both tables. Purging expired and dropped rows into `leads_archive` must not make the funnel
  // look better — "36 of 828" would flatter the board by hiding every lead that died.
  const everFound = n('leads') + n('leads_archive');
  const sent      = n(`applications WHERE archived=0 AND ${SENT}`);
  // A third of sends never passed through the board at all — they were typed straight in off a
  // portal (18 naukri, 9 linkedin at the time of writing). Dividing *all* sends by leads-found
  // therefore overstates how much of the board gets worked: it credits the funnel with
  // applications the funnel never supplied. Count only the sends that trace back to a lead.
  const sentFromLead = one(`SELECT COUNT(*) c FROM applications a WHERE a.archived=0 AND a.${SENT}
    AND EXISTS (SELECT 1 FROM leads l WHERE lower(l.company)=lower(a.company)
                AND lower(l.role)=lower(a.role))`).c;
  const sentDirect = sent - sentFromLead;
  const live      = n(`applications WHERE archived=0 AND ${LIVE}`);
  const assessed  = n("applications WHERE archived=0 AND status IN ('screen','interview','offer')");
  const interview = n("applications WHERE archived=0 AND status IN ('interview','offer')");
  const offer     = n("applications WHERE archived=0 AND status='offer'");
  const expired   = n("leads WHERE status='expired'");
  const dropped   = n("leads WHERE status='dropped'");

  return {
    counts: { everFound, scraped, expired, dropped, sent, sentFromLead, sentDirect,
              live, assessed, interview, offer },
    steps: [
      { from: 'Found',      to: 'Applied',    ...rate(sentFromLead, everFound, 50),
        note: `of everything the hunt found, how much was worth sending — ${sentDirect} further sends went straight from a portal and never touched the board` },
      { from: 'Applied',    to: 'Replied',    ...rate(live, sent, 30),
        note: 'the number that decides how much volume you need' },
      { from: 'Replied',    to: 'Assessment', ...rate(assessed, live, 5),
        note: 'does a conversation turn into a process' },
      { from: 'Assessment', to: 'Interview',  ...rate(interview, assessed, 3) },
      { from: 'Interview',  to: 'Offer',      ...rate(offer, interview, 3) },
    ],
  };
}

// ---------- 2. routes — the question "where do live threads actually come from" ----------
//
// Channel is too granular to answer it: `direct` and `referral` are the same *kind* of motion (a
// named human already knows the application is coming) and behave nothing like an aggregator.
export const ROUTE_OF = ch => {
  if (/referral|inbound|inmail/i.test(ch || '')) return 'warm';
  if (/direct|email/i.test(ch || '')) return 'direct';
  if (/linkedin|wellfound|yc|instahyre|hirist|cutshort/i.test(ch || '')) return 'platform';
  return 'aggregator';                       // naukri, indeed, glassdoor, foundit, hn, internshala
};
const ROUTE_LABEL = {
  warm: 'Warm intro', direct: 'Direct to company',
  platform: 'Product job board', aggregator: 'Aggregator',
};
const ROUTE_NOTE = {
  warm: 'a person introduced you or reached out first',
  direct: 'straight to the company, no intermediary',
  platform: 'Wellfound, YC, LinkedIn, Instahyre — startup-facing boards',
  aggregator: 'Naukri, Indeed, Glassdoor, foundit — volume boards',
};

export function routes() {
  const rows = all(`SELECT COALESCE(channel,'—') channel, status FROM applications
                    WHERE archived=0 AND ${SENT}`);
  const agg = {};
  for (const r of rows) {
    const k = ROUTE_OF(r.channel);
    (agg[k] ||= { route: k, label: ROUTE_LABEL[k], note: ROUTE_NOTE[k], sent: 0, live: 0, channels: new Set() });
    agg[k].sent++;
    agg[k].channels.add(r.channel);
    if (['replied', 'screen', 'interview', 'offer'].includes(r.status)) agg[k].live++;
  }
  return Object.values(agg)
    .map(r => ({ ...r, channels: [...r.channels].sort(), ...rate(r.live, r.sent, 10) }))
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.sent - a.sent);
}

// ---------- 3. per-platform, with latency ----------
export function platforms() {
  const rows = all(`SELECT COALESCE(channel,'—') channel, status, applied_at, last_activity_at
                    FROM applications WHERE archived=0 AND ${SENT}`);
  const agg = {};
  for (const r of rows) {
    const k = r.channel;
    (agg[k] ||= { channel: k, route: ROUTE_OF(k), sent: 0, live: 0, deep: 0, rejected: 0, lat: [] });
    const a = agg[k];
    a.sent++;
    if (['replied', 'screen', 'interview', 'offer'].includes(r.status)) {
      a.live++;
      // Latency is only meaningful where both timestamps exist. It is an upper bound: the last
      // activity may be a later message in the thread rather than the first answer.
      if (r.applied_at && r.last_activity_at) {
        const d = (new Date(r.last_activity_at) - new Date(r.applied_at)) / 864e5;
        if (d >= 0 && d < 200) a.lat.push(Math.round(d));
      }
    }
    if (['screen', 'interview', 'offer'].includes(r.status)) a.deep++;
    if (r.status === 'rejected') a.rejected++;
  }
  return Object.values(agg)
    .map(a => ({ ...a, ...rate(a.live, a.sent, 15), medianDays: median(a.lat), latN: a.lat.length }))
    .sort((a, b) => b.live - a.live || b.sent - a.sent);
}

// ---------- 4. why leads die — the rejection-reason taxonomy ----------
//
// `dropped_reason` is written by the judge in prose, but it is prose from a small number of
// templates, so it buckets cleanly. Order matters: an experience-gate reason also mentions the
// profile, and a stale reason also mentions the window, so the most specific test runs first.
const DEATH_RULES = [
  // First: "clean: off-lane — "Intern" title" would otherwise file under 'title'. Written by clean.mjs.
  ['lane',         /^clean: off-lane/i,                                      'Not in your lanes',
    'no FDE, AI-workflow, AI-generalist or ML signal in the title, company or posting'],
  ['stale',        /days? old|past the .* window|too old/i,                 'Went stale before you applied',
    'the posting aged out of the window where an application still converts'],
  ['experience',   /experience gate|gate is \d|years against/i,             'Experience gate too high',
    'the req asks for more years than the profile has — not a stretch, out of range'],
  ['title',        /title is out of band|senior\/lead\/architect|intern|trainer/i, 'Title out of band',
    'too senior (lead/architect) or too junior (intern) for the lane'],
  ['services',     /services|staffing|consultanc|body ?shop|agency|manpower/i, 'Services or staffing firm',
    'sells people rather than a product, and prices you accordingly'],
  ['geo',          /global listing|location|slug|geo|relocat/i,             'Wrong geography',
    'not reachable from your city, or the board served a worldwide list'],
  ['closed',       /closed|no longer|expired posting|filled/i,              'Posting already closed',
    'the req was gone by the time it was read'],
  ['duplicate',    /duplicate|already/i,                                    'Duplicate',
    'the same req reached the board twice'],
  ['band',         /band|salary|comp|below the floor|₹/i,                   'Below the comp floor',
    'the posted band sits under the floor'],
];

export function leadDeaths() {
  // Dead leads live in `leads_archive` now; the live table only holds anything dropped since the
  // last purge. Reading both keeps this panel correct across the migration in either direction.
  const rows = all(`SELECT dropped_reason r, COALESCE(archived_from, status) status
                    FROM leads_archive WHERE dropped_reason IS NOT NULL
                    UNION ALL
                    SELECT dropped_reason r, status FROM leads
                    WHERE status IN ('dropped','expired') AND dropped_reason IS NOT NULL`);
  const buckets = new Map();
  for (const { r, status } of rows) {
    const hit = DEATH_RULES.find(([, re]) => re.test(r));
    const key = hit ? hit[0] : 'other';
    const b = buckets.get(key) || {
      key, label: hit ? hit[2] : 'Other / unclassified',
      note: hit ? hit[3] : 'reasons that did not match a known pattern',
      n: 0, expired: 0, dropped: 0, sample: r,
    };
    b.n++;
    // archived_from also carries 'queued-cold', which is an expiry by another name.
    if (status === 'dropped') b.dropped++; else b.expired++;
    buckets.set(key, b);
  }
  const total = rows.length;
  const unlabelled = one(`SELECT
      (SELECT COUNT(*) FROM leads_archive WHERE dropped_reason IS NULL)
    + (SELECT COUNT(*) FROM leads WHERE status IN ('dropped','expired') AND dropped_reason IS NULL) c`).c;
  return {
    total, unlabelled,
    buckets: [...buckets.values()]
      .map(b => ({ ...b, pct: total ? +(b.n / total * 100).toFixed(1) : 0 }))
      .sort((a, b) => b.n - a.n),
  };
}

/** Application-level rejections — an actual company saying no, which is a different fact. */
export function rejections() {
  const rows = all(`SELECT company, role, channel, band_min_lpa, band_max_lpa, notes,
                           applied_at, last_activity_at
                    FROM applications WHERE archived=0 AND status='rejected'`);
  const withDays = rows.map(r => {
    let days = null;
    if (r.applied_at && r.last_activity_at)
      days = Math.round((new Date(r.last_activity_at) - new Date(r.applied_at)) / 864e5);
    // The judge records "Rejected <iso>" inside the note when the mail sweep sees one, which is
    // often the only timestamp there is.
    const m = /Rejected (\d{4}-\d{2}-\d{2})/.exec(r.notes || '');
    if (days == null && m && r.applied_at)
      days = Math.round((new Date(m[1]) - new Date(r.applied_at)) / 864e5);
    return { company: r.company, role: r.role, channel: r.channel, days,
             band: r.band_max_lpa ?? r.band_min_lpa };
  });
  const ds = withDays.map(r => r.days).filter(d => d != null && d >= 0);
  return { rows: withDays, n: rows.length, medianDays: median(ds), dayN: ds.length,
           // Silence is the real outcome, not rejection — worth stating next to it.
           silent: one(`SELECT COUNT(*) c FROM applications WHERE archived=0
                        AND status IN ('applied','viewed')`).c };
}

// ---------- 5. is the score worth anything? ----------
//
// The board ranks 993 rows by `potential`. If potential does not predict a reply, that ranking is
// decoration. This is the panel that finds out — and right now it says "not yet", which is a real
// answer and the reason `fit_score` should get filled in on every send.
export function calibration() {
  const rows = all(`SELECT fit_score s, status FROM applications WHERE archived=0 AND ${SENT}`);
  const defs = [
    ['90+',    s => s >= 90], ['80–89', s => s >= 80 && s < 90],
    ['70–79',  s => s >= 70 && s < 80], ['60–69', s => s >= 60 && s < 70],
    ['under 60', s => s < 60],
  ];
  const scored = rows.filter(r => r.s != null);
  const buckets = defs.map(([label, test]) => {
    const inB = scored.filter(r => test(r.s));
    const live = inB.filter(r => ['replied', 'screen', 'interview', 'offer'].includes(r.status)).length;
    return { label, ...rate(live, inB.length, 12) };
  });
  return {
    buckets, scored: scored.length, unscored: rows.length - scored.length, total: rows.length,
    // Below this there is no point drawing a trend line through five points.
    usable: scored.length >= 40,
  };
}

/** Does the posted band predict a reply? Same question, different feature. */
export function bandEffect() {
  const rows = all(`SELECT COALESCE(band_max_lpa,band_min_lpa) b, status
                    FROM applications WHERE archived=0 AND ${SENT}`);
  const defs = [['₹40L+', b => b >= 40], ['₹25–40L', b => b >= 25 && b < 40],
                ['₹15–25L', b => b >= 15 && b < 25], ['under ₹15L', b => b < 15]];
  const known = rows.filter(r => r.b != null);
  return {
    buckets: defs.map(([label, test]) => {
      const inB = known.filter(r => test(r.b));
      const live = inB.filter(r => ['replied', 'screen', 'interview', 'offer'].includes(r.status)).length;
      return { label, ...rate(live, inB.length, 12) };
    }),
    known: known.length, unknown: rows.length - known.length,
  };
}

// ---------- 6. how long an answer takes, and when to stop waiting ----------
export function latency() {
  const rows = all(`SELECT applied_at a, last_activity_at l FROM applications
                    WHERE archived=0 AND ${LIVE} AND applied_at IS NOT NULL AND last_activity_at IS NOT NULL`);
  const days = rows.map(r => Math.round((new Date(r.l) - new Date(r.a)) / 864e5))
                   .filter(d => d >= 0 && d < 200);

  // The waiting side: how long the silent ones have been silent. Together these answer "is this
  // still alive or am I holding a corpse".
  const openAges = all(`SELECT CAST(julianday('now') - julianday(applied_at) AS INT) d
                        FROM applications WHERE archived=0 AND status IN ('applied','viewed')
                        AND applied_at IS NOT NULL`).map(r => r.d);
  const maxObserved = days.length ? Math.max(...days) : null;
  return {
    n: days.length, days,
    median: median(days), p90: pctl(days, 0.9), max: maxObserved,
    open: { n: openAges.length, median: median(openAges),
            // Anything silent longer than the slowest reply you have ever had is, on the evidence
            // you actually possess, done. Deliberately framed as evidence, not as a rule.
            beyondSlowest: maxObserved == null ? null : openAges.filter(d => d > maxObserved).length },
    enough: days.length >= 8,
  };
}

// ---------- 7. supply: is the board filling faster than it empties? ----------
export function supply(days = 14) {
  const disc = all(`SELECT COUNT(*) c FROM leads WHERE discovered_at >= date('now', ?)`,
                   `-${days} days`)[0].c;
  const exp = all(`SELECT
      (SELECT COUNT(*) FROM leads WHERE status='expired' AND discovered_at >= date('now', ?))
    + (SELECT COUNT(*) FROM leads_archive WHERE archived_from <> 'dropped'
       AND discovered_at >= date('now', ?)) c`, `-${days} days`, `-${days} days`)[0].c;
  const sentRecent = all(`SELECT COUNT(*) c FROM applications WHERE archived=0 AND ${SENT}
                          AND applied_at >= date('now', ?)`, `-${days} days`)[0].c;
  const byChannel = all(`SELECT COALESCE(channel,'—') channel, COUNT(*) found,
                                0 expired,
                                SUM(CASE WHEN status='applied' THEN 1 ELSE 0 END) applied
                         FROM leads WHERE discovered_at >= date('now', ?)
                         GROUP BY channel ORDER BY found DESC`, `-${days} days`);
  const open = one("SELECT COUNT(*) c FROM leads WHERE status IN ('new','shortlisted')").c;
  return {
    windowDays: days,
    foundPerDay: +(disc / days).toFixed(1),
    expiredPerDay: +(exp / days).toFixed(1),
    sentPerDay: +(sentRecent / days).toFixed(1),
    open,
    // The honest framing of a 874-row board: at the rate things actually get sent, this is how
    // long it would take to work through it — by which time most of it has expired anyway.
    daysToDrainBoard: sentRecent > 0 ? Math.round(open / (sentRecent / days)) : null,
    byChannel: byChannel.map(c => ({ ...c,
      applyRate: c.found ? +(c.applied / c.found * 100).toFixed(1) : 0 })),
  };
}

// ---------- 8. forecast ----------
//
// Deliberately stops at "live threads". There are 0 offers, so any live→offer rate would be
// invented, and a forecast built on an invented number is worse than no forecast. What it can say
// honestly is: at this send rate and this reply rate, this many conversations by the deadline —
// with the interval, because a 4.3% rate off 69 sends is not a precise number.
export function forecast(runwayDays) {
  const win = 28;
  const sentWin = one(`SELECT COUNT(*) c FROM applications WHERE archived=0 AND ${SENT}
                       AND applied_at >= date('now', '-${win} days')`).c;
  const sentAll = one(`SELECT COUNT(*) c FROM applications WHERE archived=0 AND ${SENT}`).c;
  const liveAll = one(`SELECT COUNT(*) c FROM applications WHERE archived=0 AND ${LIVE}`).c;

  const perWeek = +(sentWin / (win / 7)).toFixed(1);
  const r = rate(liveAll, sentAll, 30);
  const w = wilson(liveAll, sentAll);
  const weeksLeft = runwayDays / 7;
  const projSends = Math.round(perWeek * weeksLeft);

  const project = p => Math.round(projSends * p);
  const targetLive = 5;                       // five real conversations is the working target
  const needSends = w.p > 0 ? Math.ceil(targetLive / w.p) : null;

  return {
    windowDays: win, sentWin, perWeek, runwayDays, weeksLeft: +weeksLeft.toFixed(1),
    replyRate: r,
    projSends,
    projLive: project(w.p),
    projLiveLo: project(w.lo), projLiveHi: project(w.hi),
    // What it would take to hit the target instead of drifting toward whatever the current pace
    // produces. This is the actionable half.
    target: targetLive,
    needSends,
    needPerWeek: needSends ? +(needSends / weeksLeft).toFixed(1) : null,
    shortfall: needSends ? Math.max(0, needSends - projSends) : null,
    // Stated plainly so the projection is never mistaken for a pipeline forecast.
    stopsAt: 'live conversations',
    whyNoOfferForecast: liveAll === 0
      ? 'No replies yet, so there is no rate to project from.'
      : one(`SELECT COUNT(*) c FROM applications WHERE status='offer'`).c === 0
        ? 'No offer has happened yet, so any live→offer rate would be made up. This forecast stops at conversations on purpose.'
        : null,
  };
}

/** Everything the Stats page needs, in one call. */
export function analytics(runwayDays = 60) {
  return {
    funnel: funnelConversion(),
    routes: routes(),
    platforms: platforms(),
    deaths: leadDeaths(),
    rejections: rejections(),
    calibration: calibration(),
    bands: bandEffect(),
    latency: latency(),
    supply: supply(),
    forecast: forecast(runwayDays),
  };
}
