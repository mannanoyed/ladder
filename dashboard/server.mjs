#!/usr/bin/env node --no-warnings
// ladder/dashboard/server.mjs — local HTTP API + SSE. Zero dependencies.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { watchFile, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, extname, normalize } from 'node:path';
import { db, all, one, run, setting, settings, ROOT, REPO } from './db.mjs';
import { PROFILE } from './profile.mjs';
import { scoreboard, stale, reconcile, channelFreshness, opportunities, huntToday, runStatus, ycAllowance, actionQueue,
         ACTIVE, LIVE, parseBand, CUTS } from './lib.mjs';
import { leadRows, appRows, stageCounts, STAGES, applicationInsights, mailInsights,
         sweepInsights, recommendations, roadmap, roadmapSet } from './insights.mjs';
import { analytics } from './analytics.mjs';
import { picks, outreach, session, record, rankContacts, SKIP_REASONS } from './recommend.mjs';
import { agenda, agendaAdd, agendaDone, agendaDelete, followupDone, machine, AGENDA_KINDS } from './today.mjs';

const PORT = +(process.env.LADDER_PORT || 7777);
const PUBLIC = join(ROOT, 'public');
const BUMP = join(ROOT, '.bump');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
               '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8',
               '.txt': 'text/plain; charset=utf-8', '.tex': 'text/plain; charset=utf-8',
               '.csv': 'text/csv; charset=utf-8', '.srt': 'text/plain; charset=utf-8' };

db();

// mtime of the client bundle, read once at boot. The server restarts on every code change
// (launchd KeepAlive), so a new process means a potentially new front end.
const BUILD = (() => {
  try { return String(statSync(join(PUBLIC, 'app.js')).mtimeMs | 0); } catch { return '0'; }
})();

// ---------- SSE fan-out ----------
const clients = new Set();
function broadcast(type = 'change') {
  for (const res of clients) { try { res.write(`event: ${type}\ndata: ${Date.now()}\n\n`); } catch { clients.delete(res); } }
}
if (!existsSync(BUMP)) await writeFile(BUMP, '0');
watchFile(BUMP, { interval: 400 }, () => broadcast());       // the CLI touches .bump after every write
const bump = () => writeFile(BUMP, String(Date.now())).catch(() => {});

// ---------- the one payload the dashboard renders from ----------
//
// Six pages, so six blocks: today's session, the leads, the applications, the people, the
// numbers, the checklist. Leads and applications were one `funnel` until 2026-09-12; a lead is
// supply the hunt found and an application is a thing you sent, and one table with a `scraped`
// pill was the only tell between them.
// Everything the old eight-tab board carried and none of these pages read — the send queue, the
// outbox, syllabus rows, study days, calls, the raw comp list — is deliberately gone from the
// payload rather than merely hidden in CSS. Outbound is sent by hand now; a queue of drafts the
// machine was going to send is not a thing that exists any more.
//
// `recommended()` from insights.mjs is gone with it: Today's picks come from the recommender,
// which ranks on time, fit and memory rather than on the raw score alone, and says why.
//
// The dropped tables are untouched on disk and still reachable from the CLI. Comp points are read
// here only through `recommendations()`, which is the one place they earn their keep.
function state() {
  const leads = leadRows(), apps = appRows();
  const rm = roadmap();
  const mail = mailInsights();
  // Rows carry no note text — several hundred characters a row across ~1000 rows that the list
  // never renders. The drawer fetches `/api/row/lead/:id` on demand. Every DB write bumps SSE and
  // every client refetches the lot, so the rows are kept lean; they are still all sent, because
  // filtering is client-side and a truncated payload makes a filter lie about what it found.
  // The Today page is the default surface: one session's worth of work, already chosen. `picks`
  // and `outreach` stamp a `shown` event once per target per day, which is how a card that keeps
  // being ignored sinks — so this block is the one part of `state()` that writes.
  const p = picks(), o = outreach();
  const strip = ({ features, note, ...r }) => r;      // features are the recommender's; note is fetched on demand
  return {
    now: new Date().toISOString(),
    // Build stamp. An open tab keeps whatever JS it loaded, so after a code change the page can
    // sit there running old handlers while looking perfectly alive — buttons that do nothing and
    // no error anywhere. The client compares this and reloads itself when it moves.
    build: BUILD,
    scoreboard: scoreboard(),

    // --- page 1: today ---
    today: {
      session: session(),
      agenda: agenda(),
      leads: { ...p, picks: p.picks.map(strip) },
      people: { ...o, picks: o.picks.map(strip) },
      machine: machine(),
      skipReasons: SKIP_REASONS,
      agendaKinds: AGENDA_KINDS,
    },

    // --- page 2: leads ---
    leads: {
      rows: leads,
      total: leads.length,
      gated: leads.filter(r => r.gates.length).length,
      snoozed: leads.filter(r => r.snoozed_until && r.snoozed_until > new Date().toISOString().slice(0, 10)).length,
      channels: [...new Set(leads.map(r => r.channel || '—'))].sort(),
      // Counts per lane for the filter chips, in your order: FDE first.
      lanes: ['fde', 'workflows', 'generalist', 'ml'].map(k => [k, leads.filter(r => r.lane === k).length]),
      cuts: CUTS,
    },

    // --- page 3: applications ---
    stages: STAGES,
    applications: {
      rows: apps,
      stageCounts: stageCounts(apps),
      waiting: mail.waiting,
    },

    // --- page 4: people ---
    // The whole ranked list, snoozed rows included, because the People tab is the place a snooze
    // is undone. The Today card serves three of these; this is the table behind them.
    people: rankContacts({ includeSnoozed: true, includeClosed: true }).map(strip),

    // --- page 5: stats ---
    apps: applicationInsights(),          // application insights — `S.apps` is read in three places
    mail,
    sweeps: sweepInsights(),
    recommendations: recommendations(),
    // The deep numbers: conversion per step, routes, why leads die, calibration, latency,
    // supply velocity and the forecast. Keyed off the runway because every projection is
    // measured against the notice period, not against a calendar month.
    analytics: analytics(rm.runway.left),
    channelFreshness: channelFreshness(),
    runStatus: runStatus(),
    ycAllowance: ycAllowance(),

    // --- page 6: roadmap ---
    roadmap: rm,

    // --- shared chrome ---
    notifications: all('SELECT * FROM notifications ORDER BY read_at IS NULL DESC, ts DESC LIMIT 40'),
    settings: settings(),
  };
}

// ---------- the kit ----------
// The pipeline is only half the picture. The other half is the material you actually apply with —
// the resume you send, the facts a claim has to be checkable against, the notes behind each
// application. Keeping those one click from the board is what stops a rushed bulk-apply run from
// putting an unverifiable line in writing.
const KIT = PROFILE.kit || [];    // profile.kit: groups of files or a dir+ext, relative to the repo root

async function kit() {
  const { stat, readdir } = await import('node:fs/promises');
  const groups = [];
  for (const g of KIT) {
    const rels = g.dir
      ? (await readdir(join(REPO, g.dir)).catch(() => [])).filter(f => f.endsWith(g.ext)).sort().map(f => `${g.dir}/${f}`)
      : g.glob;
    const items = [];
    for (const rel of rels) {
      const st = await stat(join(REPO, rel)).catch(() => null);
      if (!st) continue;                       // a missing artifact is omitted, never faked
      items.push({ rel, name: rel.split('/').pop(), bytes: st.size,
                   mtime: st.mtime.toISOString(), url: '/kit/' + rel });
    }
    if (items.length) groups.push({ group: g.group, note: g.note ?? null, items });
  }
  return groups;
}

// ---------- routes ----------
const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(d ? JSON.parse(d) : {}); } catch { r({}); } }); });

const POST = {
  'app': (id, b) => {
    const app = one('SELECT * FROM applications WHERE id=?', id);
    if (!app) return { error: 'no such application' };
    const allowed = ['status', 'next_action', 'next_action_due', 'notes', 'fit_score', 'url', 'location', 'role', 'applied_at', 'archived', 'focus'];
    const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
    if (b.band != null) { const p = parseBand(b.band); Object.assign(patch, { band_raw: b.band, band_min_lpa: p.min, band_max_lpa: p.max }); }
    if (!Object.keys(patch).length) return { error: 'nothing to update' };
    if (patch.status && patch.status !== app.status)
      run(`INSERT INTO events (application_id,kind,source,title) VALUES (?,'status_change','dashboard',?)`,
          id, `${app.status} → ${patch.status}`);
    run(`UPDATE applications SET ${Object.keys(patch).map(k => `${k}=?`).join(',')},
         updated_at=datetime('now'), last_activity_at=datetime('now') WHERE id=?`, ...Object.values(patch), id);
    return { ok: true, id, ...patch };
  },
  'lead': (id, b) => {
    if (b.promote) {
      const l = one('SELECT * FROM leads WHERE id=?', id);
      if (!l) return { error: 'no such lead' };
      // The lead may already own an application row — including an archived one, which still
      // holds the UNIQUE identity index. INSERT OR IGNORE hit that silently, wrote nothing, and
      // then the lead was marked applied anyway: the row vanished off the board and no
      // application existed to show for it. Never mark the lead until a row is actually there.
      const existing = one('SELECT id, status, archived FROM applications WHERE company=? AND role=?',
                           l.company, l.role);
      const status = b.status || 'applied';
      if (existing) {
        run(`UPDATE applications SET archived=0, status=?, applied_at=COALESCE(applied_at, date('now')),
             last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, status, existing.id);
      } else {
        run(`INSERT INTO applications (company,role,location,channel,url,band_raw,band_min_lpa,band_max_lpa,
               gate_years,status,applied_at,last_activity_at,notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,date('now'),datetime('now'),?)`,
          l.company, l.role, l.location, l.channel, l.url, l.band_raw, l.band_min_lpa, l.band_max_lpa,
          l.gate_years, status, l.fit_note);
      }
      run("UPDATE leads SET status='applied', claimed_at=NULL, claimed_note=NULL WHERE id=?", id);
      return { ok: true, promoted: l.company, restored: !!existing };
    }
    if (b.focus !== undefined) {                     // pin/unpin — the board's only manual ranking
      run('UPDATE leads SET focus=? WHERE id=?', b.focus ? 1 : 0, id);
      return { ok: true, focus: b.focus ? 1 : 0 };
    }
    if (b.claimed !== undefined) {                   // "Claude has this one" — a transient hold
      if (b.claimed) run("UPDATE leads SET claimed_at=datetime('now'), claimed_note=? WHERE id=?", b.note ?? null, id);
      else run('UPDATE leads SET claimed_at=NULL, claimed_note=NULL WHERE id=?', id);
      return { ok: true, claimed: !!b.claimed };
    }
    run('UPDATE leads SET status=?, dropped_reason=? WHERE id=?', b.status || 'new', b.reason ?? null, id);
    return { ok: true };
  },
  // Status and notes only. Everything else on a contact is scraped fact, and the scraper's
  // standing rule is that judgement columns are the human's and raw columns are the machine's.
  'contact': (id, b) => {
    if (!one('SELECT id FROM contacts WHERE id=?', id)) return { error: 'no such contact' };
    const allowed = ['status', 'notes'];
    const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(patch).length) return { error: 'nothing to update' };
    run(`UPDATE contacts SET ${Object.keys(patch).map(k => `${k}=?`).join(',')},
         updated_at=datetime('now') WHERE id=?`, ...Object.values(patch), id);
    return { ok: true, id, ...patch };
  },
  'syllabus': (id, b) => {
    run("UPDATE syllabus_items SET level=?, done=?, updated_at=datetime('now') WHERE id=?",
        b.level, b.level === 'solid' ? 1 : 0, id);
    return { ok: true };
  },
  'outbox': (id, b) => {
    if (b.action === 'cancel') run("UPDATE outbox SET status='cancelled' WHERE id=?", id);
    if (b.action === 'approve') run("UPDATE outbox SET status='approved', release_at=datetime('now') WHERE id=?", id);
    return { ok: true };
  },
  'call': (id, b) => { run('UPDATE calls SET outcome=?, prep_done=?, summary=? WHERE id=?',
      b.outcome ?? null, b.prep_done ? 1 : 0, b.summary ?? null, id); return { ok: true }; },
};

let sweeping = false;
async function runSweep(res, only = null) {
  if (sweeping) return json(res, { error: 'a run is already going' }, 409);
  // run-sweep.mjs, not the old .sh: the node entrypoint is the one launchd uses, the one that
  // survives macOS TCC, and — since it now runs the portal pass first — the only one that
  // actually sweeps portals. Pointing the button at bash quietly skipped half the sweep.
  const script = join(ROOT, 'sweep', 'run-sweep.mjs');
  if (!existsSync(script)) return json(res, { error: 'sweep script missing' }, 500);
  sweeping = true;
  const label = only === 'hunt' ? 'Hunt started' : only === 'mail' ? 'Mail sweep started' : 'Sweep started';
  const what = only === 'hunt' ? 'Looking for new jobs across every portal.'
             : only === 'mail' ? 'Reading mail for replies and status changes.'
             : 'Both passes, run from the dashboard.';
  run(`INSERT INTO notifications (level,title,body,source) VALUES ('info',?,?,'sweep')`, label, what);
  bump();
  const flag = only === 'hunt' ? '--hunt' : only === 'mail' ? '--mail' : '--manual';
  const p = spawn(process.execPath, ['--no-warnings', script, flag], { cwd: ROOT, detached: true, stdio: 'ignore' });
  p.unref();
  p.on('exit', () => { sweeping = false; bump(); });
  setTimeout(() => { sweeping = false; }, 15 * 60_000);        // never wedge the button
  json(res, { ok: true, started: true });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 25_000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (path === '/api/state') return json(res, state());
  if (path === '/api/kit') return json(res, await kit());
  if (path.startsWith('/kit/')) {
    // Read-only window onto the repo. normalize() then the prefix check: without both, a
    // request for /kit/../../.ssh/id_rsa walks straight out of the directory.
    const rel = decodeURIComponent(path.slice(5));
    const abs = normalize(join(REPO, rel));
    if (!abs.startsWith(REPO + '/')) return json(res, { error: 'nope' }, 403);
    try {
      const buf = await readFile(abs);
      res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream',
                           'cache-control': 'no-store' });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end('not found'); }
  }
  // The full row behind a board line, fetched only when the ⓘ is pressed. `fit_note` and `notes`
  // are several hundred characters each across a thousand rows; they are stripped from the payload
  // and read from here instead, so the board stays cheap and the note is still one click away.
  const rowM = path.match(/^\/api\/row\/(lead|app)\/(\d+)$/);
  if (rowM) {
    const r = rowM[1] === 'lead'
      ? one('SELECT * FROM leads WHERE id=?', +rowM[2])
      : one('SELECT * FROM applications WHERE id=?', +rowM[2]);
    return json(res, r || { error: 'not found' }, r ? 200 : 404);
  }
  if (path === '/api/brief') {
    const p = spawn(process.execPath, ['--no-warnings', join(ROOT, 'cli.mjs'), 'brief']);
    let o = ''; p.stdout.on('data', d => o += d); p.on('close', () => json(res, { brief: o }));
    return;
  }
  if (path === '/api/sweep/run' && req.method === 'POST') {
    // ?only=hunt or ?only=mail. The two jobs are separately runnable now — the single "Run the
    // hunt" button always ran both passes, so there was no way to re-read mail after fixing a
    // lapsed login without also re-scraping ten portals.
    const only = new URL(req.url, 'http://x').searchParams.get('only');
    return runSweep(res, only === 'hunt' || only === 'mail' ? only : null);
  }

  // The bulk-triage and bulk-send routes lived here and are gone. They existed to dry-run and then
  // submit everything sitting in `status='queued'`, which was the outbound-automation staging area;
  // applications are hand-sent now, so there is no queue to drain and no reason to keep an endpoint
  // that can fire fifty submissions at a portal. `sweep/apply.mjs` is untouched and still drives
  // `./ladder apply` from the CLI.

  if (req.method === 'POST') {
    const b = await readBody(req);
    if (path === '/api/notif/read') {
      if (b.id) run("UPDATE notifications SET read_at=datetime('now') WHERE id=?", b.id);
      else run("UPDATE notifications SET read_at=datetime('now') WHERE read_at IS NULL");
      bump(); return json(res, { ok: true });
    }
    if (path === '/api/study') {
      run('INSERT INTO study_log (day,minutes,section,topic,notes) VALUES (?,?,?,?,?)',
        b.day || new Date().toISOString().slice(0, 10), +b.minutes || 0, b.section ?? null, b.topic ?? null, b.notes ?? null);
      bump(); return json(res, { ok: true, study: scoreboard().study });
    }
    // The roadmap's hand-ticked items. Every other item derives its state from the DB and cannot
    // be clicked at all, so this only ever writes the handful that no query can answer.
    if (path === '/api/roadmap' && b.id) { roadmapSet(b.id, !!b.done); bump(); return json(res, { ok: true }); }

    // The Today page's one write. Every answer is recorded before it is acted on, because the
    // record is what the recommender learns from — a skip that only changed a status would teach
    // it nothing. Nothing here sends anything; `applied` means you already sent it by hand.
    if (path === '/api/rec') {
      const id = +b.id;
      if (!['lead', 'contact'].includes(b.target) || !id || !b.action)
        return json(res, { error: 'target, id and action are required' }, 400);
      let promoted = null;
      if (b.target === 'lead' && b.action === 'applied') {
        const r = POST.lead(id, { promote: 1, status: 'applied' });
        if (r.error) { bump(); return json(res, r, 400); }
        promoted = r.promoted;
      }
      const r = record(b.target, id, b.action, { reason: b.reason ?? null, days: b.days ?? null });
      bump();
      return json(res, promoted ? { ...r, promoted } : r, r.error ? 400 : 200);
    }
    // Add, tick, untick, delete — and the derived follow-up, whose "done" is clearing its date.
    if (path === '/api/agenda') {
      const r = b.add ? agendaAdd(b.add)
              : b.application_id ? followupDone(+b.application_id)
              : b.id && b.delete ? agendaDelete(+b.id)
              : b.id ? agendaDone(+b.id, !!b.done)
              : { error: 'nothing to do' };
      bump();
      return json(res, r, r.error ? 400 : 200);
    }
    if (path === '/api/settings') { setting(b.key, b.value); bump(); return json(res, { ok: true }); }
    if (path === '/api/reconcile') { const r = reconcile(); bump(); return json(res, r); }
    const m = path.match(/^\/api\/(app|lead|contact|syllabus|outbox|call)\/(\d+)$/);
    if (m) { const r = POST[m[1]](+m[2], b); bump(); return json(res, r, r.error ? 400 : 200); }
    return json(res, { error: 'unknown endpoint' }, 404);
  }

  // static
  let f = path === '/' ? '/index.html' : path;
  const abs = join(PUBLIC, normalize(f).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC)) return json(res, { error: 'nope' }, 403);
  try {
    const buf = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});

server.listen(PORT, '127.0.0.1', () => {
  const s = scoreboard();
  console.log(`\n  ladder dashboard  →  http://localhost:${PORT}`);
  console.log(`  ${s.applications} applications · ${s.replies} live · ${s.leadsOpen} open leads · ${s.unread} unread\n`);
});
