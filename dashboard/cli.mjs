#!/usr/bin/env node --no-warnings
// ladder/dashboard/cli.mjs — the write interface. Claude drives the dashboard through this.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, all, one, run, setting, settings, ROOT } from './db.mjs';
import { parseBand, scoreLead, scoreboard, stale, touch, reconcile, normKey, ycAllowance, expireLeads, WARM_SQL, CUTS } from './lib.mjs';
import { scoreV2, scoreOf, persistScore, summary, chips, companyMap, companyFor, parseScore, weights } from './score.mjs';

const BUMP = join(ROOT, '.bump');
const bump = () => { try { writeFileSync(BUMP, String(Date.now())); } catch {} };

// ---------- tiny arg parser: --key value | --key=value | --flag ----------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) o[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) o[a.slice(2)] = argv[++i];
      else o[a.slice(2)] = true;
    } else o._.push(a);
  }
  return o;
}
const out = x => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const die = m => { console.error('error: ' + m); process.exit(1); };
const nowISO = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);

/** Resolve an application by id, or by fuzzy "company" / "company:role". */
function findApp(ref) {
  if (ref == null) return null;
  if (/^\d+$/.test(String(ref))) return one('SELECT * FROM applications WHERE id=?', +ref);
  const [c, r] = String(ref).split(':');
  const rows = all(`SELECT * FROM applications WHERE company LIKE ? ${r ? 'AND role LIKE ?' : ''} AND archived=0`,
    `%${c}%`, ...(r ? [`%${r}%`] : []));
  if (rows.length > 1) die(`ambiguous "${ref}" -> ${rows.map(x => `${x.id}:${x.company}/${x.role}`).join(', ')}`);
  return rows[0];
}

/**
 * Resolve a lead by id, by URL, or by fuzzy "company" / "company:role".
 *
 * The URL path is the one that matters: claims arrive as links you have pasted, and a pasted link
 * almost never matches what the scraper stored byte for byte — it carries the tracking query the
 * board dropped, or a trailing slash, or http against the stored https. So both sides are reduced
 * to host+path before comparing, and a lead whose stored url is a prefix of the pasted one (the
 * `?refId=` case) still matches.
 */
function findLead(ref) {
  if (ref == null) return null;
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return one('SELECT * FROM leads WHERE id=?', +s);
  if (/^https?:\/\//i.test(s)) {
    const norm = u => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase();
    const want = norm(s);
    const rows = all('SELECT * FROM leads WHERE url IS NOT NULL');
    return rows.find(l => norm(l.url) === want)
        || rows.find(l => want.startsWith(norm(l.url)) || norm(l.url).startsWith(want))
        || null;
  }
  const [c, r] = s.split(':');
  const rows = all(`SELECT * FROM leads WHERE company LIKE ? ${r ? 'AND role LIKE ?' : ''}
                    AND status NOT IN ('dropped')`, `%${c}%`, ...(r ? [`%${r}%`] : []));
  if (rows.length > 1) die(`ambiguous "${s}" -> ${rows.map(x => `${x.id}:${x.company}/${x.role}`).join(', ')}`);
  return rows[0];
}

// ---------- upserts (shared by cli + ingest) ----------
export function upsertApplication(a) {
  const band = a.band_min_lpa != null ? { min: a.band_min_lpa, max: a.band_max_lpa } : parseBand(a.band || a.band_raw);
  const cols = {
    company: a.company, role: a.role, location: a.location ?? null,
    channel: (a.channel || '').toLowerCase() || null, url: a.url ?? null,
    external_id: a.external_id ?? a.job_id ?? null,
    band_raw: a.band ?? a.band_raw ?? null, band_min_lpa: band.min, band_max_lpa: band.max,
    gate_years: a.gate_years ?? a.exp_gate ?? null,
    status: a.status || 'applied', fit_score: a.fit_score ?? null,
    applied_at: a.applied_at ?? a.applied ?? null,
    next_action: a.next_action ?? null, next_action_due: a.next_action_due ?? a.due ?? null,
    notes: a.notes ?? null, notes_path: a.notes_path ?? null,
  };
  if (!cols.company || !cols.role) die('application needs --company and --role');
  const existing = one(`SELECT * FROM applications WHERE company=? AND role=?
      AND IFNULL(channel,'')=IFNULL(?,'') AND IFNULL(external_id,'')=IFNULL(?,'')`,
    cols.company, cols.role, cols.channel, cols.external_id);
  if (existing) {
    const keys = Object.keys(cols).filter(k => cols[k] != null);
    run(`UPDATE applications SET ${keys.map(k => `${k}=?`).join(',')}, updated_at=datetime('now'),
         last_activity_at=datetime('now') WHERE id=?`, ...keys.map(k => cols[k]), existing.id);
    return { id: existing.id, created: false };
  }
  const keys = Object.keys(cols);
  const r = run(`INSERT INTO applications (${keys.join(',')}, last_activity_at)
                 VALUES (${keys.map(() => '?').join(',')}, datetime('now'))`, ...keys.map(k => cols[k]));
  const id = Number(r.lastInsertRowid);
  addEvent({ application_id: id, kind: cols.status === 'queued' ? 'note' : 'applied',
             source: cols.channel || 'manual', title: `${cols.status} — ${cols.company} · ${cols.role}` });
  return { id, created: true };
}

export function upsertLead(l) {
  const band = l.band_min_lpa != null ? { min: l.band_min_lpa, max: l.band_max_lpa } : parseBand(l.band || l.band_raw);
  const cols = {
    company: l.company, role: l.role, location: l.location ?? null, channel: (l.channel || '').toLowerCase() || null,
    url: l.url ?? null, band_raw: l.band ?? l.band_raw ?? null, band_min_lpa: band.min, band_max_lpa: band.max,
    gate_years: l.gate_years ?? null, fit_note: l.fit_note ?? null,
    // Left null when the caller does not supply one, so the update branch filters it out.
    // status and dropped_reason are judgement, not scraped data — a nightly re-scrape must
    // never resurrect a lead that was deliberately dropped, taking its drop reason with it.
    status: l.status ?? null, source: l.source ?? null, notes: l.notes ?? null,
    dropped_reason: l.dropped_reason ?? null, posted_at: l.posted_at ?? null,
    company_url: l.company_url ?? null, external_id: l.external_id ?? null,
  };
  if (!cols.company || !cols.role) die('lead needs --company and --role');
  // Score v2 on the incoming columns; a caller-supplied score wins but carries no breakdown, so
  // the recommender computes one lazily the first time it reads the row.
  if (l.score != null) cols.score = l.score;
  else { const r = scoreV2(cols); cols.score = scoreOf(r); cols.score_json = JSON.stringify(r); }
  const existing = one('SELECT * FROM leads WHERE company=? AND role=?', cols.company, cols.role);
  if (existing) {
    // A re-scrape fills blanks; it never overwrites. Comp and location genuinely go stale and
    // should refresh, but fit_note and notes are where judgement lives — a nightly scrape put
    // raw card text over a hand-written "BLOCKED — do not send" note and
    // silently deleted the one thing stopping a bad application going out.
    const curated = ['fit_note', 'notes'];
    const keys = Object.keys(cols).filter(k =>
      cols[k] != null && k !== 'score' && k !== 'score_json' && !(curated.includes(k) && existing[k]));
    // Seeing a lead again in a sweep is the only honest proof it is still listed. discovered_at
    // is when WE found it and never moves, so ageing on that expires live reqs.
    run(`UPDATE leads SET ${keys.map(k => `${k}=?`).join(',')}, last_seen_at=datetime('now') WHERE id=?`,
        ...keys.map(k => cols[k]), existing.id);
    // Rescore against the merged row: scoring reads fit_note, so scoring the scrape-only view
    // is what dropped a lead from 88 to 76 even though its preserved note still matched.
    const merged = one('SELECT * FROM leads WHERE id=?', existing.id);
    const r = scoreV2(merged);
    persistScore(existing.id, r);
    return { id: existing.id, created: false, score: scoreOf(r) };
  }
  // Not in `leads` — but it may have been there and been archived. Without this check a purge is
  // self-defeating: `expired` and `dropped` rows are the only record that a req was already seen
  // and judged, so deleting them lets the next hunt re-insert 540 stale postings as brand-new
  // leads with today's discovered_at, age evidence gone and every drop reason re-litigated.
  const buried = one(`SELECT * FROM leads_archive WHERE company=? AND role=?
                      ORDER BY archived_at DESC LIMIT 1`, cols.company, cols.role);
  if (buried) {
    // A genuinely new posting at the same company and title is the one case worth resurrecting,
    // and the only honest evidence of that is a stated posted_at newer than what was buried.
    // Anything else is the same req coming round again.
    const freshly = cols.posted_at && buried.posted_at && cols.posted_at > buried.posted_at;
    if (!freshly) {
      run(`UPDATE leads_archive SET last_seen_at=datetime('now') WHERE id=?`, buried.id);
      return { id: buried.id, created: false, archived: true,
               why: buried.archived_from, score: buried.score };
    }
  }
  cols.status ??= 'new';                       // only a brand-new lead gets a default status
  const keys = Object.keys(cols);
  const r = run(`INSERT INTO leads (${keys.join(',')}, last_seen_at) VALUES (${keys.map(() => '?').join(',')}, datetime('now'))`, ...keys.map(k => cols[k]));
  return { id: Number(r.lastInsertRowid), created: true, score: cols.score };
}

/** A LinkedIn card as `leads` columns. Signals we used to discard go in the fit note. */
/** "3 days ago" / "2 weeks ago" / "1 month ago" -> an ISO date. Null when the card says nothing. */
export function agoToDate(s) {
  const m = String(s || '').match(/(\d+)\s*(minute|hour|day|week|month)s?\s*ago/i);
  if (!m) return null;
  const n = +m[1], unit = m[2].toLowerCase();
  const mins = unit === 'minute' ? n : unit === 'hour' ? n * 60 : unit === 'day' ? n * 1440
             : unit === 'week' ? n * 10080 : n * 43200;
  return new Date(Date.now() - mins * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function liLead(l) {
  const flags = [
    l.alumni && `${l.alumni} school alumni here`,
    l.connections && `${l.connections} connections here`,
    l.actively_reviewing && 'actively reviewing applicants',
    l.review_time && `reviews in ${l.review_time}`,
    l.easy_apply && 'easy apply',
    // Read by score.mjs off the fit note: top applicant +15, early applicant +10, promoted -10.
    l.top_applicant && 'LinkedIn says top applicant',
    l.early && 'early applicant',
    l.verified && 'verified job',
    l.promoted && 'promoted',
  ].filter(Boolean);
  return {
    // Never a bare "(unknown)". Leads are UNIQUE(company, role), so every unparsed card with the
    // same title used to land on ONE row: a new "Forward Deployed Engineer" from a different
    // employer merged into a row already dropped or applied, and vanished (36 rows in 14 days to
    // 2026-11-02). The job id keeps them apart; enrichment fills the real name from the JD page.
    company: l.company || `(unknown #${l.external_id})`, role: l.role, location: l.location, channel: 'linkedin',
    url: l.url, external_id: l.external_id, band_raw: l.band_raw, source: l.source,
    // Probability decays from the POSTING date, not from when we happened to scrape it.
    posted_at: agoToDate(l.posted),
    // A warm path is the highest-value feature available on this surface: 4 `direct` sends
    // produced 2 humans, 51 aggregator sends produced 0.
    fit_note: flags.length ? flags.join(' · ') : null,
  };
}

export function addEvent(e) {
  const r = run(`INSERT INTO events (application_id, lead_id, ts, kind, source, title, body, meta_json)
                 VALUES (?,?,COALESCE(?,datetime('now')),?,?,?,?,?)`,
    e.application_id ?? null, e.lead_id ?? null, e.ts ?? null, e.kind || 'note',
    e.source ?? null, e.title, e.body ?? null, e.meta_json ? JSON.stringify(e.meta_json) : null);
  if (e.application_id) touch(e.application_id);
  return Number(r.lastInsertRowid);
}

export function addNotification(n) {
  const r = run(`INSERT INTO notifications (level,title,body,source,application_id,lead_id,url)
                 VALUES (?,?,?,?,?,?,?)`,
    n.level || 'info', n.title, n.body ?? null, n.source ?? null,
    n.application_id ?? null, n.lead_id ?? null, n.url ?? null);
  return Number(r.lastInsertRowid);
}

// ---------- command table ----------
const cmds = {
  'app add': a => out(upsertApplication(a)),
  'app set': a => {
    const app = findApp(a._[2] ?? a.id) || die('no such application');
    const map = { status: 'status', next: 'next_action', due: 'next_action_due', notes: 'notes',
                  fit: 'fit_score', url: 'url', band: 'band_raw', location: 'location',
                  role: 'role', applied: 'applied_at', 'notes-path': 'notes_path' };
    const patch = {};
    for (const [flag, col] of Object.entries(map)) if (a[flag] !== undefined) patch[col] = a[flag];
    if (a.band !== undefined) { const b = parseBand(a.band); patch.band_min_lpa = b.min; patch.band_max_lpa = b.max; }
    if (a.archive) patch.archived = 1;
    if (!Object.keys(patch).length) die('nothing to set');
    if (patch.status && patch.status !== app.status)
      addEvent({ application_id: app.id, kind: 'status_change', source: a.source || 'manual',
                 title: `${app.status} → ${patch.status}`, body: a.why ?? null });
    touch(app.id, patch);
    out({ id: app.id, company: app.company, ...patch });
  },
  'app list': a => {
    const w = ['archived=0'], p = [];
    if (a.status) { w.push(`status IN (${a.status.split(',').map(() => '?').join(',')})`); p.push(...a.status.split(',')); }
    if (a.channel) { w.push('channel=?'); p.push(a.channel); }
    if (a.live) w.push("status IN ('replied','screen','interview','offer')");
    if (a.floor) w.push(`COALESCE(band_max_lpa,band_min_lpa) >= ${parseFloat(setting('floor_lpa'))}`);
    const rows = all(`SELECT * FROM applications WHERE ${w.join(' AND ')} ORDER BY
                      CASE status WHEN 'offer' THEN 0 WHEN 'interview' THEN 1 WHEN 'screen' THEN 2
                      WHEN 'replied' THEN 3 WHEN 'viewed' THEN 4 ELSE 5 END,
                      COALESCE(band_max_lpa,0) DESC, id`, ...p);
    if (a.json) return out(rows);
    out(rows.map(r => `${String(r.id).padStart(3)} ${(r.status).padEnd(10)} ${(r.channel || '-').padEnd(10)} ` +
      `${(r.band_max_lpa ? r.band_min_lpa + '-' + r.band_max_lpa + 'L' : '—').padEnd(12)} ${r.company} · ${r.role}`).join('\n')
      || '(none)');
  },
  'app show': a => {
    const app = findApp(a._[2]) || die('no such application');
    out({ ...app, events: all('SELECT ts,kind,source,title,body FROM events WHERE application_id=? ORDER BY ts DESC', app.id),
          comp: all('SELECT * FROM comp_points WHERE application_id=?', app.id) });
  },
  'event add': a => out({ id: addEvent({
      application_id: a.app ? (findApp(a.app) || die('no such application')).id : null,
      kind: a.kind, source: a.source, title: a.title || die('--title required'), body: a.body, ts: a.ts }) }),
  'lead add': a => out(upsertLead(a)),
  'lead list': a => {
    const w = [], p = [];
    if (a.status) { w.push(`status IN (${a.status.split(',').map(() => '?').join(',')})`); p.push(...a.status.split(',')); }
    else w.push("status IN ('new','shortlisted')");
    if (a.floor) w.push(`COALESCE(band_max_lpa,band_min_lpa) >= ${parseFloat(setting('floor_lpa'))}`);
    const rows = all(`SELECT * FROM leads WHERE ${w.join(' AND ')} ORDER BY score DESC, COALESCE(band_max_lpa,0) DESC LIMIT ?`,
      ...p, +(a.limit || 40));
    if (a.json) return out(rows);
    out(rows.map(r => `${String(r.score).padStart(3)}  ${(r.band_max_lpa ? r.band_min_lpa + '-' + r.band_max_lpa + 'L' : '—').padEnd(12)} ` +
      `${(r.channel || '-').padEnd(10)} ${r.company} · ${r.role}  ${r.url || ''}`).join('\n') || '(none)');
  },
  // Judging the board is the sweep agent's job and the CLI has to make it one command.
  // Postings close, and a lead is only a claim made at scrape time. `--drop` marks the dead ones
  // so a manual pass over the board never spends attention on a req that is already filled.
  // Run daily from the sweep. The cap is invisible until you hit it, so the useful moment to say
  // something is when a slot comes *back* and there are drafts waiting on it.
  'yc check': () => {
    const y = ycAllowance();
    if (y.remaining > 0 && y.queued > 0) {
      addNotification({ level: 'signal', source: 'apply',
        title: `YC: ${y.remaining} application${y.remaining === 1 ? '' : 's'} available again`,
        body: `${y.queued} YC draft${y.queued === 1 ? ' is' : 's are'} waiting. Cap is about ${y.cap} a week and it is not published anywhere, so this is measured from your own sends.` });
      setting('yc_cap_hit_at', '');            // the window has moved on; stop suppressing
    }
    out(y);
  },
  'lead live': async a => {
    const { checkLeads } = await import('./sweep/liveness.mjs');
    const ids = a.ids ? String(a.ids).split(',').map(Number) : null;
    const r = await checkLeads({ ids, limit: +(a.limit || 60), drop: !!a.drop });
    out({ checked: r.checked, live: r.live, dead: r.dead.length, unknown: r.unknown,
          dropped: a.drop ? r.dead.length : 0, deadList: r.dead });
  },
  'lead drop': a => {
    const id = +(a._[2] || a.id || die('lead id required'));
    const l = one('SELECT * FROM leads WHERE id=?', id) || die(`no lead ${id}`);
    run("UPDATE leads SET status='dropped', dropped_reason=? WHERE id=?", a.why || a.reason || 'dropped', id);
    addEvent({ lead_id: id, kind: 'note', source: a.source || 'manual',
               title: `Dropped lead: ${l.company} — ${l.role}`, body: a.why || null });
    out({ dropped: id, company: l.company, role: l.role, why: a.why || null });
  },
  'lead promote': a => {
    const l = one('SELECT * FROM leads WHERE id=?', +(a._[2] || a.id)) || die('no such lead');
    const r = upsertApplication({ ...l, status: a.status || 'applied', applied_at: a.applied || today(), band_raw: l.band_raw });
    run("UPDATE leads SET status='applied', claimed_at=NULL, claimed_note=NULL WHERE id=?", l.id);
    out({ promoted: l.company + ' · ' + l.role, application: r });
  },
  // ---- claims: "Claude has this one" ----------------------------------------------------------
  // You paste a batch of links for me to apply to, and by the time I am three forms deep you can
  // no longer tell which rows you handed over. A claim highlights the lead on the board for exactly
  // as long as I am working on it. It is deliberately not a status: the lead keeps its own status,
  // its score and its place in the ranking, so a claim that is never released costs nothing but a
  // colour. Promoting the lead to an application clears it automatically.
  'lead claim': a => {
    const l = findLead(a._[2] ?? a.id) || die('no such lead — pass an id, or a url/company that matches one');
    run("UPDATE leads SET claimed_at=datetime('now'), claimed_note=? WHERE id=?", a.note ?? null, l.id);
    out({ claimed: l.id, company: l.company, role: l.role, note: a.note ?? null });
  },
  'lead unclaim': a => {
    const t = a._[2] ?? a.id;
    if (t === 'all') {
      const n = all('SELECT id FROM leads WHERE claimed_at IS NOT NULL').length;
      run('UPDATE leads SET claimed_at=NULL, claimed_note=NULL WHERE claimed_at IS NOT NULL');
      return out({ released: n });
    }
    const l = findLead(t) || die('no such lead');
    run('UPDATE leads SET claimed_at=NULL, claimed_note=NULL WHERE id=?', l.id);
    out({ released: l.id, company: l.company, role: l.role });
  },
  'lead claimed': () => {
    const rows = all(`SELECT id, company, role, channel, status, url, claimed_at, claimed_note,
                             CAST((julianday('now') - julianday(claimed_at)) * 24 * 60 AS INT) held_minutes
                      FROM leads WHERE claimed_at IS NOT NULL ORDER BY claimed_at`);
    out(rows.length ? rows : '(nothing claimed)');
  },
  'notify': a => out({ id: addNotification({ level: a.level, title: a.title || die('--title required'),
      body: a.body, source: a.source, url: a.url,
      application_id: a.app ? (findApp(a.app) || {}).id : null }) }),
  'notif read': a => {
    const t = a._[2] || 'all';
    if (t === 'all') run("UPDATE notifications SET read_at=datetime('now') WHERE read_at IS NULL");
    else run("UPDATE notifications SET read_at=datetime('now') WHERE id=?", +t);
    out('ok');
  },
  'notif list': a => out(all(`SELECT * FROM notifications ${a.all ? '' : 'WHERE read_at IS NULL'} ORDER BY ts DESC LIMIT 50`)),
  'study log': a => {
    run('INSERT INTO study_log (day,minutes,section,topic,notes) VALUES (?,?,?,?,?)',
      a.day || today(), +(a.minutes || die('--minutes required')), a.section ?? null, a.topic ?? null, a.notes ?? null);
    const s = scoreboard().study;
    out({ logged: +a.minutes, today: s.today, goal: s.goal, streak: s.streak });
  },
  'syllabus set': a => {
    const lvl = a.level || die('--level gap|read|solid');
    const r = run(`UPDATE syllabus_items SET level=?, done=?, updated_at=datetime('now')
                   WHERE section=? AND title LIKE ?`, lvl, lvl === 'solid' ? 1 : 0,
                   a.section || die('--section'), `%${a.title || die('--title')}%`);
    out({ updated: r.changes });
  },
  'syllabus list': a => out(all(`SELECT section,title,level FROM syllabus_items
      ${a.section ? 'WHERE section=?' : a.gaps ? "WHERE level='gap'" : ''} ORDER BY section,id`,
      ...(a.section ? [a.section] : []))),
  'call add': a => {
    const app = a.app ? findApp(a.app) : null;
    const r = run(`INSERT INTO calls (ts,company,application_id,kind,with_whom,outcome,summary,notes_path)
                   VALUES (?,?,?,?,?,?,?,?)`, a.ts || nowISO(), a.company ?? app?.company ?? null,
      app?.id ?? null, a.kind || 'screen', a.with || null, a.outcome || 'pending', a.summary ?? null, a['notes-path'] ?? null);
    if (app) touch(app.id, { status: a.status || 'screen' });
    out({ id: Number(r.lastInsertRowid) });
  },
  'comp add': a => {
    const app = a.app ? findApp(a.app) : null;
    const b = a.band ? parseBand(a.band) : { min: a.min != null ? +a.min : null, max: a.max != null ? +a.max : null };
    run('INSERT INTO comp_points (application_id,company,kind,lpa_min,lpa_max,source,note) VALUES (?,?,?,?,?,?,?)',
      app?.id ?? null, a.company ?? app?.company ?? null, a.kind || 'posted', b.min, b.max, a.source ?? null, a.note ?? null);
    out({ ok: true, ...b });
  },
  'outbox add': a => {
    const hold = +(setting('outbox_hold_minutes') || 30);
    const r = run(`INSERT INTO outbox (kind,channel,to_addr,subject,body,application_id,status,release_at)
                   VALUES (?,?,?,?,?,?,?, datetime('now', '+' || ? || ' minutes'))`,
      a.kind || 'reply', a.channel || 'gmail', a.to || null, a.subject || null,
      a.body || die('--body required'), a.app ? (findApp(a.app) || {}).id ?? null : null,
      hold > 0 ? 'held' : 'approved', hold);
    addNotification({ level: 'signal', title: `Outbox: ${a.subject || a.kind}`,
      body: hold > 0 ? `Held ${hold} min — cancel in the dashboard to stop it.` : 'Queued for immediate send.' });
    out({ id: Number(r.lastInsertRowid), held_minutes: hold });
  },
  'outbox list': () => out(all("SELECT * FROM outbox WHERE status IN ('held','approved') ORDER BY id")),
  'outbox cancel': a => { run("UPDATE outbox SET status='cancelled' WHERE id=?", +(a._[2] || a.id)); out('cancelled'); },
  'outbox due': () => out(all("SELECT * FROM outbox WHERE status='approved' OR (status='held' AND datetime('now') >= release_at)")),
  'outbox sent': a => { run("UPDATE outbox SET status='sent', sent_at=datetime('now'), result=? WHERE id=?",
      a.result || 'ok', +(a._[2] || a.id)); out('ok'); },
  'sweep start': () => { const r = run('INSERT INTO sweeps DEFAULT VALUES'); out({ sweep_id: Number(r.lastInsertRowid) }); },
  // What the last few sweeps actually reached. The sweep agent reads this instead of re-scraping.
  'sweep list': a => out(all(`SELECT id, started_at, finished_at, findings, ok, channels, brief
                              FROM sweeps ORDER BY id DESC LIMIT ?`, +(a.limit || 3))),
  'sweep finish': a => {
    run(`UPDATE sweeps SET finished_at=datetime('now'), channels=?, findings=?, ok=?, brief=?, log=? WHERE id=?`,
      a.channels ?? null, +(a.findings || 0), a.failed ? 0 : 1, a.brief ?? null, a.log ?? null, +(a.id || die('--id')));
    out('ok');
  },
  'set': a => { const [k, v] = a._.slice(1); if (!k) return out(settings()); out({ [k]: setting(k, v) }); },
  'reconcile': () => out(reconcile()),
  'export': () => {
    const dump = {};
    for (const t of ['applications','events','leads','notifications','syllabus_items','study_log',
                     'calls','comp_points','sweeps','outbox','companies','kv'])
      dump[t] = all(`SELECT * FROM ${t}`);
    const p = join(ROOT, 'export', 'ladder-export.json');
    mkdirSync(join(ROOT, 'export'), { recursive: true });
    writeFileSync(p, JSON.stringify(dump, null, 1));
    out({ written: p, rows: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length])) });
  },
  'stats': () => out(scoreboard()),
  'stale': a => out(stale(+(a.days || 7))),
  'brief': () => out(renderBrief()),
  'ingest': async a => {
    const src = a._[1] || '-';
    const raw = src === '-' ? await new Promise(r => { let d = ''; process.stdin.on('data', c => d += c).on('end', () => r(d)); })
                            : (await import('node:fs')).readFileSync(src, 'utf8');
    const p = JSON.parse(raw);
    const res = { applications: [], leads: [], events: 0, notifications: 0, calls: 0, comp: 0, study: 0 };
    for (const x of p.applications || []) res.applications.push(upsertApplication(x));
    for (const x of p.leads || []) res.leads.push(upsertLead(x));
    for (const x of p.events || []) { const app = x.app ? findApp(x.app) : null;
      addEvent({ ...x, application_id: x.application_id ?? app?.id ?? null }); res.events++; }
    for (const x of p.notifications || []) { const app = x.app ? findApp(x.app) : null;
      addNotification({ ...x, application_id: x.application_id ?? app?.id ?? null }); res.notifications++; }
    for (const x of p.study || []) { run('INSERT INTO study_log (day,minutes,section,topic,notes) VALUES (?,?,?,?,?)',
      x.day || today(), +x.minutes, x.section ?? null, x.topic ?? null, x.notes ?? null); res.study++; }
    out({ ingested: res, created_apps: res.applications.filter(x => x.created).length,
          created_leads: res.leads.filter(x => x.created).length });
  },

  // ---------- today: the same session the dashboard serves, in a terminal ----------
  // Same modules, same stamps — running this counts as having been shown the cards, exactly as
  // opening the page does. There is no second ranking to drift out of step with the first.
  'today': async () => {
    const { agenda } = await import('./today.mjs');
    const { picks, outreach, session } = await import('./recommend.mjs');
    const L = [];
    const se = session();
    L.push(`${se.day} — applied ${se.applied} of ${se.target}` +
           [se.skipped && `, skipped ${se.skipped}`, se.snoozed && `, snoozed ${se.snoozed}`,
            se.contacted && `, messaged ${se.contacted}`].filter(Boolean).join(''), '');

    const ag = agenda();
    L.push('## Agenda');
    if (!ag.total) L.push('  nothing dated');
    for (const g of ag.groups) {
      if (!g.items.length) continue;
      L.push(`  ${g.label}`);
      for (const i of g.items)
        L.push(`    [${i.kind}] ${i.title}${i.company ? ' — ' + i.company : ''}` +
               `${i.sub ? ' · ' + i.sub : ''} (${i.inDays < 0 ? `${-i.inDays}d overdue` : i.inDays === 0 ? (i.time || 'today') : `in ${i.inDays}d`})`);
    }

    const p = picks();
    L.push('', `## Apply to these (${p.picks.length} of ${p.eligible} eligible, ${p.snoozed} snoozed)`);
    for (const x of p.picks)
      L.push(`  ${String(x.fit).padStart(3)} #${x.id} ${x.company} · ${x.role}` +
             `\n      ${x.why.slice(0, 2).map(w => `${w.d > 0 ? '+' + w.d + ' ' : w.d < 0 ? w.d + ' ' : ''}${w.t}`).join('; ')}` +
             `\n      ${x.url || '(no url)'}`);

    const o = outreach();
    L.push('', `## Message these (${o.picks.length} of ${o.eligible})`);
    for (const x of o.picks)
      L.push(`  ${String(x.fit).padStart(3)} #${x.id} ${x.name}${x.company ? ' · ' + x.company : ''}` +
             `\n      ${x.why.slice(0, 2).map(w => w.t).join('; ')}` +
             `\n      ${x.profile_url || ''}`);
    out(L.join('\n'));
  },

  // ---------- agenda: the hand-entered half, the part no query can know ----------
  'agenda add': async a => {
    const { agendaAdd } = await import('./today.mjs');
    const r = agendaAdd({ title: a.title || die('--title required'), day: a.day || die('--day required (YYYY-MM-DD)'),
                          time: a.time, kind: a.kind, company: a.company, notes: a.notes });
    if (r.error) die(r.error);
    out(r);
  },
  'agenda done': async a => {
    const { agendaDone } = await import('./today.mjs');
    out(agendaDone(+(a._[2] || a.id) || die('--id required'), !a.undo));
  },
  'agenda list': () => out(all(`SELECT id, day, time, kind, title, company, done_at FROM agenda ORDER BY day, time`)),

  // ---------- pick: answer a recommendation without the dashboard ----------
  // `./ladder pick skip 41 --reason senior` | `./ladder pick snooze 41 [--days 5]`
  'pick': async a => {
    const { record, SKIP_REASONS } = await import('./recommend.mjs');
    const [, verb, ref] = a._;
    const id = +ref;
    if (!id) die('usage: ladder pick skip|snooze|applied|opened <leadId> [--reason r] [--days n]');
    const action = { skip: 'skipped', snooze: 'snoozed', applied: 'applied', open: 'opened', opened: 'opened' }[verb]
                   || die(`unknown "${verb}" — one of skip, snooze, applied, opened`);
    if (action === 'skipped' && a.reason && !SKIP_REASONS.some(r => r[0] === a.reason))
      die(`unknown --reason "${a.reason}" — one of ${SKIP_REASONS.map(r => r[0]).join(', ')}`);
    const r = record(a.contact ? 'contact' : 'lead', id, action, { reason: a.reason ?? null, days: a.days ? +a.days : null });
    if (r.error) die(r.error);
    out(r);
  },

  // ---------- expire: clear listings the sweep has stopped seeing ----------
  'expire': async a => out(expireLeads({ days: +(a.days || 10), dryRun: !!a.dry })),

  // ---------- clean: load wide, clean after (clean.mjs) ----------
  //   ladder clean [--dry] [--all]            lanes + off-lane drops + cross-channel dedupe
  //   ladder clean undo --rule off-lane|duplicate [--since YYYY-MM-DD] [--dry]
  //   ladder clean recheck [--dry]            after a lane.mjs change, in both directions
  'clean': async a => {
    const C = await import('./clean.mjs');
    out(C.cleanLeads({ dry: !!a.dry, everything: !!a.all }));
  },
  'clean undo': async a => {
    const C = await import('./clean.mjs');
    out(C.undoClean({ rule: a.rule || 'off-lane', since: a.since || null, dry: !!a.dry }));
  },
  'clean recheck': async a => {
    const C = await import('./clean.mjs');
    out(C.recheckLanes({ dry: !!a.dry }));
  },

  // ---------- linkedin: four surfaces, not one ----------
  // Collections are Premium-ranked and need no keywords; job search is
  // ad-polluted and being retired; posts carry the people who never had a row to land in.
  'linkedin': async a => {
    const { newPage } = await import('./sweep/browser.mjs');
    const LI = await import('./sweep/linkedin.mjs');
    const say = m => process.stderr.write(m + '\n');
    const only = a.only ? String(a.only).split(',').map(x => x.trim()) : ['collections', 'search', 'posts', 'messages'];
    const res = { leads: { scanned: 0, ads: 0, kept: 0, created: 0, updated: 0 }, contacts: { seen: 0, created: 0 }, messages: null, surfaces: [] };
    const t0 = Date.now();

    if (only.includes('collections')) {
      say('--- collections ---');
      // Depth is per collection (LI.COLLECTIONS); --pages overrides it for a quick test.
      const { leads, report } = await LI.scrapeCollections(newPage, { pages: a.pages ? +a.pages : null, log: say });
      for (const r of report) { res.leads.scanned += r.scanned || 0; res.leads.ads += r.promoted || 0; }
      for (const l of leads) { const r = upsertLead(liLead(l)); r.created ? res.leads.created++ : res.leads.updated++; }
      res.leads.kept += leads.length; res.surfaces.push(...report);
    }
    if (only.includes('search')) {
      // --backfill reads the past week 4 pages deep; a daily run reads 3 days, 3 deep.
      say('--- job search (AI search) ---');
      const { leads, report } = await LI.scrapeSearch(newPage, {
        window: a.window || (a.backfill ? 'week' : '3d'), pages: +(a['search-pages'] || (a.backfill ? 4 : 3)),
        queries: a.q ? [String(a.q)] : null, log: say });
      for (const r of report) { res.leads.scanned += r.scanned || 0; res.leads.ads += r.promoted || 0; }
      for (const l of leads) { const r = upsertLead(liLead(l)); r.created ? res.leads.created++ : res.leads.updated++; }
      res.leads.kept += leads.length; res.surfaces.push(...report);
    }
    if (only.includes('posts')) {
      say('--- posts (people) ---');
      const { contacts, jobs, report } = await LI.scrapePosts(newPage, {
        queries: a.q ? [String(a.q)] : undefined, log: say });
      res.contacts.seen = contacts.length; res.surfaces.push(...report);
      // Reqs embedded in hiring posts. These are the ones that often never reach job search.
      res.postJobs = { seen: jobs.length, created: 0 };
      for (const j of jobs) {
        const r = upsertLead({ company: j.company, role: j.role, location: j.location,
                               channel: 'linkedin', url: j.url, external_id: j.external_id,
                               source: j.source, fit_note: j.fit_note });
        if (r.created) res.postJobs.created++;
      }
      for (const c of contacts) {
        const r = run(`INSERT OR IGNORE INTO contacts (name, profile_url, headline, degree, kind, source, source_url, source_text, role_hint, status)
                       VALUES (?,?,?,?,?,?,?,?,?,'new')`,
          c.name || '(unknown)', c.profile_url, c.headline ?? null, c.degree ?? null,
          c.recruiter ? 'recruiter' : 'employee', 'linkedin-post',
          'https://www.linkedin.com/search/results/content/?keywords=' + encodeURIComponent(c.query),
          c.text ?? null, c.query ?? null);
        if (r.changes) res.contacts.created++;
      }
    }
    if (only.includes('messages')) {
      say('--- messages ---');
      const m = await LI.sweepMessages(newPage, { log: say });
      res.messages = { threads: m.threads.length, awaiting: m.awaitingHim.length, ok: m.ok };
      // Age of an unanswered inbound is the metric, not unread count: a warm thread once
      // sat read for 8 days and nothing flagged it.
      //
      // But "you did not speak last" is not the same as "you owe a reply", and the gap between
      // those two showed up as a red alert every single morning. Emmanuel Vandewiele's last
      // message is "Thank you! All the best" — the sign-off on a rejection that was fully closed
      // on both sides — and Shubhashree Mohapatra's is small talk from a peer. Both were raised
      // on three consecutive mornings, and Shubhashree's stood four times unread at once. An
      // alert that cries wolf daily trains you to skim the one morning it is real.
      //
      // Two guards, both deliberately using state that already exists and is visible in the UI:
      //   1. A snoozed contact is one you have decided about. Skip it until the snooze runs out.
      //   2. Never raise the same thread twice while the last alert for it is still unread.
      const closedThread = name => {
        const c = one(`SELECT snoozed_until, status FROM contacts
                       WHERE lower(name)=lower(?) LIMIT 1`, name);
        if (!c) return false;
        if (c.status === 'dropped') return true;
        return !!(c.snoozed_until && c.snoozed_until > new Date().toISOString().slice(0, 10));
      };
      for (const t of m.awaitingHim) {
        const title = `LinkedIn: ${t.name} is waiting on a reply`;
        if (closedThread(t.name)) { say(`  · ${t.name} — snoozed or dropped, not raising`); continue; }
        if (one(`SELECT id FROM notifications WHERE title=? AND read_at IS NULL LIMIT 1`, title)) {
          say(`  · ${t.name} — unread alert already stands, not raising again`); continue;
        }
        addNotification({ level: 'signal', source: 'linkedin-dm', title,
          body: `${t.stamp} — ${t.preview || '(no preview parsed; open the thread)'}` });
      }
    }
    res.seconds = Math.round((Date.now() - t0) / 1000);
    out(res);
  },

  // ---------- portals ingest: rows collected by hand, through the scraper's own filters ----------
  // For channels the sweep browser cannot reach (Glassdoor's "Humans only" wall since ~5 Oct):
  // the rows are read in your own logged-in Chrome during a session and land here.
  //   ladder portals ingest --channel glassdoor --file rows.json
  // rows.json: [{ role, company, location, url, external_id, posted, text }]
  'portals ingest': async a => {
    const { filterRows } = await import('./sweep/portals.mjs');
    const ch = a.channel || die('--channel <key>');
    const rows = JSON.parse((await import('node:fs')).readFileSync(a.file || die('--file rows.json'), 'utf8'));
    const { leads, counts } = filterRows(ch, rows, { floor: +(setting('discovery_floor_lpa') || 18) });
    let created = 0, archived = 0;
    for (const l of leads) { const r = upsertLead(l); if (r.created) created++; if (r.archived) archived++; }
    out({ rows: rows.length, kept: counts.kept, gated: counts.gated, created, alreadyArchived: archived });
  },

  // ---------- portals: the unattended browser sweep ----------
  // Naukri, Indeed, Glassdoor and Internshala serve full results logged out and need no
  // credentials at all. Wellfound, YC and LinkedIn are behind a login and only run once
  // `ladder browser login` has seeded the profile — pass --all to include them.
  'portals': async a => {
    const { sweepPortals, PORTALS, OPEN_PORTALS } = await import('./sweep/portals.mjs');
    const only = a.only ? String(a.only).split(',').map(x => x.trim())
               : a.all  ? Object.keys(PORTALS)
               : OPEN_PORTALS;
    const floor = a.floor != null ? +a.floor : +(setting('discovery_floor_lpa') || 18);
    const sweepId = Number(run('INSERT INTO sweeps DEFAULT VALUES').lastInsertRowid);
    const say = m => process.stderr.write(m + '\n');
    say(`portal sweep #${sweepId} — ${only.join(', ')} — floor ₹${floor}L`);

    let res;
    try {
      res = await sweepPortals({ only, floor, headless: !a.headful, log: say });
    } catch (e) {
      run("UPDATE sweeps SET finished_at=datetime('now'), ok=0, brief=? WHERE id=?", 'portal sweep failed: ' + e.message, sweepId);
      addNotification({ level: 'urgent', source: 'portals', title: 'Portal sweep failed', body: e.message });
      die(e.message);
    }

    const { setCompanyFacts } = await import('./sweep/enrich.mjs');
    const fresh = [];
    for (const l of res.leads) {
      const r = upsertLead(l);
      if (r.created) fresh.push({ ...l, id: r.id, score: r.score });
      // The YC batch is a company fact read off the card for free; it fills a blank, never more.
      if (l.yc_batch) setCompanyFacts(l.company, { yc_batch: l.yc_batch }, { source: 'yc card' });
    }
    // Only a genuinely strong new lead is worth an interrupt; the rest wait on the board.
    for (const l of fresh.filter(x => x.score >= CUTS.prime).sort((x, y) => y.score - x.score).slice(0, 5))
      addNotification({ level: 'signal', source: 'portals', lead_id: l.id, url: l.url,
        title: `New lead ${l.score}: ${l.company} — ${l.role}`,
        body: `${l.band_raw || 'band not stated'} · ${l.location || 'location not stated'} · via ${l.channel}` });

    // Portal status -> our vocabulary. Writing an event for all six every morning is noise that
    // buries the one row that actually moved, so only a *change* is recorded, and only forward
    // movement interrupts.
    const STATUS_MAP = { pending: 'applied', viewed: 'viewed', seen: 'viewed', replied: 'replied',
                         interviewing: 'interview', 'not a fit': 'rejected', rejected: 'rejected',
                         hired: 'offer', archived: 'rejected' };
    const RANK = { queued: 0, applied: 1, viewed: 2, replied: 3, screen: 4, interview: 5, offer: 6 };
    let moved = 0;
    for (const st of res.statuses || []) {
      const mapped = STATUS_MAP[String(st.status_raw || '').toLowerCase()];
      if (!mapped || !st.company) continue;
      const app = all('SELECT * FROM applications WHERE archived=0')
        .find(a => normKey(a.company) === normKey(st.company)
                && (!st.role || normKey(a.role) === normKey(st.role) || RANK[a.status] != null));
      if (!app || app.status === mapped) continue;
      run("UPDATE applications SET status=?, updated_at=datetime('now'), last_activity_at=datetime('now') WHERE id=?", mapped, app.id);
      addEvent({ application_id: app.id, kind: 'status_change', source: st.channel,
                 title: `${app.company} — ${app.status} → ${mapped}`, body: st.text });
      if ((RANK[mapped] ?? 0) > (RANK[app.status] ?? 0))
        addNotification({ level: 'urgent', source: st.channel, application_id: app.id,
          title: `${app.company} moved to "${st.status_raw}"`, body: st.text });
      moved++;
    }
    if (moved) say(`  ${moved} application status change(s) picked up`);

    const okCount = res.channels.filter(c => c.ok).length;
    const brief = [`Portal sweep: ${res.leads.length} in lane, ${fresh.length} new, ${okCount}/${res.channels.length} channels ok.`,
                   ...res.channels.map(c => `- ${c.channel}: ${c.ok ? 'ok' : 'FAILED'} — ${c.note}`)].join('\n');
    run("UPDATE sweeps SET finished_at=datetime('now'), channels=?, findings=?, ok=?, brief=? WHERE id=?",
        JSON.stringify(res.channels), fresh.length, okCount ? 1 : 0, brief, sweepId);
    reconcile();
    out({ sweep_id: sweepId, scanned_in_lane: res.leads.length, new_leads: fresh.length,
          channels: res.channels, top: fresh.sort((x, y) => y.score - x.score).slice(0, 10)
            .map(l => ({ score: l.score, company: l.company, role: l.role, band: l.band_raw, url: l.url })) });
  },

  // Put a band on everything that lacks one. AmbitionBox where the company has reported data,
  // heuristic otherwise, and always labelled so the board can tell a guess from a fact.
  'bands': async a => {
    const B = await import('./sweep/browser.mjs');
    const { bandFor } = await import('./sweep/estimate.mjs');
    const limit = +(a.limit || 400);
    const rows = all(`SELECT * FROM leads
                      WHERE band_min_lpa IS NULL AND band_max_lpa IS NULL
                        AND status IN ('new','shortlisted')
                      ORDER BY score DESC LIMIT ?`, limit);
    if (!rows.length) return out({ done: true, note: 'every open lead already has a band' });
    await B.launch({ headless: true });
    let ab = 0, est = 0, none = 0;
    for (const l of rows) {
      const b = await bandFor(l, B.newPage, { online: !a.offline });
      if (!b) { none++; continue; }
      run('UPDATE leads SET band_min_lpa=?, band_max_lpa=?, band_basis=?, band_raw=COALESCE(band_raw,?) WHERE id=?',
          b.min, b.max, b.basis, b.basis.startsWith('ambitionbox') ? `~₹${b.min}–${b.max}L (AmbitionBox)` : `~₹${b.min}–${b.max}L (est)`, l.id);
      b.basis.startsWith('ambitionbox') ? ab++ : est++;
      process.stderr.write(`  ${String(l.company).slice(0,26).padEnd(28)}₹${b.min}-${b.max}L  ${b.basis}\n`);
      await new Promise(r => setTimeout(r, a.offline ? 0 : 400));   // be a courteous reader
    }
    reconcile();
    out({ processed: rows.length, ambitionbox: ab, estimated: est, no_basis: none });
  },

  // ---------- the send path ----------
  'apply queue': async a => {
    const A = await import('./sweep/apply.mjs');
    const res = A.queue({
      minScore: +(a['min-score'] || CUTS.strong),
      floor: a.floor != null ? +a.floor : parseFloat(setting('floor_lpa')),
      limit: +(a.limit || 100),
      channels: a.channels ? String(a.channels).split(',').map(x => x.trim()) : null,
    });
    const byMode = {};
    for (const q of res.queued) (byMode[q.mode] ??= []).push(q);
    out({ queued: res.queued.length, by_mode: Object.fromEntries(Object.entries(byMode).map(([k, v]) => [k, v.length])),
          already_applied: res.skipped_applied, blocked_by_factcheck: res.blocked,
          sample: res.queued.slice(0, 10) });
  },
  'apply list': a => {
    const rows = all(`SELECT id, company, role, channel, fit_score, band_raw, url
                      FROM applications WHERE status='queued' AND archived=0
                      ORDER BY fit_score DESC LIMIT ?`, +(a.limit || 60));
    if (a.json) return out(rows);
    const A_MODE = { wellfound: 'auto', 'yc-waas': 'auto', indeed: 'external', glassdoor: 'external', hn: 'external' };
    out(rows.map(r => `${String(r.fit_score).padStart(3)}  ${(A_MODE[r.channel] || 'assisted').padEnd(9)}` +
      `${(r.channel || '-').padEnd(12)}${r.company} · ${r.role}`).join('\n') || '(queue is empty)');
  },
  'apply show': a => {
    const app = findApp(a._[2] || a.id) || die('application not found');
    out(`${app.company} · ${app.role}\n${app.url}\nchannel: ${app.channel} · band: ${app.band_raw || '—'}\n\n${app.notes || '(no draft)'}`);
  },
  // Mark one as actually sent, once it has been. Keeps the board honest about what left.
  'apply sent': a => {
    const app = findApp(a._[2] || a.id) || die('application not found');
    run(`UPDATE applications SET status='applied', applied_at=date('now'),
         last_activity_at=datetime('now') WHERE id=?`, app.id);
    addEvent({ application_id: app.id, kind: 'applied', source: a.source || app.channel,
               title: `Applied: ${app.company} — ${app.role}` });
    out({ ok: true, id: app.id, company: app.company });
  },

  // ---------- enrich: read the posting and the company page ----------
  // Runs inside every hunt after reconcile; also by hand. `--dry` reads and reports, writes nothing.
  'enrich': async a => {
    const E = await import('./sweep/enrich.mjs');
    const say = m => process.stderr.write(m + '\n');
    const dry = !!a.dry;
    const ids = a.ids ? String(a.ids).split(',').map(Number) : null;
    const t0 = Date.now();
    let leads = null, companies = null;
    if (a.company) {
      say(`--- company: ${a.company} ---`);
      companies = await E.enrichCompanies({ limit: 1, dry, only: String(a.company), log: say });
    } else {
      say(`--- enrich: leads (limit ${+(a.limit || setting('enrich_per_hunt') || 40)}${dry ? ', dry' : ''}) ---`);
      leads = await E.enrichLeads({ limit: +(a.limit || setting('enrich_per_hunt') || 40), dry, ids, log: say });
      const cl = +(a.companies ?? setting('enrich_companies_per_hunt') ?? 15);
      if (cl > 0) {
        say(`--- enrich: companies (limit ${cl}${dry ? ', dry' : ''}) ---`);
        companies = await E.enrichCompanies({ limit: cl, dry, log: say });
      }
    }
    const strip = r => r && { ...r, rows: undefined };
    out({ dry, seconds: Math.round((Date.now() - t0) / 1000), leads: strip(leads), companies: strip(companies),
          ...(a.json ? { rows: { leads: leads?.rows, companies: companies?.rows } } : {}) });
  },
  // ---------- sort: the second step — a JD, a date and a price on every row ----------
  // Runs inside every hunt after reconcile, before enrich; also by hand. Plain HTTP, no browser.
  //   ./ladder sort [--dry] [--limit N] [--ids 1,2] [--only jd|twins|ab] [--budget <minutes>]
  'sort': async a => {
    const { sortBoard } = await import('./sweep/sort.mjs');
    const say = m => process.stderr.write(m + '\n');
    const budget = +(a.budget || setting('sort_budget_min') || 20);
    say(`--- sort${a.dry ? ' (dry)' : ''}: ${a.only || 'jd + twins + ab'}, budget ${budget} min ---`);
    out(await sortBoard({
      dry: !!a.dry, limit: +(a.limit || 10_000), only: a.only || null, budgetMs: budget * 60_000,
      ids: a.ids ? String(a.ids).split(',').map(Number) : null, log: say,
    }));
  },
  // The manual hook: what a web search (outside the hunt) or you yourself learned about a company.
  // `ladder company set "Cognition" --stage series-b --headcount 60 --yc W24 --source <url>`
  'company': async a => {
    const E = await import('./sweep/enrich.mjs');
    const verb = a._[1], name = a._[2] || a.name || die('company set|show "<name>"');
    if (verb === 'show') {
      const co = companyFor(name) || die(`no company row matches "${name}"`);
      const leads = all(`SELECT id, role, status, score FROM leads WHERE status IN ('new','shortlisted') AND company=? ORDER BY score DESC`, co.name);
      return out({ ...co, live_leads: leads });
    }
    if (verb !== 'set') die('company set|show "<name>"');
    const facts = {
      funding_stage: a.stage, funding_total_usd: a.raised != null ? +a.raised : undefined,
      last_round_at: a.round, founded: a.founded, headcount: a.headcount != null ? +a.headcount : undefined,
      yc_batch: a.yc ? String(a.yc).toUpperCase() : undefined, kind: a.kind,
    };
    const w = E.setCompanyFacts(name, facts, { source: `manual:${a.source || 'cli'}` });
    let rescored = 0;
    for (const l of all(`SELECT * FROM leads WHERE status IN ('new','shortlisted')`)) {
      if (normKey(l.company) !== normKey(name)) continue;
      if (persistScore(l.id, scoreV2(l))) rescored++;
    }
    out({ ...w, facts: Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined)), rescored });
  },

  // ---------- score: model v2 over the live board ----------
  // `--dry` prints the distribution without writing, which is how the tier cut points get
  // re-derived: they only mean something relative to the spread the scorer actually produces.
  'score': async a => {
    if (a._[1] === 'explain') {
      const id = +(a._[2] || a.id || die('score explain <id>'));
      const l = one('SELECT * FROM leads WHERE id=?', id) || one('SELECT * FROM leads_archive WHERE id=?', id) || die(`no lead ${id}`);
      const r = scoreV2(l);
      const L = [`#${l.id} ${l.company} · ${l.role}`, `  ${l.channel || '-'} · ${l.location || 'no location'} · ${l.band_raw || 'no band'} · gate ${l.gate_years || '?'} · status ${l.status}`,
                 `  potential ${r.potential}  score ${scoreOf(r)}  conf ${r.conf}${r.gated.length ? '  GATED: ' + r.gated.map(g => `${g.g} (${g.t})`).join('; ') : ''}`, ''];
      for (const [k, c] of Object.entries(r.c)) {
        L.push(`  ${k.padEnd(10)} ${String(c.v).padStart(3)}  w${r.w[k]}  ${c.conf}`);
        for (const w of c.why) L.push(`      ${w.d > 0 ? '+' + w.d : w.d < 0 ? w.d : ' 0'}  ${w.t}`);
      }
      if (r.adj.length) { L.push('  adjustments'); for (const x of r.adj) L.push(`      ${x.d > 0 ? '+' + x.d : x.d}  ${x.t}`); }
      const co = companyFor(l.company);
      L.push('', co ? `  company row: ${co.name} · kind ${co.kind || '?'} · heads ${co.headcount ?? co.employees ?? '?'} · stage ${co.funding_stage || '?'} · yc ${co.yc_batch || '-'} · target ${co.target ? 'yes' : 'no'}` : '  company row: none (unverified)');
      if (l.jd_status) L.push(`  jd: ${l.jd_status} at ${l.jd_checked_at}${l.applicants != null ? ` · ${l.applicants} applicants` : ''}`);
      return out(L.join('\n'));
    }
    const dry = !!a.dry;
    companyMap(true);
    const s = settings();
    const rows = a.id ? all('SELECT * FROM leads WHERE id=?', +a.id)
               : all(`SELECT * FROM leads WHERE status IN ('new','shortlisted') ORDER BY id LIMIT ?`, +(a.limit || 100000));
    const scored = rows.map(l => ({ l, r: scoreV2(l, { s }) }));
    let written = 0;
    if (!dry) for (const { l, r } of scored) if (persistScore(l.id, r)) written++;
    const live = scored.filter(x => !x.r.gated.length), gated = scored.filter(x => x.r.gated.length);
    const hist = new Array(10).fill(0);
    for (const x of live) hist[Math.min(9, Math.floor(x.r.potential / 10))]++;
    const byGate = {};
    for (const x of gated) for (const g of x.r.gated) byGate[g.g] = (byGate[g.g] || 0) + 1;
    const L = [`score v2 — ${scored.length} leads, ${live.length} eligible, ${gated.length} gated${dry ? ' (dry run)' : ` — ${written} rows written`}`, '',
               '  potential histogram (eligible only)'];
    for (let i = 9; i >= 0; i--) L.push(`    ${String(i * 10).padStart(3)}–${String(i * 10 + 9).padEnd(3)} ${String(hist[i]).padStart(4)}  ${'#'.repeat(Math.min(60, hist[i]))}`);
    const sorted = live.map(x => x.r.potential).sort((a, b) => b - a);
    const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    L.push(`    max ${sorted[0] ?? 0} · p99 ${pct(0.01)} · p95 ${pct(0.05)} · p90 ${pct(0.10)} · median ${pct(0.5)}`, '',
           '  gated, by gate (a lead can carry more than one)');
    for (const [g, n] of Object.entries(byGate).sort((a, b) => b[1] - a[1])) L.push(`    ${g.padEnd(10)} ${n}`);
    // Per component, not per lead: a lead is only `measured` when all five are, which reads as
    // "0 measured" and says nothing about how far enrichment has got.
    L.push('', '  confidence by component        measured  inferred  unknown');
    for (const k of ['alignment', 'money', 'timing', 'company', 'route']) {
      const n = { measured: 0, inferred: 0, unknown: 0 };
      for (const x of scored) n[x.r.c[k].conf]++;
      L.push(`    ${k.padEnd(28)} ${String(n.measured).padStart(8)}  ${String(n.inferred).padStart(8)}  ${String(n.unknown).padStart(7)}`);
    }
    L.push(`  company rows: ${scored.filter(x => companyFor(x.l.company)).length} of ${scored.length} leads have one`, '',
           '  top 15                                                        P    A   M   T   C   R');
    for (const { l, r } of live.sort((x, y) => y.r.potential - x.r.potential).slice(0, 15)) {
      const c = r.c;
      L.push(`  ${String(r.potential).padStart(3)} #${String(l.id).padEnd(5)}${(l.company + ' · ' + l.role).slice(0, 52).padEnd(53)} ` +
             `${String(c.alignment.v).padStart(3)} ${String(c.money.v).padStart(3)} ${String(c.timing.v).padStart(3)} ${String(c.company.v).padStart(3)} ${String(c.route.v).padStart(3)}  ${l.channel || '-'}`);
    }
    out(L.join('\n'));
  },

  // ---------- drafts: retire what the outbound queue left behind ----------
  // Outbound automation was removed on 2026-09-10 but its staging rows were not: 70 applications
  // sat at status 'queued', none ever sent. reconcile() read each one as "a draft exists" and
  // re-stamped its lead `queued` on every hunt, which pulled the ten best leads on the board —
  // the OpenAI, Cursor and MongoDB referrals among them — out of every predicate that serves
  // Today. This classifies every draft and, without --dry, retires it:
  //   A sent       applied_at set, an `applied` event, or named in --applied id:date
  //                → status='applied' + applied_at + an applied event
  //   B duplicate  same company and role as a row that was sent (role key equal or a prefix,
  //                so "… | India" still matches)         → archived, "draft never sent"
  //   C ambiguous  carries a receipt/note event but no send evidence → printed, left alone
  //   D unsent     everything else                        → archived, "draft never sent"
  // Then the leads still at `queued` are flipped: warm routes → shortlisted, the rest → new.
  'drafts resolve': a => {
    const named = {};
    for (const tok of String(a.applied || '').split(',').map(x => x.trim()).filter(Boolean)) {
      const m = tok.match(/^(\d+):(\d{4}-\d{2}-\d{2})$/) || die(`--applied wants id:YYYY-MM-DD, got "${tok}"`);
      named[+m[1]] = m[2];
    }
    const drafts = all(`SELECT * FROM applications WHERE archived=0 AND status='queued' ORDER BY id`);
    const sent = all(`SELECT id, company, role FROM applications WHERE archived=0 AND status NOT IN ('queued','withdrawn')`)
      .map(x => ({ ...x, ck: normKey(x.company), rk: normKey(x.role) }));
    const dupOf = d => {
      const ck = normKey(d.company), rk = normKey(d.role);
      return sent.find(x => x.ck === ck && (x.rk === rk || x.rk.startsWith(rk) || rk.startsWith(x.rk))) || null;
    };
    const groups = { A: [], B: [], C: [], D: [] };
    for (const d of drafts) {
      const ev = all('SELECT ts, kind, source, title FROM events WHERE application_id=? ORDER BY ts', d.id);
      const appliedEv = ev.find(e => e.kind === 'applied');
      const line = `#${String(d.id).padStart(3)} ${(d.channel || '-').padEnd(10)} ${d.company} · ${d.role}`;
      if (named[d.id] || d.applied_at || appliedEv) {
        const date = named[d.id] || d.applied_at || appliedEv.ts.slice(0, 10);
        groups.A.push({ id: d.id, line: `${line}  → applied ${date}`, d, date });
      } else if (ev.length) {
        groups.C.push({ id: d.id, line: `${line}  [${ev.map(e => `${e.kind}:${e.source} "${e.title}"`).join('; ')}]`, d });
      } else {
        const dup = dupOf(d);
        if (dup) groups.B.push({ id: d.id, line: `${line}  = sent #${dup.id} "${dup.role}"`, d, dup });
        else groups.D.push({ id: d.id, line, d });
      }
    }
    const qLeads = all(`SELECT id, company, role, channel, source, score, (${WARM_SQL}) warm
                        FROM leads WHERE status='queued' ORDER BY score DESC`);
    const L = [];
    const section = (k, label) => { L.push(`## ${k} — ${label} (${groups[k].length})`); L.push(...groups[k].map(x => '  ' + x.line), ''); };
    section('A', 'sent → status applied');
    section('B', 'duplicate of a sent row → archived');
    section('C', 'ambiguous → untouched unless named in --applied');
    section('D', 'unsent draft → archived');
    L.push(`## leads at status queued (${qLeads.length})`,
           ...qLeads.map(l => `  #${String(l.id).padStart(4)} ${String(l.score).padStart(3)} ${(l.channel || '-').padEnd(10)} ${l.company} · ${l.role}  → ${l.warm ? 'shortlisted' : 'new'}`), '');
    if (a.dry) { L.push('(dry run — nothing written)'); return out(L.join('\n')); }

    for (const x of groups.A) {
      run(`UPDATE applications SET status='applied', applied_at=?, updated_at=datetime('now'),
           last_activity_at=datetime('now') WHERE id=?`, x.date, x.id);
      addEvent({ application_id: x.id, kind: 'applied', source: 'manual', ts: x.date + ' 00:00:00',
                 title: `Applied: ${x.d.company} — ${x.d.role}`, body: 'resolved from the retired outbound queue' });
    }
    for (const x of [...groups.B, ...groups.D]) {
      run(`UPDATE applications SET archived=1, updated_at=datetime('now') WHERE id=?`, x.id);
      addEvent({ application_id: x.id, kind: 'note', source: 'manual',
                 title: 'draft never sent; outbound queue retired',
                 body: x.dup ? `duplicate of sent application #${x.dup.id} (${x.dup.role})` : null });
    }
    let toShort = 0, toNew = 0;
    for (const l of qLeads) {
      const to = l.warm ? 'shortlisted' : 'new';
      run('UPDATE leads SET status=? WHERE id=?', to, l.id);
      addEvent({ lead_id: l.id, kind: 'note', source: 'manual',
                 title: `queued → ${to}: ${l.company} — ${l.role}`,
                 body: 'lead status `queued` retired; the draft that held it here was never sent' });
      l.warm ? toShort++ : toNew++;
    }
    const rec = reconcile();
    L.push(`written: ${groups.A.length} applied, ${groups.B.length + groups.D.length} archived, ` +
           `${groups.C.length} left ambiguous; leads ${toShort} → shortlisted, ${toNew} → new; ` +
           `reconcile: queuedLeads=${rec.queuedLeads}, openLeads=${rec.openLeads}`);
    out(L.join('\n'));
  },

  // ---------- the curated target list ----------
  // Separate from leads on purpose: a lead is something the hunt found, a target is something you
  // chose. Conflating them is how a 600-row pipeline hides the twenty rows that matter.
  'targets': a => {
    const rows = all(`SELECT name, target_tier, city, lane, status, ab_rating, ab_reviews,
                             ab_salary_rating, ab_roles, ab_checked_at
                      FROM companies WHERE target=1 ORDER BY target_tier, name`);
    if (a.json) return out(rows);
    const TIER = { 1: 'in motion', 2: 'open', 3: 'gate edge', 4: 'volume' };
    out(rows.map(r => {
      let top = '';
      try {
        const roles = JSON.parse(r.ab_roles || '[]');
        if (roles.length) {
          const s = [...roles].sort((x, y) => (y.max ?? 0) - (x.max ?? 0));
          top = `  top: ${s[0].role} Rs${s[0].min}-${s[0].max}L`;
        }
      } catch { /* a malformed cache should not break the listing */ }
      const rating = r.ab_rating == null
        ? (r.ab_checked_at ? '  no AB page' : '  unchecked')
        : `  ${r.ab_rating}/5 (${r.ab_reviews ?? '?'})`;
      return `${String(r.target_tier)} ${TIER[r.target_tier].padEnd(10)} ${String(r.name).padEnd(20)}` +
             `${String(r.city || '').slice(0, 16).padEnd(18)}${rating}${top}`;
    }).join('\n') || '(no targets)');
  },

  // A courtesy read of someone else's site: paced, and cached on the row so a re-run is cheap.
  'targets refresh': async a => {
    const AB = await import('./sweep/ambitionbox.mjs');
    const s = await AB.refreshTargets({
      only: a.only || null,
      log: l => process.stderr.write('  ' + l + '\n'),
    });
    out({ checked: s.length, resolved: s.filter(x => x.ok).length });
  },

  // What to type as expected CTC for one row, with the whole reasoning. The dashboard shows the
  // same number in the Ask column; this is the long form, for when you are on the form or the call.
  //   ./ladder ask "HackerRank"      ./ladder ask 3472 --lead
  'ask': async a => {
    const { suggestAsk, peersFor, priorAsks, MIN_N: MIN_PEERS } = await import('./ask.mjs');
    const ref = a._[1] ?? a.id ?? die('ask "<company>" | <id> [--lead]');
    const row = a.lead ? findLead(ref) : (findApp(ref) || findLead(ref));
    if (!row) die(`nothing matches "${ref}"`);
    companyMap(true);
    const co = companyFor(row.company);
    const s = suggestAsk(row, co), p = peersFor(row.role || '', co), prior = priorAsks();
    if (a.json) return out({ company: row.company, role: row.role, ask: s, peers: p, prior });
    const L = [`${row.company} · ${row.role}`];
    L.push(s ? `  type  ₹${s.lpa},00,000  (${s.lpa} LPA)  from ${s.src}${s.under ? `   ↓ under your ₹${s.floor}L floor` : ''}`
             : '  no suggestion: no band, no usable AmbitionBox peers, unknown employer. Your call, unaided.');
    if (s) L.push(`  why   ${s.basis.split(' · ').join('\n        ')}`);
    if (p) L.push('  peers ' + p.roles.map(r => `${r.role} ₹${r.min}–${r.max}L (n=${r.n})`).join('\n        '));
    else L.push(co?.ab_url ? `  peers AmbitionBox has this company but not ${MIN_PEERS} salaries from engineers like this role`
              : co?.ab_checked_at ? '  peers no AmbitionBox page' : '  peers not checked yet: ./ladder ask refresh');
    // Name collisions are real (a logistics "Teleport" is not the SSH one), so show the page.
    if (co?.ab_url) L.push(`  page  ${co.ab_url}  — check it is the right company`);
    if (prior?.n) L.push(`  prior you have typed ₹${prior.lo}–${prior.hi}L on ${prior.n} form${prior.n === 1 ? '' : 's'} (comp_points)`);
    out(L.join('\n'));
  },

  // AmbitionBox role tables for the companies in play, so the Ask column has peers to go on.
  'ask refresh': async a => {
    const AB = await import('./sweep/ambitionbox.mjs');
    const s = await AB.refreshForAsk({ limit: +(a.limit || 25),
      log: l => process.stderr.write('  ' + l + '\n') });
    out({ checked: s.length, resolved: s.filter(x => x.ok).length, roles: s.reduce((n, x) => n + x.roles, 0) });
  },

  // Roughly a fifth of listings 404 within days. Checking before applying costs a page load;
  // not checking costs your time on a form for a job that no longer exists.
  'apply check': async a => {
    const B = await import('./sweep/browser.mjs');
    await B.launch({ headless: true });
    const rows = all(`SELECT id, company, role, channel, url FROM applications
                      WHERE status='queued' AND archived=0 ORDER BY fit_score DESC LIMIT ?`, +(a.limit || 200));
    let live = 0, dead = 0;
    for (const r of rows) {
      const page = await B.newPage();
      let isDead = false;
      try {
        await page.goto(r.url, { settle: 4000 });
        isDead = await page.evaluate(`
          const t = document.body ? document.body.innerText.slice(0, 900) : '';
          return !t || /404|couldn't find|no longer accepting|position (has been )?(filled|closed)|page not found|job (is )?(closed|expired)|this job is no longer/i.test(t);`);
      } catch { isDead = true; }
      await page.close();
      if (isDead) {
        run("UPDATE applications SET status='withdrawn', notes=COALESCE(notes,'') || ' [listing dead at queue time]' WHERE id=?", r.id);
        dead++;
      } else live++;
    }
    out({ checked: rows.length, live, dead_removed: dead });
  },

  'browser status': async () => {
    const B = await import('./sweep/browser.mjs');
    out(await B.status());
  },
  'browser stop': async () => {
    const B = await import('./sweep/browser.mjs');
    out({ stopped: B.stop() });
  },
  // Opens a real window with a tab per logged-out portal. You sign in once; the profile keeps
  // those cookies for months, and every later sweep reuses them headlessly.
  'browser login': async a => {
    const B = await import('./sweep/browser.mjs');
    const { PORTALS } = await import('./sweep/portals.mjs');
    // launch() now tears down a headless instance itself when headful is asked for, so this just
    // has to state the intent and then confirm a window really exists before saying so.
    const b = await B.launch({ headless: false, quiet: true });
    const want = a.only ? String(a.only).split(',').map(x => x.trim())
                        : Object.values(PORTALS).filter(p => p.needsAuth).map(p => p.key);
    for (const k of want) {
      const P = PORTALS[k]; if (!P) continue;
      const page = await B.newPage();
      await page.goto(P.loginUrl, { settle: 1200 }).catch(() => {});
      // deliberately not closed — these are the tabs you log in to
    }
    const visible = await B.isVisible();
    out((visible
          ? `A Chrome window is open with ${want.length} login tab(s): ${want.join(', ')}.`
          : `WARNING: Chrome came up headless — no window to type into. Run "./ladder browser stop" and try again.`) +
        `\nSign in to each, then run:  ./ladder browser check\n` +
        `Leave it running or close the window — the cookies persist either way.`);
  },
  'browser check': async () => {
    const B = await import('./sweep/browser.mjs');
    const { PORTALS, checkAuth } = await import('./sweep/portals.mjs');
    await B.launch({ headless: true });
    const rows = [];
    for (const P of Object.values(PORTALS)) {
      const page = await B.newPage();
      let ok = null, err = null;
      // Shared with the sweep so the dashboard and the scrape can never disagree.
      try { ok = await checkAuth(page, P); }
      catch (e) { err = e.message; }
      await page.close();
      rows.push({ portal: P.key, needsAuth: P.needsAuth, loggedIn: ok, error: err,
                  usable: P.needsAuth ? !!ok : true });
    }
    out(rows);
  },
};

function renderBrief() {
  const s = scoreboard(), L = [];
  L.push(`# Morning brief — ${today()}`, '');
  L.push(`**Pipeline** ${s.applications} live · ${s.replies} replied · ${s.screens} screens · ${s.offers} offers · reply rate ${s.replyRate}%`);
  L.push(`**Above ₹${s.floor}L floor** ${s.aboveFloor} applications, ${s.liveAboveFloor} of them alive`);
  L.push(`**Study** ${s.study.today}/${s.study.goal} min today · ${s.study.streak}-day streak · ${s.syllabus.solid}/${s.syllabus.total} solid, ${s.syllabus.gaps} gaps`);
  L.push(`**Sprint** day ${s.sprint.elapsed}/${s.sprint.total} (${s.sprint.left} left)`, '');
  const nu = all('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY ts DESC LIMIT 15');
  if (nu.length) { L.push('## Unread', ...nu.map(n => `- ${n.level === 'urgent' ? '🔴' : n.level === 'signal' ? '🟡' : '·'} **${n.title}** ${n.body || ''}`), ''); }
  const st = stale(7);
  if (st.length) { L.push(`## Gone quiet (${st.length})`, ...st.slice(0, 10).map(a => `- ${a.company} · ${a.role} — ${a.quiet_days}d`), ''); }
  const top = all(`SELECT * FROM leads WHERE status IN ('new','shortlisted') ORDER BY score DESC LIMIT 8`);
  if (top.length) { L.push('## Top unapplied leads', ...top.map(l => `- **${l.score}** ${l.company} · ${l.role} — ${l.band_raw || '?'} — ${l.url || ''}`), ''); }
  const ob = all("SELECT * FROM outbox WHERE status='held'");
  if (ob.length) L.push(`## Outbox held (${ob.length})`, ...ob.map(o => `- #${o.id} ${o.subject || o.kind} → ${o.to_addr} (releases ${o.release_at})`), '');
  return L.join('\n');
}

// ---------- dispatch ----------
const argv = process.argv.slice(2);
const args = parseArgs(argv);
const key2 = argv.slice(0, 2).filter(x => !x.startsWith('--')).join(' ');
const key1 = argv[0];
const fn = cmds[key2] || cmds[key1];
if (!fn) {
  console.error('ladder — usage:\n' + Object.keys(cmds).map(k => '  ladder ' + k).join('\n'));
  process.exit(1);
}
db();
await fn(args);
bump();
