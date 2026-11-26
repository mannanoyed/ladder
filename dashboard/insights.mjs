// ladder/dashboard/insights.mjs — the funnel, the numbers behind it, and what to do about them.
//
// Written when the dashboard stopped pretending to automate outbound. Every application is sent
// by hand now, so the UI's job is narrower and more honest: show one ranked funnel, and show what
// the accumulated inbound (mail, portal messages, sweeps) says about where to spend the next hour.
//
// Nothing here writes. `roadmapState`/`roadmapSet` are the one exception and they touch `kv` only.
import { all, one, run, settings } from './db.mjs';
import { tierOf, parseBand } from './lib.mjs';
import { parseScore, scoreV2, summary, isWarm, isEstimated, companyFor, companyMap } from './score.mjs';
import { suggestAsk } from './ask.mjs';
import { analytics as deepAnalytics, ROUTE_OF } from './analytics.mjs';

// ---------- the funnel ----------
//
// One progression, five stages, replacing two parallel status vocabularies. `leads.status` and
// `applications.status` used to be read on separate tabs, which meant a company could be a "lead"
// and an "application" at once and the board could not say which phase it was actually in.
//
// A lead that has been applied to lives on in `leads` with status='applied'; the application row
// is the authority from that point on, so leads are only ever read for the first stage.
export const STAGES = [
  { id: 'scraped',    label: 'Scraped',    hint: 'found by the hunt, not sent' },
  { id: 'applied',    label: 'Applied',    hint: 'sent by hand, waiting' },
  { id: 'assessment', label: 'Assessment', hint: 'a test is live or was taken' },
  { id: 'interview',  label: 'Interview',  hint: 'talking to humans' },
  { id: 'converged',  label: 'Converged',  hint: 'offer on the table' },
];
export const STAGE_IDS = STAGES.map(s => s.id);

// Application status → stage. `queued` is deliberately absent: it was the outbound-automation
// staging area and no longer means anything, so those rows fall back to `scraped` and rejoin the
// board they came from rather than sitting in a tab of their own.
const STAGE_OF_APP = {
  applied: 'applied', viewed: 'applied', replied: 'applied',
  screen: 'assessment', interview: 'interview', offer: 'converged',
};
const CLOSED_APP = new Set(['rejected', 'withdrawn', 'ghosted']);

/**
 * The Leads page: every live lead, the stored v2 breakdown beside it, and what is known about the
 * employer. Eligible rows first by potential, gated rows last by potential — a gated lead is
 * still shown, with its reason, because a gate is reversible and a hidden row is not.
 *
 * Reads stored scores only. `state()` serves this on every SSE tick, so it must never write and
 * never rank — `picks()` stamps `shown`, and this must not.
 */
export function leadRows() {
  companyMap(true);
  const rows = [];
  for (const l of all(`SELECT * FROM leads WHERE status IN ('new','shortlisted')`)) {
    const r = parseScore(l) || scoreV2(l);
    const co = companyFor(l.company);
    const heads = co?.headcount ?? (co?.employees && String(co.employees).match(/\d+/) ? +String(co.employees).replace(/,/g, '').match(/\d+/)[0] : null);
    // Lean on purpose: 845 rows on every SSE tick. Location, the raw band string, the gate and
    // the notes are one click away in the drawer (`/api/row/lead/:id`).
    rows.push({
      id: l.id, company: l.company, role: l.role, channel: l.channel, url: l.url,
      band_min_lpa: l.band_min_lpa, band_max_lpa: l.band_max_lpa,
      // A stored estimate is a cache of an older model run; the score re-estimates live, so the
      // row must print the live figure (`sj.money_top`) or it disagrees with its own Money bar.
      est: isEstimated(l),
      // What to type as expected CTC, and why. See ask.mjs: anchored to the role, not the floor.
      ask: suggestAsk(l, co),
      focus: !!l.focus, picked: l.status === 'shortlisted' || !!l.focus,
      claimed_at: l.claimed_at, claimed_note: l.claimed_note,
      at: l.posted_at || l.discovered_at, posted_at: l.posted_at, applicants: l.applicants,
      jd_status: l.jd_status, snoozed_until: l.snoozed_until,
      // Which of your four lanes clean.mjs put it in, and on what evidence. NULL = not cleaned yet.
      lane: l.lane, lane_why: l.lane_why,
      potential: r.potential, tier: tierOf({ ...l, score: r.gated.length ? 0 : r.potential }),
      sj: summary(r), gates: r.gated,
      warm: isWarm(l),
      co: co ? { stage: co.funding_stage || null, headcount: heads, yc: co.yc_batch || null,
                 kind: co.kind || null, target: !!co.target, verified: !!(heads || co.funding_stage || co.yc_batch) }
              : null,
    });
  }
  rows.sort((x, y) => (x.gates.length ? 1 : 0) - (y.gates.length ? 1 : 0) || y.potential - x.potential);
  return rows;
}

/**
 * The Applications page: stages 2–5 plus the closed pile. An application is the authority once it
 * exists; `fit_score` is your own judgement and is the only potential shown here.
 */
export function appRows() {
  companyMap(true);
  const rows = [];
  for (const a of all(`SELECT *, CAST(julianday('now') - julianday(COALESCE(last_activity_at,applied_at,created_at)) AS INT) quiet_days
                       FROM applications WHERE archived=0 AND status<>'queued'`)) {
    const stage = STAGE_OF_APP[a.status] || (CLOSED_APP.has(a.status) ? 'closed' : 'applied');
    rows.push({
      kind: 'app', id: a.id, stage,
      company: a.company, role: a.role, location: a.location, channel: a.channel, url: a.url,
      band_raw: a.band_raw, band_min_lpa: a.band_min_lpa, band_max_lpa: a.band_max_lpa,
      gate_years: a.gate_years, focus: !!a.focus,
      ask: suggestAsk(a, companyFor(a.company)),
      at: a.applied_at, quiet_days: a.quiet_days,
      next_action: a.next_action, next_action_due: a.next_action_due,
      // A reply is real progress that the five stages cannot express on their own: a company that
      // answered still reads as plain `applied`. Carried as a flag so the
      // row can say so without inventing a sixth stage.
      replied: a.status === 'replied',
      closed_as: stage === 'closed' ? a.status : null,
      potential: a.fit_score ?? null, tier: null, picked: true,
    });
  }
  // Deepest stage first so progress is at the top, then your fit inside a stage. `closed` sits
  // below every live stage: a rejection ranks under an untouched application, however good the
  // rejected role was.
  const order = Object.fromEntries(STAGE_IDS.map((s, i) => [s, i + 1]));
  order.closed = 0;
  rows.sort((x, y) => (order[y.stage] ?? 0) - (order[x.stage] ?? 0) || (y.potential ?? -1) - (x.potential ?? -1));
  return rows;
}

/** Per-stage counts, for the strip across the top of the Applications page. `scraped` is a lead
 *  stage and has no application rows, so it is not a key here. */
export function stageCounts(rows) {
  const c = Object.fromEntries([...STAGE_IDS.filter(s => s !== 'scraped'), 'closed'].map(s => [s, 0]));
  for (const r of rows) c[r.stage] = (c[r.stage] || 0) + 1;
  return c;
}

// ---------- insights ----------

/** Applications: what left, what came back, and which channel did it. */
export function applicationInsights() {
  const sent = one(`SELECT COUNT(*) c FROM applications
                    WHERE archived=0 AND status NOT IN ('queued','withdrawn')`).c;
  const live = one(`SELECT COUNT(*) c FROM applications
                    WHERE archived=0 AND status IN ('replied','screen','interview','offer')`).c;
  const rejected = one(`SELECT COUNT(*) c FROM applications WHERE archived=0 AND status='rejected'`).c;
  const ghosted = one(`SELECT COUNT(*) c FROM applications
                       WHERE archived=0 AND status IN ('applied','viewed')
                       AND julianday('now') - julianday(COALESCE(last_activity_at,applied_at)) > 21`).c;

  // Per channel, scoped to what actually left. `queued` and `withdrawn` rows in the denominator
  // are what made Wellfound read as a 0%-reply channel off 61 "applications", 44 of which were
  // withdrawn before sending.
  const byChannel = all(`
    SELECT COALESCE(channel,'—') channel,
           SUM(CASE WHEN status NOT IN ('queued','withdrawn') THEN 1 ELSE 0 END) sent,
           SUM(CASE WHEN status IN ('replied','screen','interview','offer') THEN 1 ELSE 0 END) live,
           SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) rejected,
           SUM(CASE WHEN status IN ('screen','interview','offer') THEN 1 ELSE 0 END) deep
    FROM applications WHERE archived=0
    GROUP BY channel HAVING sent > 0 ORDER BY live DESC, sent DESC`);

  const weeks = all(`SELECT strftime('%Y-W%W', applied_at) wk, COUNT(*) n
                     FROM applications WHERE applied_at IS NOT NULL
                       AND status NOT IN ('queued','withdrawn')
                     GROUP BY wk ORDER BY wk DESC LIMIT 8`).reverse();

  return {
    sent, live, rejected, ghosted,
    replyRate: sent ? +(live / sent * 100).toFixed(1) : 0,
    byChannel: byChannel.map(c => ({ ...c, rate: c.sent ? +(c.live / c.sent * 100).toFixed(1) : 0 })),
    weeks,
  };
}

/**
 * Mail and portal messages. Both halves of the inbound picture, which is the half of this system
 * that actually earns its keep — `events.source` says which surface a thing arrived on.
 */
export function mailInsights() {
  const bySource = all(`
    SELECT COALESCE(source,'—') source, COUNT(*) n, MAX(ts) last_ts,
           SUM(CASE WHEN kind IN ('reply','screen_scheduled','interview','offer') THEN 1 ELSE 0 END) good,
           SUM(CASE WHEN kind='rejection' THEN 1 ELSE 0 END) bad
    FROM events WHERE source IN ('gmail','linkedin','naukri','wellfound','yc','instahyre','email')
    GROUP BY source ORDER BY n DESC`);

  const byKind = all(`SELECT kind, COUNT(*) n FROM events
                      WHERE source IN ('gmail','linkedin','naukri','wellfound','yc','instahyre','email')
                      GROUP BY kind ORDER BY n DESC`);

  const recent = all(`SELECT e.ts, e.kind, e.source, e.title, a.company
                      FROM events e LEFT JOIN applications a ON a.id=e.application_id
                      WHERE e.source IN ('gmail','linkedin','naukri','wellfound','yc','instahyre','email')
                      ORDER BY e.ts DESC, e.id DESC LIMIT 14`);

  // An unanswered inbound is the most expensive thing in the system — a warm referral once sat
  // eight days because the read happened on the wrong side of the sweep.
  const waiting = all(`SELECT company, role, status, next_action,
                              CAST(julianday('now') - julianday(COALESCE(last_activity_at,applied_at)) AS INT) days
                       FROM applications
                       WHERE archived=0 AND status IN ('replied','screen','interview','offer')
                       ORDER BY days DESC`);

  return { bySource, byKind, recent, waiting };
}

/** Sweeps: did the machine run, and what did each channel actually yield. */
export function sweepInsights() {
  const runs = all(`SELECT id, started_at, finished_at, findings, ok, channels
                    FROM sweeps ORDER BY id DESC LIMIT 12`)
    .map(s => {
      let ch = [];
      try { ch = JSON.parse(s.channels || '[]'); } catch {}
      // A run is not a hunt *or* a mail pass — the scheduled 08:00 sweep is both, and reports
      // gmail alongside eleven portals in one row. Classifying on `gmail && channels <= 2` meant
      // no row ever counted as mail, so "the mail sweep reads every inbox" sat unticked on the
      // roadmap while gmail had succeeded on its last four runs. Report both facts instead.
      const didMail = ch.some(c => c.channel === 'gmail');
      const didHunt = ch.some(c => c.channel !== 'gmail');
      return {
        id: s.id, started_at: s.started_at, finished_at: s.finished_at,
        findings: s.findings, ok: !!s.ok, channels: ch,
        didMail, didHunt,
        kind: didHunt && didMail ? 'both' : didMail ? 'mail' : 'hunt',
        mailOk: ch.some(c => c.channel === 'gmail' && c.ok),
        huntOk: ch.some(c => c.channel !== 'gmail' && c.ok),
        // A row with no finish time is a pass that died mid-flight. It holds the DB lock, so the
        // next sweep starts blind — worth surfacing rather than leaving as a silent gap.
        hung: !s.finished_at && !!s.started_at,
      };
    });

  // Per-channel yield across the last dozen runs: how many times it ran, how often it worked.
  const yield_ = new Map();
  for (const r of runs) for (const c of r.channels || []) {
    const y = yield_.get(c.channel) || { channel: c.channel, runs: 0, ok: 0, lastNote: '' };
    y.runs++; if (c.ok) y.ok++;
    if (!y.lastNote && c.note) y.lastNote = c.note;
    yield_.set(c.channel, y);
  }

  const leads = all(`SELECT status, COUNT(*) n FROM leads GROUP BY status`);
  return {
    runs,
    byChannel: [...yield_.values()].sort((a, b) => b.runs - a.runs),
    leads: Object.fromEntries(leads.map(r => [r.status, r.n])),
  };
}

/**
 * Optimisation recommendations — derived, never hardcoded prose.
 *
 * Each rule reads the DB, and only fires with a number attached. A recommendation without a
 * figure behind it is an opinion, and there is no shortage of those.
 */
export function recommendations() {
  const out = [];
  const push = (sev, title, detail) => out.push({ sev, title, detail });

  const apps = applicationInsights();

  // Channel best/worst, expired-vs-applied and the reply-rate line all lived here and are gone:
  // the route, stale-bucket and forecast rules below say each of those things with better
  // evidence. Three cards making the same point is three cards nobody reads.
  const dead = apps.byChannel.filter(c => c.sent >= 8 && c.live === 0);
  if (dead.length)
    push('warn', `${dead.map(c => c.channel).join(', ')}: ${dead.reduce((n, c) => n + c.sent, 0)} sends, zero replies`,
      `${dead.map(c => `${c.channel} ${c.sent}`).join(' · ')}. Either these applications land somewhere nobody reads, or the profile on each is stale. Check one before sending more.`);

  // 3. Unanswered inbound. The single most expensive failure mode this system has.
  const mail = mailInsights();
  const stale = mail.waiting.filter(w => w.days >= 3);
  if (stale.length)
    push('bad', `${stale.length} live thread${stale.length > 1 ? 's' : ''} unanswered ${stale[0].days}+ days`,
      stale.slice(0, 3).map(w => `${w.company} (${w.status}, ${w.days}d)`).join(' · ') +
      '. A reply that goes cold costs more than fifty cold applications.');

  // 4. A hung sweep holds the lock, so the next pass starts blind.
  const sw = sweepInsights();
  const hung = sw.runs.filter(r => r.hung);
  if (hung.length)
    push('warn', `${hung.length} sweep${hung.length > 1 ? 's' : ''} never finished`,
      `Run #${hung[0].id} started ${hung[0].started_at} and has no finish time. A pass that dies mid-flight holds the DB lock and the next one reads stale state.`);

  // 5. Lapsed logins masquerade as empty channels.
  const cold = sw.byChannel.filter(c => c.runs >= 2 && c.ok === 0);
  for (const c of cold)
    push('warn', `${c.channel} failed every one of its last ${c.runs} runs`,
      c.lastNote ? `Last said: "${c.lastNote}". Usually a lapsed login, not an empty board.` : 'Usually a lapsed login, not an empty board.');

  // 6. Comp. The floor is only a floor if the funnel respects it — comp_points are logged for
  //    exactly this, so use them rather than the band strings scraped off cards.
  const pts = all(`SELECT kind, lpa_min, lpa_max FROM comp_points WHERE COALESCE(lpa_max,lpa_min) IS NOT NULL`);
  if (pts.length >= 3) {
    const tops = pts.map(p => p.lpa_max ?? p.lpa_min).sort((a, b) => a - b);
    const med = tops[Math.floor(tops.length / 2)];
    push('info', `Median logged comp datapoint: ₹${med}L across ${pts.length} points`,
      `Taken from what people actually said, not from posted bands. Anchor the next conversation above this, not above the posted range.`);
  }
  const belowFloor = one(`SELECT COUNT(*) c FROM applications WHERE archived=0
                          AND status NOT IN ('queued','withdrawn')
                          AND COALESCE(band_max_lpa,band_min_lpa) < 25`).c;
  if (belowFloor >= 5)
    push('info', `${belowFloor} sent applications sit below the ₹25L floor`,
      `Worth keeping only as conversation practice. If any converts you are negotiating from under your own floor.`);

  // ---- rules that need the deep analytics ----
  // These are the findings the old count-based page could not see at all.
  const A = deepAnalytics(runway().left);

  // The largest single leak in the whole system, by a factor of three.
  const staleBucket = A.deaths.buckets.find(b => b.key === 'stale');
  if (staleBucket && staleBucket.pct >= 25)
    push('bad', `${staleBucket.pct}% of dead leads died of age, not of judgement`,
      `${staleBucket.n} of ${A.deaths.total} leads were never applied to before the window closed. This is the biggest leak in the funnel and it is a throughput problem, not a quality one.`);

  // A board you cannot possibly work through is not an asset.
  if (A.supply.daysToDrainBoard && A.supply.daysToDrainBoard > A.forecast.runwayDays * 2)
    push('warn', `The board holds ${A.supply.open} leads — ${A.supply.daysToDrainBoard} days of work at your current pace`,
      `You have ${A.forecast.runwayDays} days. The hunt finds ${A.supply.foundPerDay}/day and you send ${A.supply.sentPerDay}/day, so the backlog only grows. Raise the score floor rather than the scrape breadth.`);

  // Applications that are, on the evidence, already dead.
  const L = A.latency;
  if (L.open.beyondSlowest > 0 && L.max != null)
    push('info', `${L.open.beyondSlowest} applications are past the point anything has ever come back`,
      `Your slowest reply ever took ${L.max} days. ${L.open.beyondSlowest} of ${L.open.n} silent applications are older than that, so treat them as closed and stop counting them as pipeline.`);

  // Route concentration — the single most actionable line on the page.
  const best = A.routes.filter(r => r.k > 0).sort((a, b) => b.pct - a.pct)[0];
  const deadRoutes = A.routes.filter(r => r.k === 0 && r.n >= 15);
  if (best && deadRoutes.length)
    push('good', `Every live thread came from "${best.label}" — ${best.k} of ${best.n}`,
      `${deadRoutes.map(r => `${r.label} is ${r.k}/${r.n}`).join(', ')}. The routes with a human on the other end are the only ones that have ever produced a conversation.`);

  // The ranking is unvalidated, which is worth knowing before trusting the board's order.
  if (!A.calibration.usable && A.calibration.unscored > A.calibration.scored)
    push('warn', `${A.calibration.unscored} of ${A.calibration.total} sends were never scored`,
      `The board ranks 993 rows by potential, but with most sends unscored there is no way to tell whether that ranking predicts a reply. Score them on the way out and this panel starts answering.`);

  // Pace against the target, stated as a decision.
  const F = A.forecast;
  if (F.needPerWeek != null)
    push(F.shortfall > 0 ? 'warn' : 'good',
      F.shortfall > 0
        ? `Behind pace: ${F.perWeek}/week sent, ${F.needPerWeek}/week needed`
        : `On pace: ${F.perWeek}/week sent against ${F.needPerWeek}/week needed`,
      `At a ${F.replyRate.pct}% reply rate, ${F.target} live conversations takes about ${F.needSends} sends. ${F.runwayDays} days left projects ${F.projSends} sends and ${F.projLive} conversations (${F.projLiveLo}–${F.projLiveHi} at 95%).`);


  // ---- the lane question, settled with numbers ----
  //
  // You asked repeatedly whether FDE or AI-engineer is the better-paid lane, and the honest answer
  // is that on this board neither is: the two medians sit a few lakh apart and both start at ₹20L.
  // What separates a ₹25L req from a ₹70L one is the employer, not the noun in the title — the
  // top of the India board is forward-deployed work at AI-native companies. These three cards
  // encode the filter you actually stated on 2026-09-23 (comp, close to the build, leaves the
  // evenings alone) so the board keeps answering it without you having to re-ask.
  const INDIA = /india|bengaluru|bangalore|gurgaon|gurugram|noida|delhi|ncr|hyderabad|pune|mumbai|chennai|kolkata/i;
  const FDE_T = /forward deployed|\bfde\b|solutions? (engineer|architect)|customer engineer|deployment (engineer|strategist)/i;
  // NB: `\bml\b` matters — "ML Engineer - 2" is a common title and the first version of this
  // regex missed every one of them, which silently shrank the AI/ML side of the comparison.
  const AIE_T = /\b(ai|genai|gen ai|llm|ml|applied ai)\b.*engineer|engineer.*\b(ai|genai|llm|ml)\b|machine learning engineer|\bmle\b/i;
  // Verb counts, not keyword hits: a JD that says build/design/implement ten times and never says
  // demo is a different job from one that inverts that, whatever either of them is titled.
  const HANDS = /\b(build|design|implement|architect|ship|develop|prototype|hands-on)\b/gi;
  const PITCH = /\b(demo|pre-?sales|sales (?:engineer|cycle|team)|pitch|quota|customer success|evangeli)\b/gi;
  // The things that eat the evenings the home lab is supposed to happen in.
  const GRIND = /\b(on-?call|24x7|24\/7|rotational|six days|6 days|weekends?|travel (?:up to|extensively|required)|wear many hats|whatever it takes|high pressure)\b/gi;
  const medOf  = xs => { const v = xs.filter(n => n != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const gateMin = g => { const n = (String(g || '').match(/\d+/g) || []).map(Number); return n.length ? Math.min(...n) : null; };

  const FLOOR = parseFloat(settings().floor_lpa || 25);
  // Upper bound of 100, not 200: above that the row is a scraped artefact, not a job. A ₹160L
  // "Python Developer" and a ₹200L req with no named team are noise, and quoting them in a card
  // that is meant to tell you where the money is would be worse than saying nothing.
  const banded = all(`SELECT company, role, location, band_min_lpa, band_max_lpa, gate_years
                      FROM leads WHERE band_max_lpa BETWEEN 5 AND 100`).filter(r => INDIA.test(r.location || ''));

  // A. Lane vs tier. Only fires with enough of both lanes to be worth stating.
  const fdeB = banded.filter(r => FDE_T.test(r.role || ''));
  const aieB = banded.filter(r => AIE_T.test(r.role || ''));
  if (fdeB.length >= 15 && aieB.length >= 15) {
    const top = [...banded].sort((a, b) => b.band_max_lpa - a.band_max_lpa)
      .filter(r => !/lead|manager|director|head of/i.test(r.role || ''))
      .slice(0, 3);
    push('good', `Lane is not the pay lever — company tier is`,
      `Forward-deployed medians ₹${medOf(fdeB.map(r => r.band_min_lpa))}–${medOf(fdeB.map(r => r.band_max_lpa))}L (n=${fdeB.length}); ` +
      `AI/ML engineer ₹${medOf(aieB.map(r => r.band_min_lpa))}–${medOf(aieB.map(r => r.band_max_lpa))}L (n=${aieB.length}). ` +
      `Both start at ₹20L, so the title is not what moves the number. The top of the India board is ` +
      top.map(r => `${r.company} ₹${r.band_max_lpa}L`).join(' · ') +
      ` — the pattern there is AI-native employer, not one noun or the other. Chase the tier, apply in both lanes.`);
  }

  // B. Your actual filter, run over the open board: in-band, reachable, builds rather than presents,
  //    and nothing in the JD that claims the evenings.
  const openLeads = all(`SELECT id, company, role, location, band_min_lpa, band_max_lpa, gate_years, jd_text
                         FROM leads WHERE status='new' AND jd_text IS NOT NULL AND jd_text <> ''`);
  const bandedOpen   = one(`SELECT COUNT(*) c FROM leads WHERE status='new' AND band_max_lpa IS NOT NULL`).c;
  const unbandedOpen = one(`SELECT COUNT(*) c FROM leads WHERE status='new' AND band_max_lpa IS NULL`).c;
  const fits = openLeads.filter(r => {
    if (!INDIA.test(r.location || '')) return false;
    if (!(FDE_T.test(r.role || '') || AIE_T.test(r.role || ''))) return false;
    const g = gateMin(r.gate_years); if (g != null && g > 4) return false;
    if ((r.band_max_lpa ?? 0) < FLOOR) return false;
    const h = (r.jd_text.match(HANDS) || []).length;
    const p = (r.jd_text.match(PITCH) || []).length;
    const q = (r.jd_text.match(GRIND) || []).length;
    return h - p >= 3 && q === 0;
  }).sort((a, b) => (b.band_max_lpa ?? 0) - (a.band_max_lpa ?? 0));
  // Same test with the comp clause dropped. This is deliberately reported alongside, because the
  // binding constraint on your filter is not that few jobs are good — it is that only a sliver of
  // the board has a band at all, so "in band" silently means "one of the 6% we happen to know".
  const fitsNoBand = openLeads.filter(r => {
    if (r.band_max_lpa != null) return false;
    if (!INDIA.test(r.location || '')) return false;
    if (!(FDE_T.test(r.role || '') || AIE_T.test(r.role || ''))) return false;
    const g = gateMin(r.gate_years); if (g != null && g > 4) return false;
    const h = (r.jd_text.match(HANDS) || []).length;
    const p = (r.jd_text.match(PITCH) || []).length;
    return h - p >= 3 && (r.jd_text.match(GRIND) || []).length === 0;
  });
  if (fits.length || fitsNoBand.length) {
    const named = fits.length
      ? fits.slice(0, 4).map(r => `${r.company} — ${r.role} (₹${r.band_max_lpa}L, ${r.location})`).join(' · ')
      : fitsNoBand.slice(0, 4).map(r => `${r.company} — ${r.role} (${r.location})`).join(' · ');
    push('good', `${fits.length} banded lead${fits.length === 1 ? ' matches' : 's match'} the whole filter — and ${fitsNoBand.length} more pass everything but comp`,
      `${named}. Scored on the JD's own verbs: build/design/implement at least three more times than demo/pre-sales/quota, and no mention of on-call, rotational, six-day weeks or heavy travel. ` +
      `Only ${bandedOpen} of ${bandedOpen + unbandedOpen} open leads carry a band at all, so the comp clause is the filter throwing away rows it cannot see, not rows that fail. Ask comp on the ${fitsNoBand.length} rather than skipping them.`);
  }

  // C. Where the sends actually went. A gate is a band proxy on this board, and most of yours went low.
  const gated = all(`SELECT gate_years FROM applications WHERE archived=0
                     AND status NOT IN ('queued','withdrawn')`)
                .map(r => gateMin(r.gate_years)).filter(g => g != null);
  const lowGate = gated.filter(g => g <= 2).length;
  const midB = banded.filter(r => { const g = gateMin(r.gate_years); return g != null && g >= 3 && g <= 4; });
  const loB  = banded.filter(r => { const g = gateMin(r.gate_years); return g != null && g <= 2; });
  if (gated.length >= 30 && lowGate / gated.length >= 0.5 && loB.length >= 10 && midB.length >= 10)
    push('warn', `${Math.round(100 * lowGate / gated.length)}% of your gated sends went to reqs asking 0–2 years`,
      `${lowGate} of ${gated.length}. On this board a 0–2 gate pays ₹${medOf(loB.map(r => r.band_min_lpa))}–${medOf(loB.map(r => r.band_max_lpa))}L (n=${loB.length}) against ₹${medOf(midB.map(r => r.band_min_lpa))}–${medOf(midB.map(r => r.band_max_lpa))}L for a 3–4 gate (n=${midB.length}), ` +
      `so most of that volume is aimed structurally below your own ₹${FLOOR}L floor. Seniority moves the band more than either lane does — apply up.`);

  const rank = { bad: 0, warn: 1, good: 2, info: 3 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

// ---------- roadmap ----------
//
// A checklist, not a todo list and not a calendar — you keep those elsewhere. Each item either
// derives its done state from the DB (so it cannot drift out of date) or is ticked by hand and
// remembered in `kv`. Phases are keyed to the notice-period runway, because that is the only
// deadline in this project that does not move.
const KV_KEY = 'roadmap_ticks';

export function roadmapState() {
  const row = one(`SELECT value v FROM kv WHERE key=?`, KV_KEY);
  try { return JSON.parse(row?.v || '{}'); } catch { return {}; }
}
export function roadmapSet(id, done) {
  const s = roadmapState();
  if (done) s[id] = new Date().toISOString(); else delete s[id];
  run(`INSERT INTO kv (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`, KV_KEY, JSON.stringify(s));
  return s;
}

export function roadmap() {
  const ticks = roadmapState();
  const apps = applicationInsights();
  const sw = sweepInsights();
  const n = (sql, ...p) => one(`SELECT COUNT(*) c FROM ${sql}`, ...p).c;

  // Auto-derived items. `done` is a fact about the DB, so these never need ticking.
  const auto = {
    'first-send':   apps.sent >= 1,
    'ten-sends':    apps.sent >= 10,
    'fifty-sends':  apps.sent >= 50,
    'first-reply':  apps.live >= 1,
    'first-assess': n(`applications WHERE status IN ('screen','interview','offer')`) >= 1,
    'first-interview': n(`applications WHERE status IN ('interview','offer')`) >= 1,
    'offer':        n(`applications WHERE status='offer'`) >= 1,
    'warm-routes':  n(`contacts`) >= 25,
    'hunt-running': sw.runs.some(r => r.huntOk),
    'mail-running': sw.runs.some(r => r.mailOk),
  };

  const PHASES = [
    { id: 'machine', label: 'The machine', hint: 'built and running unattended', items: [
      { id: 'hunt-running',  label: 'Hunt sweeps every portal',        auto: true },
      { id: 'mail-running',  label: 'Mail sweep reads every inbox',    auto: true },
      { id: 'warm-routes',   label: 'Contacts captured as people, not URLs', auto: true },
      { id: 'resume-locked', label: 'Resume locked for distribution',  note: 'FDE primary, AIENG secondary' },
      { id: 'profiles',      label: 'LinkedIn, Wellfound, Naukri rebuilt' },
    ]},
    { id: 'volume', label: 'Volume', hint: 'hand-sent, one at a time', items: [
      { id: 'first-send',   label: 'First application out',   auto: true },
      { id: 'ten-sends',    label: '10 sent',                 auto: true },
      { id: 'fifty-sends',  label: '50 sent',                 auto: true },
      { id: 'warm-first',   label: 'Every referral route worked before its cold twin',
        note: 'warm converts an order of magnitude better — the numbers on the Stats page say so' },
    ]},
    { id: 'conversion', label: 'Conversion', hint: 'the part volume cannot buy', items: [
      { id: 'first-reply',     label: 'First real reply',       auto: true },
      { id: 'first-assess',    label: 'First assessment',       auto: true },
      { id: 'first-interview', label: 'First interview',        auto: true },
      { id: 'offer',           label: 'Offer in hand',          auto: true },
    ]},
    { id: 'close', label: 'Close', hint: 'the runway ends whether or not this is done', items: [
      { id: 'two-offers',  label: 'Two live offers to negotiate against',
        note: 'one offer is a salary; two is a negotiation' },
      { id: 'floor-held',  label: 'Signed above the floor' },
    ]},
  ];

  for (const ph of PHASES) {
    for (const it of ph.items) {
      it.done = it.auto ? !!auto[it.id] : !!ticks[it.id];
      it.at = ticks[it.id] || null;
    }
    ph.done = ph.items.filter(i => i.done).length;
    ph.total = ph.items.length;
  }
  return { phases: PHASES, runway: runway() };
}

/**
 * Notice-period runway. Resigned 2026-09-09 on a two-month notice, so the last working day is
 * around 2026-11-09 — that date is the only hard deadline here and every phase above is measured
 * against it rather than against a sprint someone chose.
 */
function runway() {
  const end = new Date('2026-11-09T00:00:00');
  const start = new Date('2026-09-09T00:00:00');
  const now = new Date();
  const DAY = 864e5;
  const total = Math.round((end - start) / DAY);
  const left = Math.max(0, Math.ceil((end - now) / DAY));
  return { start: '2026-09-09', end: '2026-11-09', total, left, elapsed: total - left,
           pct: Math.min(100, Math.round((total - left) / total * 100)) };
}
