// ladder/dashboard/recommend.mjs — which leads and which people to touch today.
//
// The board holds ~800 open leads and you send about three a day. 52% of every lead that ever died
// died of age, not judgement. So the job here is not "rank everything" — the scorer already does
// that — it is to pick the eight applications and three messages that fit the hour you actually
// have, explain each pick in one line, and stop suggesting things you keep ignoring.
//
// Two layers on top of score model v2 (score.mjs), which since 2026-09-12 owns time, title, gate
// and location — this file used to re-add its own versions of those on top of the v1 score, and
// keeping them here would count every one of them twice:
//   1. Shown.  A card that has been shown for days without being touched sinks.
//   2. Memory. Every skip carries a reason and a feature snapshot. Features that keep getting
//              skipped are penalised; features that keep getting applied to are rewarded. All of
//              it is visible: a pick says "you skipped 3 senior-titled roles" rather than moving
//              for reasons nobody can see.
//
// Everything here reads, except `record()`, the once-a-day `shown` stamp, and the lazy
// `persistScore` for a row that has no v2 breakdown yet.
import { all, one, run, settings } from './db.mjs';
import { scoreV2, persistScore, parseScore, chips, summary, isWarm, isEstimated } from './score.mjs';

const DAY = 864e5;
const today = () => new Date().toISOString().slice(0, 10);
const ageDays = ts => {
  if (!ts) return null;
  const t = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') || String(ts).includes('+') ? '' : 'Z')).getTime();
  return isFinite(t) ? Math.max(0, (Date.now() - t) / DAY) : null;
};

// ---------- features ----------
//
// A lead is described by a handful of coarse buckets. Coarse on purpose: the recommender learns
// from a few dozen skips, and a feature that appears once cannot teach anything.
export const WARM = /referral|inbound|inmail|direct|email/i;

export function titleBucket(role) {
  const r = String(role || '').toLowerCase();
  if (/\b(intern|trainee|apprentice|fresher)\b/.test(r)) return 'title:junior';
  if (/\b(senior|sr\.?|staff|principal|director|head|vp|vice president|distinguished)\b/.test(r)) return 'title:senior';
  if (/\b(manager|product owner|marketing|sales|account|recruiter|hr)\b/.test(r) && !/engineer/.test(r)) return 'title:nontech';
  if (/forward.?deploy(ed|ment)|partner.deployed|\bfde\b|solutions? (engineer|architect)|deployment engineer|field (ai |)engineer|customer engineer|implementation engineer/.test(r)) return 'title:fde';
  if (/\bagent|llm|gen ?ai|ai engineer|ml engineer|machine learning|applied ai|founding/.test(r)) return 'title:ai';
  return 'title:other';
}
export function locBucket(loc) {
  const l = String(loc || '').toLowerCase();
  if (!l.trim()) return 'loc:unknown';
  const india = /india|bengaluru|bangalore|gurugram|gurgaon|noida|delhi|ncr|mumbai|pune|hyderabad|chennai|kolkata/.test(l);
  if (/remote/.test(l) && india) return 'loc:remote-india';
  if (/gurugram|gurgaon|noida|delhi|ncr/.test(l)) return 'loc:ncr';
  if (/bengaluru|bangalore/.test(l)) return 'loc:blr';
  if (india) return 'loc:other-india';
  if (/united states|north america|\bus\b|usa|new york|san francisco|\best\b|\bpst\b|canada|europe|london|dubai|riyadh|singapore/.test(l)) return 'loc:abroad';
  if (/remote|everywhere|anywhere/.test(l)) return 'loc:remote';
  return 'loc:other';
}
export function bandBucket(row, s = settings()) {
  const floor = parseFloat(s.floor_lpa || 25), stretch = parseFloat(s.stretch_lpa || 40);
  const top = row.band_max_lpa ?? row.band_min_lpa;
  if (top == null) return 'band:unknown';
  if (top < floor * 0.8) return 'band:below';
  if (top < floor) return 'band:near';
  if (top < stretch) return 'band:floor';
  return 'band:stretch';
}
export function gateBucket(gate) {
  const g = String(gate || '').toLowerCase();
  if (!g.trim() || /not stated/.test(g)) return 'gate:unknown';
  if (/new grad|any|fresher|0\+/.test(g)) return 'gate:inrange';
  const m = g.match(/(\d+)/);
  if (!m) return /senior/.test(g) ? 'gate:high' : 'gate:unknown';
  return +m[1] >= 5 ? 'gate:high' : 'gate:inrange';
}
export function featuresOf(l) {
  return [
    `ch:${(l.channel || 'unknown').toLowerCase()}`,
    `co:${(l.company || '').toLowerCase().trim()}`,
    titleBucket(l.role), locBucket(l.location), bandBucket(l), gateBucket(l.gate_years),
  ];
}
// What a feature is called when the recommender explains itself.
const FEATURE_LABEL = {
  'title:senior': 'senior-titled roles', 'title:junior': 'intern/junior roles', 'title:nontech': 'non-engineering titles',
  'title:fde': 'FDE / solutions roles', 'title:ai': 'AI / agent roles', 'title:other': 'generic titles',
  'loc:abroad': 'roles outside India', 'loc:remote': 'remote-anywhere roles', 'loc:remote-india': 'remote India roles',
  'loc:ncr': 'NCR roles', 'loc:blr': 'Bengaluru roles', 'loc:other-india': 'other-city roles', 'loc:unknown': 'roles with no location',
  'band:unknown': 'roles with no band', 'band:below': 'below-floor bands', 'band:near': 'near-floor bands',
  'band:floor': 'above-floor bands', 'band:stretch': 'stretch bands',
  'gate:high': '5+ year gates', 'gate:inrange': 'in-range gates', 'gate:unknown': 'unstated gates',
};
const labelOf = f => FEATURE_LABEL[f] || (f.startsWith('ch:') ? `${f.slice(3)} roles` : f.startsWith('co:') ? f.slice(3) : f);

// A skip reason is the truth about *why*, which the feature snapshot can only guess at. Each
// reason increments one specific feature on top of the lead's own — so "too senior" on a lead
// whose title did not look senior still teaches the title lesson.
const REASON_FEATURE = {
  senior:        l => 'title:senior',
  services:      l => `co:${(l.company || '').toLowerCase().trim()}`,
  comp:          l => bandBucket(l),
  location:      l => locBucket(l.location),
  notinterested: l => `co:${(l.company || '').toLowerCase().trim()}`,
};
export const SKIP_REASONS = [
  ['senior', 'Too senior'], ['services', 'Services firm'], ['comp', 'Comp too low'],
  ['location', 'Location'], ['notinterested', 'Not for me'],
  // Not a judgement on the job — the posting is gone or has no apply control. Recorded as
  // `expired`, not `dropped`, so it never teaches the recommender that this company or title
  // is unwanted, and the Stats page counts it as a death by age rather than by taste.
  ['expired', 'Expired / no apply'],
];

// ---------- memory ----------

/** Per-feature tallies of what you skipped and what you applied to, from every recorded answer. */
export function learned(target = 'lead') {
  const rows = all(`SELECT action, reason, meta_json FROM rec_events
                    WHERE target=? AND action IN ('skipped','applied','contacted')`, target);
  const tally = new Map();
  for (const r of rows) {
    let feats = [];
    try { feats = JSON.parse(r.meta_json || '{}').features || []; } catch {}
    for (const f of feats) {
      const t = tally.get(f) || { f, skipped: 0, taken: 0 };
      if (r.action === 'skipped') t.skipped++; else t.taken++;
      tally.set(f, t);
    }
  }
  return tally;
}

/**
 * The learned adjustment for one candidate, with the reasons that produced it.
 * Two skips of a feature is the minimum before it counts — one skip is a mood, not a pattern.
 * Capped so memory can reorder the board but never bury a 90-point lead below a 40.
 */
function learnedAdjust(feats, tally) {
  let adj = 0; const why = [];
  for (const f of feats) {
    const t = tally.get(f);
    if (!t) continue;
    const n = t.skipped + t.taken;
    if (t.skipped >= 2 && t.skipped > t.taken) {
      const pen = Math.min(8, Math.round(3 * t.skipped * (t.skipped / (n + 1))));
      if (pen > 0) { adj -= pen; why.push({ d: -pen, t: `you skipped ${t.skipped} ${labelOf(f)}` }); }
    } else if (t.taken >= 2 && t.taken > t.skipped) {
      const bonus = Math.min(5, t.taken);
      adj += bonus; why.push({ d: +bonus, t: `you applied to ${t.taken} ${labelOf(f)}` });
    }
  }
  adj = Math.max(-20, Math.min(10, adj));
  return { adj, why };
}

// ---------- leads ----------

/**
 * Rank every eligible lead. `limit` picks are then chosen with diversification (one per company,
 * no channel above 40% of the set), so the session is eight different doors rather than the top
 * eight rows of one Wellfound search.
 *
 * The base is the stored v2 potential (computed and persisted here only when a row has none —
 * `reconcile()` keeps the rest fresh). Gated rows are not candidates. What this adds is the two
 * things the scorer cannot know: how long the card has been ignored, and what you have said no to.
 */
export function rankLeads({ includeSnoozed = false } = {}) {
  const s = settings();
  const expiry = +(s.expiry_days || 10);
  const tally = learned('lead');
  const shownDays = shownDaysByTarget('lead');

  const rows = all(`SELECT * FROM leads WHERE status IN ('new','shortlisted')
                    ${includeSnoozed ? '' : "AND (snoozed_until IS NULL OR snoozed_until <= date('now'))"}`);
  const out = [];
  for (const l of rows) {
    let r = parseScore(l);
    if (!r) { r = scoreV2(l, { s }); persistScore(l.id, r); }
    if (r.gated.length) continue;
    const feats = featuresOf(l);
    const warm = isWarm(l);
    // Older than the window is expired in fact, whether or not the expire pass or a rescore has
    // reached the row yet. Without this a lead sitting at day 14 computes `expiresIn: 0` and
    // surfaces as "expires today" — a deadline four days in the past, presented as an urgent one.
    const age = ageDays(l.posted_at || l.discovered_at);
    if (!warm && !l.focus && age != null && age > expiry) continue;
    const base = r.potential;
    let fit = base;
    // The strongest component reasons, as the scorer wrote them. Neutral facts carry d: 0.
    const why = chips(r, 6);
    if (l.focus) why.push({ d: 0, t: 'pinned by you' });
    let expiresIn = null;
    if (!warm && !l.focus && age != null) {
      expiresIn = Math.max(0, Math.ceil(expiry - age));
      if (expiresIn <= 3) why.push({ d: 0, t: expiresIn === 0 ? 'expires today' : `expires in ${expiresIn}d — apply or lose it` });
    }
    // 1. Shown and not acted on. Four untouched days move a card down a full tier; warm routes
    //    sink at half speed because they are still the best thing on the board even when ignored.
    const seen = shownDays.get(l.id) || 0;
    if (seen >= 1) {
      const pen = Math.min(warm || l.focus ? 8 : 16, 4 * seen);
      fit -= pen; why.push({ d: -pen, t: `shown ${seen} day${seen > 1 ? 's' : ''}, untouched` });
    }
    // 2. Memory.
    const L = learnedAdjust(feats, tally);
    fit += L.adj; why.push(...L.why);

    fit = Math.max(0, Math.min(100, Math.round(fit)));
    const sm = summary(r);
    out.push({
      kind: 'lead', id: l.id, company: l.company, role: l.role, location: l.location, channel: l.channel,
      url: l.url, band_raw: l.band_raw, band_min_lpa: l.band_min_lpa, band_max_lpa: l.band_max_lpa,
      gate_years: l.gate_years, posted_at: l.posted_at, discovered_at: l.discovered_at,
      focus: !!l.focus, picked: l.status === 'shortlisted', warm, base, fit, expiresIn, seen,
      snoozed_until: l.snoozed_until, claimed_at: l.claimed_at, claimed_note: l.claimed_note,
      note: l.fit_note ? String(l.fit_note).slice(0, 320) : null,
      why: why.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)),
      components: sm.c, conf: sm.k, startup: sm.startup,
      est: isEstimated(l), money_top: sm.money_top,
      features: feats,
    });
  }
  return out.sort((a, b) => b.fit - a.fit || b.base - a.base);
}

/** How many distinct days each target has been served on the Today page without an answer. */
function shownDaysByTarget(target) {
  const rows = all(`SELECT target_id, COUNT(DISTINCT day) d FROM rec_events
                    WHERE target=? AND action='shown' GROUP BY target_id`, target);
  return new Map(rows.map(r => [r.target_id, r.d]));
}

/** Diversified selection: distinct companies, no channel over ~40% of the set. */
export function diversify(ranked, limit) {
  const cap = Math.max(2, Math.ceil(limit * 0.4));
  const picks = [], companies = new Set(), perChan = new Map();
  const key = r => (r.company || '').toLowerCase().trim();
  for (const r of ranked) {
    if (picks.length >= limit) break;
    const ch = (r.channel || '—').toLowerCase();
    if (companies.has(key(r))) continue;
    if ((perChan.get(ch) || 0) >= cap) continue;
    picks.push(r); companies.add(key(r)); perChan.set(ch, (perChan.get(ch) || 0) + 1);
  }
  // Second pass ignores the channel cap so a thin board still fills the session.
  for (const r of ranked) {
    if (picks.length >= limit) break;
    if (companies.has(key(r))) continue;
    picks.push(r); companies.add(key(r));
  }
  return picks;
}

export function picks(limit = +(settings().picks_per_day || 8)) {
  const ranked = rankLeads();
  const chosen = diversify(ranked, limit);
  stampShown('lead', chosen.map(p => p.id));
  return { picks: chosen, eligible: ranked.length,
           snoozed: one(`SELECT COUNT(*) c FROM leads WHERE status IN ('new','shortlisted') AND snoozed_until > date('now')`).c };
}

// ---------- people ----------
//
// Every human reply you have ever had came from a person, not a form. 196 contacts sat in a table
// with no surface. These are ranked on the same principle as leads: what does the record actually
// say — degree, who they are, what they said they were hiring for, and whether the gate fits.

export function contactFeatures(c) {
  const text = `${c.headline || ''} ${c.source_text || ''} ${c.role_hint || ''}`.toLowerCase();
  return [
    `deg:${c.degree || 'unknown'}`, `kind:${c.kind || 'unknown'}`,
    /forward.?deploy(ed|ment)|partner.deployed|\bfde\b|solutions? engineer|deployment engineer/.test(text) ? 'hiring:fde'
      : /ai engineer|agent|llm|gen ?ai|machine learning|ml engineer/.test(text) ? 'hiring:ai' : 'hiring:other',
    `co:${(c.company || '').toLowerCase().trim() || 'unknown'}`,
  ];
}
const parseGate = text => {
  const m = String(text || '').match(/(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*(?:\+\s*)?(?:years?|yrs?)/i) || String(text || '').match(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)/i);
  return m ? +m[1] : null;
};

/**
 * `includeClosed` widens the set past the ones still worth messaging. `outreach()` never wants it —
 * a person already contacted is not a suggestion — but the People tab does: without it, moving a
 * row to "contacted" makes it vanish from the only table that can move it back.
 */
export function rankContacts({ includeSnoozed = false, includeClosed = false } = {}) {
  const tally = learned('contact');
  const shownDays = shownDaysByTarget('contact');
  const liveCompanies = new Set(all(`SELECT lower(company) c FROM leads WHERE status IN ('new','shortlisted','applied')
                                     UNION SELECT lower(company) FROM applications WHERE archived=0
                                     UNION SELECT lower(name) FROM companies WHERE target=1`).map(r => r.c).filter(Boolean));
  const rows = all(`SELECT * FROM contacts
                    WHERE status IN (${includeClosed ? "'new','shortlisted','contacted','replied'" : "'new','shortlisted'"})
                    ${includeSnoozed ? '' : "AND (snoozed_until IS NULL OR snoozed_until <= date('now'))"}`);
  const out = [];
  for (const c of rows) {
    const text = `${c.headline || ''} ${c.source_text || ''} ${c.role_hint || ''}`;
    const tl = text.toLowerCase();
    const why = [];
    let fit = 30;
    if (c.degree === '1st') { fit += 30; why.push({ d: +30, t: '1st-degree connection' }); }
    else if (c.degree === '2nd') { fit += 22; why.push({ d: +22, t: '2nd degree — a mutual can introduce you' }); }
    if (c.mutual) { fit += 8; why.push({ d: +8, t: `mutual: ${c.mutual}` }); }
    const kindBonus = { 'hiring-manager': 15, founder: 12, recruiter: 8, employee: 4 }[c.kind] || 0;
    if (kindBonus) { fit += kindBonus; why.push({ d: +kindBonus, t: c.kind.replace('-', ' ') }); }
    if (/forward.?deploy(ed|ment)|partner.deployed|\bfde\b|solutions? engineer|deployment engineer/.test(tl)) { fit += 16; why.push({ d: +16, t: 'hiring for FDE / solutions' }); }
    else if (/ai engineer|agent|llm|gen ?ai|machine learning|ml engineer|applied ai/.test(tl)) { fit += 9; why.push({ d: +9, t: 'hiring for AI / agents' }); }
    else if (!/hiring|hire|opening|role|position/.test(tl)) { fit -= 6; why.push({ d: -6, t: 'no hiring signal in the post' }); }
    const g = parseGate(text);
    if (g != null) {
      if (g >= 5) { fit -= 18; why.push({ d: -18, t: `${g}+ years asked — out of range` }); }
      else { fit += 8; why.push({ d: +8, t: `${g} years asked — in range` }); }
    }
    if (/\bintern(ship)?\b|fresher|2026 graduates/.test(tl)) { fit -= 20; why.push({ d: -20, t: 'internship / fresher post' }); }
    if (/bengaluru|bangalore|gurgaon|gurugram|noida|delhi|ncr|hyderabad|pune|mumbai|india|remote/.test(tl)) { fit += 5; why.push({ d: +5, t: 'India or remote' }); }
    else if (/\b(us|usa|united states|new york|san francisco|london|dubai|riyadh)\b/.test(tl) && !/india|remote/.test(tl)) { fit -= 12; why.push({ d: -12, t: 'abroad, no remote' }); }
    if (/staffing|consultanc|recruitment (firm|agency)|manpower|talent solutions|bpo/.test(tl)) { fit -= 10; why.push({ d: -10, t: 'staffing / agency' }); }
    if (c.company && liveCompanies.has(c.company.toLowerCase())) { fit += 12; why.push({ d: +12, t: `${c.company} is already on your board` }); }
    const age = ageDays(c.discovered_at);
    if (age != null && age <= 7) { fit += 5; why.push({ d: +5, t: age < 1 ? 'posted today' : `posted ${Math.floor(age)}d ago` }); }
    else if (age != null && age > 21) { fit -= 6; why.push({ d: -6, t: `${Math.floor(age)}d old post` }); }
    const seen = shownDays.get(c.id) || 0;
    if (seen >= 1) { const pen = Math.min(12, 4 * seen); fit -= pen; why.push({ d: -pen, t: `shown ${seen} day${seen > 1 ? 's' : ''}, untouched` }); }
    const feats = contactFeatures(c);
    const L = learnedAdjust(feats, tally);
    fit += L.adj; why.push(...L.why);
    fit = Math.max(0, Math.min(100, Math.round(fit)));
    out.push({
      kind: 'contact', id: c.id, name: c.name, headline: c.headline, company: c.company, degree: c.degree,
      mutual: c.mutual, ckind: c.kind, profile_url: c.profile_url, source_url: c.source_url,
      source: c.source, role_hint: c.role_hint, status: c.status, discovered_at: c.discovered_at,
      snoozed_until: c.snoozed_until, contacted_at: c.contacted_at,
      snippet: c.source_text ? String(c.source_text).slice(0, 360) : null,
      fit, seen, why: why.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)), features: feats,
    });
  }
  return out.sort((a, b) => b.fit - a.fit);
}

export function outreach(limit = +(settings().outreach_per_day || 3)) {
  const ranked = rankContacts();
  const chosen = diversify(ranked.map(r => ({ ...r, company: r.company || r.name })), limit)
    .map(r => ({ ...r, company: ranked.find(x => x.id === r.id).company }));
  stampShown('contact', chosen.map(p => p.id));
  return { picks: chosen, eligible: ranked.length };
}

// ---------- writes ----------

/** Once per target per day. Serving the page a hundred times is one day of being shown. */
function stampShown(target, ids) {
  if (!ids.length) return;
  const d = today();
  const seen = new Set(all(`SELECT target_id FROM rec_events WHERE target=? AND action='shown' AND day=?`, target, d).map(r => r.target_id));
  for (const id of ids) if (!seen.has(id))
    run(`INSERT INTO rec_events (target,target_id,action,day) VALUES (?,?,'shown',?)`, target, id, d);
}

/**
 * Record an answer. This is the only write path the recommender has, and it does the bookkeeping
 * the rest of the system expects: a skipped lead is a dropped lead with its reason preserved, a
 * contacted person is status 'contacted', a snooze is a date. Nothing is deleted.
 */
export function record(target, id, action, { reason = null, days = null } = {}) {
  const s = settings();
  const snoozeDays = days ?? +(s.snooze_days || 3);
  const row = target === 'lead' ? one('SELECT * FROM leads WHERE id=?', id) : one('SELECT * FROM contacts WHERE id=?', id);
  if (!row) return { error: `no such ${target}` };
  const features = target === 'lead' ? featuresOf(row) : contactFeatures(row);
  if (action === 'skipped' && reason && target === 'lead' && REASON_FEATURE[reason]) features.push(REASON_FEATURE[reason](row));
  run(`INSERT INTO rec_events (target,target_id,action,reason,meta_json) VALUES (?,?,?,?,?)`,
      target, id, action, reason, JSON.stringify({ features, company: row.company || row.name, role: row.role || row.headline }));

  if (target === 'lead') {
    if (action === 'skipped')
      run(`UPDATE leads SET status=?, dropped_reason=? WHERE id=?`,
          reason === 'expired' ? 'expired' : 'dropped',
          reason === 'expired' ? 'skipped from Today: posting expired or no apply option'
            : `skipped from Today: ${SKIP_REASONS.find(r => r[0] === reason)?.[1] || reason || 'no reason'}`, id);
    if (action === 'snoozed')
      run(`UPDATE leads SET snoozed_until=date('now', ?) WHERE id=?`, `+${snoozeDays} days`, id);
    if (action === 'opened' && row.status === 'new')
      run(`UPDATE leads SET status='shortlisted' WHERE id=?`, id);   // opening it is a soft yes
  } else {
    if (action === 'skipped')
      run(`UPDATE contacts SET status='dropped', dropped_reason=?, updated_at=datetime('now') WHERE id=?`,
          `skipped from Today: ${reason || 'no reason'}`, id);
    if (action === 'snoozed')
      run(`UPDATE contacts SET snoozed_until=date('now', ?), updated_at=datetime('now') WHERE id=?`, `+${snoozeDays} days`, id);
    if (action === 'contacted')
      run(`UPDATE contacts SET status='contacted', contacted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, id);
    if (action === 'opened' && row.status === 'new')
      run(`UPDATE contacts SET status='shortlisted', updated_at=datetime('now') WHERE id=?`, id);
  }
  return { ok: true, target, id, action, reason };
}

/** Today's session, as counts. `applied` reads the applications table so hand-marked rows count too. */
export function session() {
  const d = today();
  const n = (sql, ...p) => one(`SELECT COUNT(*) c FROM ${sql}`, ...p).c;
  const s = settings();
  return {
    day: d,
    target: +(s.picks_per_day || 8), outreachTarget: +(s.outreach_per_day || 3),
    applied: n(`applications WHERE archived=0 AND status NOT IN ('queued','withdrawn') AND applied_at=?`, d),
    skipped: n(`rec_events WHERE target='lead' AND action='skipped' AND day=?`, d),
    snoozed: n(`rec_events WHERE target='lead' AND action='snoozed' AND day=?`, d),
    opened: n(`rec_events WHERE target='lead' AND action='opened' AND day=?`, d),
    contacted: n(`rec_events WHERE target='contact' AND action='contacted' AND day=?`, d),
    // The last seven days, for the strip under the progress meter.
    week: all(`SELECT applied_at day, COUNT(*) n FROM applications
               WHERE archived=0 AND status NOT IN ('queued','withdrawn') AND applied_at >= date('now','-6 days')
               GROUP BY applied_at`),
  };
}
