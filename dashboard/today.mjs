// ladder/dashboard/today.mjs — the agenda: everything with a date on it, in one list.
//
// Most of what is due is already in the database and just needed collecting: a thread that
// replied and is waiting, a follow-up with a due date, a strong lead about to fall out of the
// expiry window, a portal allowance that resets. Those are derived here on every read and can
// never go stale. The `agenda` table holds only what no query can know — an interview at 4pm, an
// assessment window, a call — and those are the only rows that get ticked by hand.
import { all, one, run, settings } from './db.mjs';
import { runStatus, huntToday, ycAllowance, CUTS } from './lib.mjs';
import { rankLeads } from './recommend.mjs';

const DAY = 864e5;
const isoDay = d => d.toISOString().slice(0, 10);
const today = () => isoDay(new Date());
const addDays = (day, n) => isoDay(new Date(new Date(day + 'T00:00:00Z').getTime() + n * DAY));
const daysUntil = day => Math.round((new Date(day + 'T00:00:00Z') - new Date(today() + 'T00:00:00Z')) / DAY);

export const AGENDA_KINDS = ['call', 'interview', 'assessment', 'deadline', 'followup', 'other'];

/**
 * Every dated item, grouped. Each item carries `due` (a day), `kind`, a title, the thing it is
 * about, and — for derived items — where the date came from, so a wrong date can be traced.
 */
export function agenda() {
  const items = [];
  const t = today();

  // 1. Threads with a human in them. Due the day after they last moved: a reply left overnight
  //    is fine, a reply left for three days is the most expensive mistake this system makes.
  for (const a of all(`SELECT id, company, role, status, next_action, next_action_due, url,
                              COALESCE(last_activity_at, applied_at) at,
                              CAST(julianday('now') - julianday(COALESCE(last_activity_at, applied_at)) AS INT) days
                       FROM applications WHERE archived=0 AND status IN ('replied','screen','interview','offer')`)) {
    // A stated next action with a date is the better item for the same row — do not double up.
    if (a.next_action_due) continue;
    items.push({
      id: `thread-${a.id}`, kind: 'reply', due: addDays(String(a.at).slice(0, 10), 1),
      title: a.status === 'replied' ? 'Reply waiting on you' : `${a.status === 'screen' ? 'Assessment' : a.status[0].toUpperCase() + a.status.slice(1)} in progress`,
      company: a.company, sub: a.role, quiet: a.days, url: a.url, application_id: a.id,
      derived: 'last activity + 1 day',
    });
  }

  // 2. Follow-ups with a date on them. Done = clear the date, keep the note in the history.
  for (const a of all(`SELECT id, company, role, status, next_action, next_action_due, url FROM applications
                       WHERE archived=0 AND next_action_due IS NOT NULL AND status NOT IN ('rejected','withdrawn')`))
    items.push({
      id: `followup-${a.id}`, kind: 'followup', due: a.next_action_due,
      title: a.next_action || 'Follow up', company: a.company, sub: a.role, url: a.url,
      application_id: a.id, derived: 'next_action_due', doneable: true,
    });

  // 3. Strong leads about to expire. The single biggest leak — half of all dead leads died of
  //    age — so the ones worth having get a dated line rather than a silent disappearance.
  const s = settings();
  const expiry = +(s.expiry_days || 10);
  // Only the ones actually worth the deadline. At fit >= 60 and 3 days this fired on 46 leads and
  // buried the interviews under it; an agenda you scroll is an agenda you stop reading. Five, and
  // only the strong ones (the `strong` tier cut, so it moves with the scorer), in the last 48
  // hours of their window.
  const expiring = rankLeads()
    .filter(l => l.expiresIn != null && l.expiresIn <= 2 && l.fit >= CUTS.strong)
    .sort((a, b) => b.fit - a.fit)
    .slice(0, 5);
  for (const l of expiring)
    items.push({
      id: `expiry-${l.id}`, kind: 'expiring', due: addDays(t, l.expiresIn),
      title: l.expiresIn === 0 ? 'Expires today' : `Expires in ${l.expiresIn} day${l.expiresIn > 1 ? 's' : ''}`,
      company: l.company, sub: l.role, url: l.url, lead_id: l.id, fit: l.fit,
      derived: `posted ${expiry}-day window`,
    });

  // 4. The YC allowance, only when it is spent — a slot coming back is a dated fact worth a line.
  const yc = ycAllowance();
  if (yc.remaining === 0 && yc.freesOn)
    items.push({ id: 'yc-slot', kind: 'deadline', due: yc.freesOn, title: 'YC application slot frees',
                 company: 'Work at a Startup', sub: `${yc.sentThisWeek} of ${yc.cap} used this week`, derived: 'oldest send + 7 days' });

  // 5. Hand-entered rows.
  for (const r of all(`SELECT a.*, ap.role app_role, ap.url app_url FROM agenda a
                       LEFT JOIN applications ap ON ap.id=a.application_id
                       WHERE a.done_at IS NULL ORDER BY a.day, a.time`))
    items.push({
      id: `manual-${r.id}`, agenda_id: r.id, kind: r.kind, due: r.day, time: r.time,
      title: r.title, company: r.company, sub: r.notes || r.app_role || null, url: r.app_url,
      application_id: r.application_id, contact_id: r.contact_id, doneable: true,
    });

  for (const it of items) it.inDays = daysUntil(it.due);
  const rank = { reply: 0, interview: 1, assessment: 2, call: 3, deadline: 4, followup: 5, expiring: 6, other: 7 };
  items.sort((a, b) => a.inDays - b.inDays || (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9) || String(a.time || '').localeCompare(String(b.time || '')));

  const groups = [
    { id: 'overdue', label: 'Overdue', items: items.filter(i => i.inDays < 0) },
    { id: 'today',   label: 'Today',   items: items.filter(i => i.inDays === 0) },
    { id: 'week',    label: 'Next 7 days', items: items.filter(i => i.inDays > 0 && i.inDays <= 7) },
    { id: 'later',   label: 'Later',   items: items.filter(i => i.inDays > 7) },
  ];
  // Recently ticked, so a mis-tick can be undone from the page instead of the CLI.
  const done = all(`SELECT id, day, time, title, kind, company, done_at FROM agenda
                    WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 6`);
  return { groups, total: items.length, done };
}

export function agendaAdd(b) {
  if (!b.title || !b.day) return { error: 'title and day are required' };
  const kind = AGENDA_KINDS.includes(b.kind) ? b.kind : 'other';
  // Attach to an application by company name when one matches, so the row carries its URL.
  let appId = b.application_id ?? null;
  if (!appId && b.company) {
    const hit = all(`SELECT id FROM applications WHERE archived=0 AND lower(company) LIKE ? ORDER BY last_activity_at DESC LIMIT 2`, `%${String(b.company).toLowerCase()}%`);
    if (hit.length === 1) appId = hit[0].id;
  }
  const r = run(`INSERT INTO agenda (day,time,title,kind,company,application_id,contact_id,notes) VALUES (?,?,?,?,?,?,?,?)`,
                b.day, b.time || null, b.title, kind, b.company || null, appId, b.contact_id ?? null, b.notes || null);
  return { ok: true, id: Number(r.lastInsertRowid) };
}

export function agendaDone(id, done = true) {
  run(`UPDATE agenda SET done_at=${done ? "datetime('now')" : 'NULL'} WHERE id=?`, id);
  return { ok: true, id, done };
}
export function agendaDelete(id) { run(`DELETE FROM agenda WHERE id=?`, id); return { ok: true, id }; }

/** A derived follow-up is done when its date is cleared; the text moves into the event history. */
export function followupDone(appId) {
  const a = one(`SELECT id, next_action FROM applications WHERE id=?`, appId);
  if (!a) return { error: 'no such application' };
  if (a.next_action)
    run(`INSERT INTO events (application_id,kind,source,title) VALUES (?,'note','dashboard',?)`, appId, `done: ${a.next_action}`);
  run(`UPDATE applications SET next_action=NULL, next_action_due=NULL, last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, appId);
  return { ok: true, id: appId };
}

/** Did the machine run, and what did it find — the two facts the top of the page needs. */
export function machine() {
  const rs = runStatus();
  const h = huntToday();
  const running = one(`SELECT id, started_at FROM sweeps WHERE finished_at IS NULL
                       AND started_at >= datetime('now','-20 minutes') ORDER BY id DESC LIMIT 1`);
  return { hunt: rs.hunt, mail: rs.mail, foundToday: h.total, goodToday: h.good, running: running || null };
}
