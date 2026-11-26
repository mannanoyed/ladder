// ladder dashboard — six pages, one /api/state payload, refreshes on SSE.
//
// Today is the page. It holds one session's work: what has a date on it, eight applications to
// send by hand, three people to message. Leads is the supply behind it (ranked, five bars each),
// Applications is what you sent and where it is, People the ranked humans, Stats what the inbound
// has taught us, Roadmap the checklist against the notice-period runway.
//
// Nothing here sends anything. Every button records a decision you have already made — `Applied`
// means you applied on the portal in another tab and came back. That is the whole contract.
let S = null;
let stageFilter = 'all', chanFilter = 'all', appQuery = '', peopleFilter = 'all';
let leadChan = 'all', leadMin = 0, leadVerified = false, leadGated = false, leadQuery = '', leadClaimed = false, leadLane = 'all';
// Your four lanes, as clean.mjs names them. A row's lane is set after load (load wide, clean after).
const LANE_LABEL = { fde: 'FDE', workflows: 'AI workflows', generalist: 'AI generalist', ml: 'ML' };
let drawerId = null;                 // the lead whose five bars are open in the drawer
const skipOpen = new Set();          // "lead:41" — the card showing its skip reasons instead of actions
const detailOpen = new Map();        // "lead:41" -> note text, fetched on demand
let editApp = null;                  // { id, next_action, next_action_due } — the inline app editor
let agendaOpen = false;
let pending = false;                 // a render deferred because you are typing

const $ = s => document.querySelector(s);
const set = (sel, html) => { const e = $(sel); if (e) e.innerHTML = html; };   // tolerate absent nodes
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lpa = (a, b) => a == null ? '—' : (b && b !== a ? `₹${a}–${b}L` : `₹${a}L`);
const ago = ts => {
  if (!ts) return '';
  const d = (Date.now() - new Date(ts.replace(' ', 'T') + (ts.includes('Z') ? '' : 'Z')).getTime()) / 6e4;
  if (d < 1) return 'now'; if (d < 60) return `${d | 0}m`; if (d < 1440) return `${d / 60 | 0}h`;
  return `${d / 1440 | 0}d`;
};
// `ago()` returns a bare span; this is the sentence form. "now ago" is not a thing.
const agoLabel = ts => { const a = ago(ts); return !a ? '—' : a === 'now' ? 'just now' : `${a} ago`; };
// The "#N" Claude writes into a claim note when it hands over a ranked list; unranked claims sort last.
const claimRank = r => { const m = /#(\d+)\b/.exec(r.claimed_note || ''); return m ? +m[1] : 1e9; };
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
const isoToday = () => new Date().toISOString().slice(0, 10);

// A short confirmation, bottom-right, gone in four seconds. Used where an action succeeds and
// visibly removes its own row — without it the button reads as broken and gets pressed twice.
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 4000);
}

const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());

// The stage an application row can be moved to by hand. This is the only way anything advances
// now, so the vocabulary is the funnel's, not the database's — `screen` is called Assessment
// everywhere a human reads it.
const STAGE_STATUS = [
  ['applied', 'Applied'], ['replied', 'Replied'], ['screen', 'Assessment'],
  ['interview', 'Interview'], ['offer', 'Offer'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'],
];
const CONTACT_STATUS = [
  ['new', 'New'], ['shortlisted', 'Shortlisted'], ['contacted', 'Contacted'],
  ['replied', 'Replied'], ['dropped', 'Dropped'],
];

// Status → [stage class, the word a human reads]. `screen` is Assessment everywhere on screen;
// letting the raw status through here was the one place the two vocabularies leaked into each other.
const WAITING_STAGE = {
  replied: ['applied', 'replied'], screen: ['assessment', 'assessment'],
  interview: ['interview', 'interview'], offer: ['converged', 'offer'],
};

// Event kinds are column values, not labels. Displayed verbatim they overran their own column.
const EV_LABEL = {
  screen_scheduled: 'screen', status_change: 'status', rejection: 'rejected', receipt: 'receipt',
};

let BUILD = null;
async function load() {
  S = await (await fetch('/api/state')).json();
  // The page cannot fix itself once its own code is stale, so it reloads instead. Without this a
  // tab left open across a deploy keeps running old handlers: presses that do nothing, no error,
  // and no way to tell from the screen that anything is wrong.
  if (BUILD && S.build && S.build !== BUILD) { location.reload(); return; }
  BUILD = S.build || BUILD;
  render();
}

function render() {
  // Hold the previous render rather than wiping a half-typed agenda item or follow-up note out
  // from under you. SSE fires on every write in the system, including ones you did not make.
  if (document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { pending = true; return; }
  pending = false;

  const rw = S.roadmap.runway;
  $('#runway').textContent = `${rw.left} days of runway · last working day ${rw.end}`;

  // Five numbers, in funnel order, so the header reads as a progression rather than a scoreboard.
  // `sent` is what left — never the row count, which used to include drafts and report a 120-send
  // sprint as already met off 39 real submissions.
  const c = S.applications.stageCounts, a = S.apps;
  // Live and Assessment+ open Applications filtered to exactly the rows they count.
  set('#kpis', [
    ['Leads', S.leads.total, 'open leads the hunt found'],
    ['Sent', a.sent, 'applications that actually left, by hand'],
    ['Live', a.live, 'threads with a human in them', 'live'],
    ['Assessment+', c.assessment + c.interview + c.converged, 'past the first filter', 'deep'],
    ['Reply rate', a.replyRate + '%', 'live ÷ sent'],
  ].map(([k, v, t, sf]) => sf
    ? `<button class="kpi link" data-kpi="${sf}" title="${esc(t)}"><b>${esc(String(v))}</b><span>${esc(k)}</span></button>`
    : `<div class="kpi" title="${esc(t)}"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`).join(''));

  renderToday();
  renderNeedsYou();
  renderLeads();
  renderApps();
  renderPeople();
  renderStats();
  renderRoadmap();
}

// ============================ page 1: today ============================

function renderToday() {
  renderSession();
  renderAgenda();
  renderPicks();
  renderOutreach();
}

/** Where the day stands, and whether the machine that fills it has run. */
function renderSession() {
  const s = S.today.session, m = S.today.machine;
  const done = Math.min(s.applied, s.target);
  const counts = [
    s.skipped ? `Skipped ${s.skipped}` : null,
    s.snoozed ? `Snoozed ${s.snoozed}` : null,
    s.contacted ? `Messaged ${s.contacted}` : null,
    s.opened ? `Opened ${s.opened}` : null,
  ].filter(Boolean).join(' · ');

  // "We could not look" and "there is nothing there" must never read the same, so a pass that has
  // never run says so rather than reporting a cheerful zero.
  const runLine = (label, r, extra = '') => {
    if (!r || !r.at) return `<div class="mach-l bad">${label} never run</div>`;
    return `<div class="mach-l ${r.ok ? '' : 'bad'}" title="${esc(r.at)}">${label} ${agoLabel(r.at)}${extra}${r.ok ? '' : ' · failed'}</div>`;
  };
  const dateLabel = new Date(s.day + 'T00:00:00Z').toLocaleDateString(undefined,
    { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });

  set('#sessionCard', `<div class="session">
    <div>
      <div class="session-d">${esc(dateLabel)}</div>
      <div class="big">Applied ${s.applied} of ${s.target}</div>
    </div>
    <div>
      <div class="meter" role="img" aria-label="${s.applied} of ${s.target} applications sent today">
        <i style="width:${pct(done, s.target)}%"></i></div>
      <div class="sub">${counts || 'Nothing answered yet today.'}</div>
    </div>
    <div class="mach">
      ${m.running ? `<div class="mach-l run">A sweep is running…</div>` : ''}
      ${runLine('Hunt', m.hunt, ` · ${m.foundToday} found (${m.goodToday} strong)`)}
      ${runLine('Mail', m.mail)}
    </div>
  </div>`);
}

const AG_WHEN = it => it.inDays < 0 ? `${-it.inDays}d overdue`
  : it.inDays === 0 ? (it.time || 'today') : `in ${it.inDays}d`;

function agendaRow(it) {
  const co = it.company
    ? (it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noreferrer">${esc(it.company)}</a>` : esc(it.company))
    : '';
  const quiet = it.kind === 'reply' && it.quiet != null
    ? ` <span class="${it.quiet >= 3 ? 'ag-quiet' : ''}">${it.quiet}d quiet</span>` : '';
  const doneBtn = !it.doneable ? ''
    : it.agenda_id ? `<button class="btn tiny" data-agenda-done="${it.agenda_id}">Done</button>`
    : `<button class="btn tiny" data-followup-done="${it.application_id}">Done</button>`;
  return `<div class="ag">
    <span class="pill k-${esc(it.kind)}">${esc(it.kind)}</span>
    <div class="ag-body">
      <div class="ag-t">${esc(it.title)}</div>
      <div class="ag-co">${co}${co && it.sub ? ' · ' : ''}${esc(it.sub || '')}${quiet}</div>
    </div>
    <span class="ag-when ${it.inDays < 0 ? 'late' : ''}" title="${esc(it.due)}${it.derived ? ' — ' + esc(it.derived) : ''}">${esc(AG_WHEN(it))}${it.time && it.inDays !== 0 ? ' · ' + esc(it.time) : ''}</span>
    <span class="ag-act">
      ${it.url ? `<a class="btn tiny" href="${esc(it.url)}" target="_blank" rel="noreferrer">Open</a>` : ''}
      ${doneBtn}
      ${it.agenda_id ? `<button class="btn tiny ghost" data-agenda-del="${it.agenda_id}" title="remove this item">✕</button>` : ''}
    </span>
  </div>`;
}

function renderAgenda() {
  const a = S.today.agenda;
  const groups = a.groups.filter(g => g.items.length);

  set('#agenda', groups.length
    ? groups.map(g => `<div class="ag-group">
        <div class="ag-h ${g.id === 'overdue' ? 'overdue' : ''}">${esc(g.label)} · ${g.items.length}</div>
        ${g.items.map(agendaRow).join('')}
      </div>`).join('')
    : '<div class="empty">Nothing dated. Good.</div>');

  set('#agendaDone', a.done.length
    ? `<div class="foot">Recently done</div>${a.done.map(d => `<div class="ag done">
        <span class="pill k-${esc(d.kind)}">${esc(d.kind)}</span>
        <div class="ag-body"><div class="ag-t">${esc(d.title)}</div>
          <div class="ag-co">${esc(d.company || '')}</div></div>
        <span class="ag-when">${esc(agoLabel(d.done_at))}</span>
        <span class="ag-act"><button class="btn tiny ghost" data-agenda-done="${d.id}" data-undo="1">Undo</button></span>
      </div>`).join('')}`
    : '');

  // Re-rendered only when it opens or closes: rebuilding it on every SSE tick would clear the
  // half-typed row underneath you.
  const form = $('#agendaForm');
  if (!agendaOpen) return void (form.innerHTML = '');
  if (form.firstChild) return;                       // already open: leave the half-typed row alone
  form.innerHTML = `<div class="ag-form">
    <input type="text" id="agTitle" placeholder="What is it?" autocomplete="off">
    <input type="date" id="agDay" value="${isoToday()}">
    <input type="time" id="agTime">
    <select id="agKind">${S.today.agendaKinds.map(k => `<option value="${k}">${k}</option>`).join('')}</select>
    <input type="text" id="agCompany" placeholder="Company (optional)" autocomplete="off">
    <button class="btn primary" data-agenda-save="1">Add</button>
  </div>`;
  $('#agTitle').focus();
}

/** The why chips: the reason a card is on the page, in the card. First three, signed. */
const whyChips = (why, n = 3) => `<div class="whys">${(why || []).slice(0, n).map(w => `
  <span class="why ${w.d < 0 ? 'neg' : ''}" title="${esc(w.t)}">
    ${w.d ? `<b>${w.d > 0 ? '+' : '−'}${Math.abs(w.d)}</b>` : ''}${esc(w.t)}</span>`).join('')}</div>`;

/** The money a row prints. A stored `(est)` band is a cache of an older estimator run and the
 *  score re-estimates live, so an estimated row shows the live figure — otherwise Cognition read
 *  "~₹12–20L" beside a Money bar of 85 on ~₹55L. `~` marks anything inferred. */
function moneyCell(r, k) {
  const top = r.money_top ?? r.sj?.money_top ?? null;
  if (r.est) return top != null ? `~₹${top}L` : '—';
  if (r.band_min_lpa != null) return `${k.m === 'i' ? '~' : ''}${lpa(r.band_min_lpa, r.band_max_lpa)}`;
  return top != null ? `~₹${top}L` : '—';
}

/** The expected-CTC suggestion (ask.mjs). Gold when the role cannot reach the floor, because
 *  that is a question about applying, not about the number. The basis is the tooltip: a figure
 *  with no visible source is one you cannot defend on a call. */
const SRC = { posted: 'from the posted band', peers: 'from AmbitionBox, similar engineers there',
              company: 'from AmbitionBox, company-wide', model: 'estimated from the employer type' };
function askCell(a) {
  if (!a) return `<span class="ask none" title="nothing to base a number on: no band, no usable AmbitionBox peers, unknown employer">—</span>`;
  return `<span class="ask s-${a.src} ${a.under ? 'under' : ''}" title="Type ₹${a.lpa},00,000 · ${esc(SRC[a.src])}\n${esc(a.basis)}">` +
    `${a.src === 'posted' ? '' : '~'}₹${a.lpa}L${a.under ? '<i>↓</i>' : ''}</span>`;
}

/** The five components as one line of mini chips: A64 M70 T85 C50 R35. `~` marks an inferred
 *  value, `?` an unknown one, so a 50 that means "no idea" never reads as a measured 50. */
const COMP = [['a', 'Alignment'], ['m', 'Money'], ['t', 'Timing'], ['c', 'Company'], ['r', 'Route']];
const confMark = k => k === 'i' ? '~' : k === 'u' ? '?' : '';
const miniBars = (c, k) => !c ? '' : `<div class="minis">${COMP.map(([key, label]) =>
  `<span class="mini k-${(k || {})[key] || 'm'}" title="${label}${(k || {})[key] === 'i' ? ' (inferred)' : (k || {})[key] === 'u' ? ' (unknown)' : ''}">
    ${key.toUpperCase()}${confMark((k || {})[key])}${c[key]}</span>`).join('')}</div>`;

/** Five reasons, one tap. The reason is the whole point — a skip without one teaches nothing. */
const skipChips = (target, id) => `<div class="skips">${S.today.skipReasons.map(([k, l]) =>
  `<button class="chip" data-rec="${target}" data-id="${id}" data-act="skipped" data-reason="${k}">${esc(l)}</button>`).join('')}
  <button class="chip" data-skipcancel="${target}:${id}">Cancel</button></div>`;

const PERSON_SKIPS = ['notinterested', 'senior', 'location'];

function renderPicks() {
  const P = S.today.leads;
  if (!P.picks.length) {
    set('#picks', '<div class="empty">Nothing eligible — run the hunt, or unsnooze something on Leads.</div>');
    return set('#picksFoot', `<div class="foot">${P.eligible} eligible · ${P.snoozed} snoozed</div>`);
  }

  set('#picks', P.picks.map(x => {
    const key = `lead:${x.id}`;
    const meta = [x.channel || '—', moneyCell(x, x.conf || {}), x.location, x.gate_years]
      .filter(v => v && String(v).trim()).map(esc).join(' · ');
    return `<div class="reco ${x.claimed_at ? 'claimed' : ''}">
      <div class="reco-top">
        <span class="score" title="fit, 0–100 — the score plus time, fit and what you have skipped">${x.fit}</span>
        ${x.claimed_at ? `<span class="tag claimed" title="Claude is applying to this — claimed ${agoLabel(x.claimed_at)}${x.claimed_note ? ` · ${esc(x.claimed_note)}` : ''}">◆ with Claude · ${ago(x.claimed_at)}</span>` : ''}
        ${x.warm ? '<span class="tag warm">warm route</span>' : ''}
        ${x.focus ? '<span class="tag focus">pinned</span>' : ''}
        ${x.expiresIn != null && x.expiresIn <= 2 ? `<span class="tag expiring">${x.expiresIn === 0 ? 'expires today' : `expires in ${x.expiresIn}d`}</span>` : ''}
      </div>
      <div class="reco-co">${esc(x.company)}</div>
      <div class="reco-role">${esc(x.role)}</div>
      <div class="reco-meta">${meta}</div>
      ${miniBars(x.components, x.conf)}
      ${whyChips(x.why)}
      ${skipOpen.has(key) ? skipChips('lead', x.id) : `<div class="reco-act">
        ${x.url ? `<a class="btn tiny" href="${esc(x.url)}" target="_blank" rel="noreferrer"
             data-rec="lead" data-id="${x.id}" data-act="opened">Open</a>` : ''}
        <button class="btn tiny primary" data-rec="lead" data-id="${x.id}" data-act="applied">Applied</button>
        <button class="btn tiny" data-skipopen="${key}">Skip ▾</button>
        <button class="btn tiny ghost" data-rec="lead" data-id="${x.id}" data-act="snoozed">Snooze</button>
      </div>`}
    </div>`;
  }).join(''));

  // "N strong on Leads" — eligible leads that would score a pick if they came up. Stated with
  // its threshold, because a bare "strong" is a number nobody can check.
  const cut = S.leads.cuts.strong;
  const strong = S.leads.rows.filter(r => !r.gates.length && r.potential >= cut).length;
  set('#picksFoot', `<div class="foot">${P.eligible} eligible · ${P.snoozed} snoozed · ${strong} on Leads at ${cut}+</div>`);
}

function renderOutreach() {
  const O = S.today.people;
  if (!O.picks.length) return set('#outreach',
    '<div class="empty">No one left to message — every ranked contact is snoozed or already contacted.</div>');

  set('#outreach', O.picks.map(x => {
    const key = `contact:${x.id}`;
    return `<div class="reco">
      <div class="reco-top">
        <span class="score" title="fit, 0–100">${x.fit}</span>
        ${x.degree ? `<span class="deg">${esc(x.degree)}</span>` : ''}
        ${x.mutual ? `<span class="tag warm" title="mutual connection">via ${esc(x.mutual)}</span>` : ''}
      </div>
      <div class="reco-co">${x.profile_url ? `<a href="${esc(x.profile_url)}" target="_blank" rel="noreferrer">${esc(x.name)}</a>` : esc(x.name)}</div>
      <div class="person-h">${esc(x.headline || x.role_hint || '')}</div>
      <div class="reco-meta">${esc(x.company || x.source || '—')}</div>
      ${whyChips(x.why)}
      ${x.snippet ? `<details class="snip"><summary>What they posted</summary><p>${esc(x.snippet)}</p></details>` : ''}
      ${skipOpen.has(key) ? `<div class="skips">${S.today.skipReasons.filter(([k]) => PERSON_SKIPS.includes(k)).map(([k, l]) =>
          `<button class="chip" data-rec="contact" data-id="${x.id}" data-act="skipped" data-reason="${k}">${esc(l)}</button>`).join('')}
          <button class="chip" data-skipcancel="${key}">Cancel</button></div>`
        : `<div class="reco-act">
        ${x.source_url ? `<a class="btn tiny" href="${esc(x.source_url)}" target="_blank" rel="noreferrer">Post</a>` : ''}
        <button class="btn tiny primary" data-rec="contact" data-id="${x.id}" data-act="contacted">Messaged</button>
        <button class="btn tiny" data-skipopen="${key}">Skip ▾</button>
        <button class="btn tiny ghost" data-rec="contact" data-id="${x.id}" data-act="snoozed">Snooze</button>
      </div>`}
    </div>`;
  }).join(''));
}

// ============================ page 2: board ============================

/**
 * Threads with a human in them, above everything else.
 *
 * This is the one block on the board that is not ranked by potential, because a live conversation
 * is not comparable to a lead. Sorted by how long it has been waiting: the cost of an unanswered
 * reply compounds, and this system has already lost eight days on a warm referral that way.
 */
function renderNeedsYou() {
  const w = S.mail.waiting;
  if (!w.length) return set('#needsYou', '');
  set('#needsYou', `<div class="needs">
    <h3>${w.length} thread${w.length > 1 ? 's' : ''} waiting on you</h3>
    ${w.map(x => { const st = WAITING_STAGE[x.status] || ['applied', 'replied']; return `<div class="need ${x.days >= 3 ? 'hot' : ''}">
      <div class="need-h"><b>${esc(x.company)}</b><span class="pill s-${st[0]}">${esc(st[1])}</span>
        <span class="days">${x.days}d quiet</span></div>
      <div class="need-r">${esc(x.role)}</div>
      ${x.next_action ? `<div class="need-a">${esc(x.next_action)}</div>` : ''}
    </div>`; }).join('')}
  </div>`);
}

// ============================ page 2: leads ============================

const MIN_CHOICES = [0, 50, 60, 70, 80];

function renderLeads() {
  const L = S.leads;
  const rows = L.rows;
  const claimedCount = rows.filter(r => r.claimed_at).length;
  // Releasing the last claim removes the chip, and a chip that is gone cannot be clicked off —
  // which would strand the page on an empty filtered view with no way back. Drop the filter with
  // the last claim it was filtering for.
  if (!claimedCount) leadClaimed = false;
  set('#leadFilters', `<span class="fl">lane</span>
    ${[['all', rows.length], ...(L.lanes || [])].map(([k, n]) => `<button class="chip ${leadLane === k ? 'on' : ''}" data-llane="${k}">${k === 'all' ? 'all' : LANE_LABEL[k]} · ${n}</button>`).join('')}
    <span class="fl">channel</span>
    ${['all', ...L.channels].map(ch => `<button class="chip ${leadChan === ch ? 'on' : ''}" data-lc="${esc(ch)}">${esc(ch)}</button>`).join('')}
    <span class="fl">min</span>
    ${MIN_CHOICES.map(m => `<button class="chip ${leadMin === m ? 'on' : ''}" data-lmin="${m}">${m || 'any'}</button>`).join('')}
    <button class="chip ${leadVerified ? 'on' : ''}" data-lver="1" title="only leads whose employer has a size, stage or batch on file">verified only</button>
    <button class="chip ${leadGated ? 'on' : ''}" data-lgated="1" title="${L.gated} leads are excluded by a hard gate — years, services, title, geography, expiry, floor">show gated · ${L.gated}</button>
    ${claimedCount ? `<button class="chip claimed ${leadClaimed ? 'on' : ''}" data-lclaimed="1" title="leads handed to Claude to apply to — highlighted until the claim is released or the application exists">with Claude · ${claimedCount}</button>` : ''}`);

  let view = rows.filter(r => leadGated || r.claimed_at ? true : !r.gates.length);
  if (leadClaimed) view = view.filter(r => r.claimed_at);
  if (leadLane !== 'all') view = view.filter(r => r.lane === leadLane);
  if (leadChan !== 'all') view = view.filter(r => (r.channel || '—') === leadChan);
  if (leadMin) view = view.filter(r => r.potential >= leadMin);
  if (leadVerified) view = view.filter(r => r.co && r.co.verified);
  if (leadQuery) {
    const q = leadQuery.toLowerCase();
    view = view.filter(r => `${r.company} ${r.role}`.toLowerCase().includes(q));
  }
  // A claimed row is one you are waiting on, so it outranks potential and it never falls below the
  // cap. It also survives the gate exclusion above: a lead you handed over is a lead you have already
  // judged, and hiding it behind a gate you have overruled is exactly the losing-track you asked for
  // a fix to. Your own filters — channel, minimum, search — still apply.
  // Among claimed rows, a "#N" in the claim note is the order I ranked them in when handing over
  // a list; it beats potential, which is the scorer's opinion and not the reason for the pick.
  view.sort((a, b) => (b.claimed_at ? 1 : 0) - (a.claimed_at ? 1 : 0) ||
    (a.claimed_at ? claimRank(a) - claimRank(b) : 0));

  // 845 rows will not be read, so the page shows a readable head and says what it is holding
  // back — a silent cap once rendered "120 of 120" against 443 open leads.
  const CAP = 150;
  const shown = view.slice(0, CAP);
  set('#leadCount', `${view.length} row${view.length === 1 ? '' : 's'}` +
    (leadQuery ? ` matching “${leadQuery}”` : '') +
    (view.length > CAP ? ` · showing the top ${CAP} by potential` : '') +
    ` · ${L.total} open leads, ${L.gated} gated, ${L.snoozed} snoozed` +
    (claimedCount ? ` · ${claimedCount} with Claude` : ''));

  if (!shown.length) return set('#leads',
    `<div class="empty">${leadQuery ? 'Nothing matches that.' : 'No leads match these filters.'}</div>`);
  set('#leads', `<div class="rows">${shown.map(leadRow).join('')}</div>` +
    (view.length > CAP ? `<div class="more">${view.length - CAP} more below the cut — filter by channel, minimum or search to reach them.</div>` : ''));
}

// The employer, as a badge: what is on file, or an honest "unverified".
function coBadge(co) {
  if (!co || !co.verified) return `<span class="tag unv" title="no size, stage or batch on file — run enrich or set it by hand">? unverified</span>`;
  const heads = co.headcount == null ? null : co.headcount >= 10000 ? '10k+ people' : `${co.headcount} people`;
  const bits = [co.stage, co.yc ? `YC ${co.yc}` : null, heads].filter(Boolean);
  return `<span class="tag co ${co.target ? 'target' : ''}" title="${co.target ? 'on your target list · ' : ''}from the company page or set by hand">${esc(bits.join(' · '))}</span>`;
}

function leadRow(r) {
  const key = `lead:${r.id}`;
  const sj = r.sj, k = sj.k, c = sj.c;
  const gated = r.gates.length > 0;
  const days = r.at ? ago(r.at) : '';
  const timing = [days ? `${days}` : null,
                  r.applicants != null ? (r.applicants > 100 ? '>100 appl.' : r.applicants <= 25 ? `<25 appl.` : `${r.applicants} appl.`) : null]
    .filter(Boolean).join(' · ');
  const money = moneyCell(r, k);
  const snoozed = r.snoozed_until && r.snoozed_until > isoToday();
  const claimed = !!r.claimed_at;
  return `<div class="r lr ${gated ? 'gated' : ''} ${snoozed ? 'snoozed' : ''} ${claimed ? 'claimed' : ''}">
    <button class="score ${drawerId === r.id ? 'on' : ''}" data-drawer="${r.id}" title="potential ${r.potential} — click for the five bars">${r.potential}</button>
    <span class="co">
      ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.company)}</a>` : esc(r.company)}
      ${coBadge(r.co)}
      ${claimed ? `<span class="tag claimed" title="Claude is applying to this — claimed ${agoLabel(r.claimed_at)}${r.claimed_note ? ` · ${esc(r.claimed_note)}` : ''}">◆ ${claimRank(r) < 1e9 ? `#${claimRank(r)} · ` : ''}${ago(r.claimed_at)}</span>` : ''}
      ${r.focus ? '<span class="tag focus">pinned</span>' : ''}
      ${r.warm ? '<span class="tag warm">warm</span>' : ''}
      ${snoozed ? `<span class="tag" title="snoozed until ${esc(r.snoozed_until)}">snoozed</span>` : ''}
    </span>
    <span class="role" title="${esc(r.role)}">${r.lane && LANE_LABEL[r.lane] ? `<span class="tag lane l-${r.lane}" title="${esc(r.lane_why || '')}">${LANE_LABEL[r.lane]}</span> ` : ''}${esc(r.role)}
      ${gated ? `<span class="gates">${r.gates.map(g => `<span class="tag gate" title="${esc(g.t)}">${esc(g.g)}</span>`).join('')}</span>` : ''}</span>
    <span class="ch">${esc(r.channel || '—')}</span>
    <span class="band" title="${k.m === 'i' ? 'inferred — AmbitionBox or the employer model' : k.m === 'u' ? 'no band and nothing to infer from' : 'stated on the posting'}">${money}</span>
    ${askCell(r.ask)}
    <span class="when" title="${esc(r.at || '')}${r.posted_at ? ' (posted)' : ' (discovered)'}">${timing || '—'}</span>
    <span class="align" title="alignment ${c.a}${k.a === 'i' ? ' — inferred from the title' : ' — measured from the JD'}">${k.a === 'i' ? '~' : ''}${c.a}%</span>
    <span class="act">
      ${r.url ? `<a class="btn tiny" href="${esc(r.url)}" target="_blank" rel="noreferrer" data-rec="lead" data-id="${r.id}" data-act="opened">Open</a>` : ''}
      <button class="btn tiny primary" data-rec="lead" data-id="${r.id}" data-act="applied">Applied</button>
      <button class="btn tiny" data-skipopen="${key}">Skip ▾</button>
      <button class="btn tiny ghost" data-rec="lead" data-id="${r.id}" data-act="snoozed" title="hide from Today for a few days">Snooze</button>
      <button class="btn tiny ghost" data-focus="${r.id}" data-on="${r.focus ? 1 : 0}" title="pin to the top">${r.focus ? '★' : '☆'}</button>
      <button class="btn tiny ghost ${claimed ? 'on' : ''}" data-claim="${r.id}" data-on="${claimed ? 1 : 0}" title="${claimed ? 'release the claim' : 'mark as handed to Claude'}">◆</button>
    </span>
    ${skipOpen.has(key) ? `<div class="r-note">${skipChips('lead', r.id)}</div>` : ''}
  </div>`;
}

/**
 * The breakdown drawer: five bars with their confidence, the chips behind each, the gates, the
 * adjustments and the fit note. Fetched from /api/row/lead/:id on demand — the list carries only
 * the summary. A recommender that moves for reasons nobody can see is one nobody should trust.
 */
async function openDrawer(id) {
  drawerId = id;
  const r = await (await fetch(`/api/row/lead/${id}`)).json();
  const el = $('#leadDrawer');
  let sc = null; try { sc = JSON.parse(r.score_json || 'null'); } catch {}
  if (!sc || sc.v !== 2) { el.hidden = false; el.innerHTML = `<div class="bd-h"><b>${esc(r.company)}</b><button class="btn tiny ghost" data-drawer-close="1">✕</button></div><div class="empty">No v2 breakdown stored yet — run <code>./ladder score</code>.</div>`; return; }
  const CONF = { measured: 'measured', inferred: 'inferred', unknown: 'unknown' };
  const bars = Object.entries(sc.c).map(([key, comp]) => `<div class="bd-col">
      <div class="bd-track"><i class="bd-bar k-${comp.conf[0]}" style="height:${comp.v}%"></i></div>
      <div class="bd-v">${comp.v}</div>
      <div class="bd-l">${esc(key)}<span class="bd-w">w${sc.w[key]}</span></div>
      <div class="bd-c k-${comp.conf[0]}">${CONF[comp.conf]}</div>
    </div>`).join('');
  const chipsFor = (key, comp) => `<div class="bd-sec"><div class="bd-st">${esc(key)}</div>${whyChips(comp.why, 6)}</div>`;
  el.hidden = false;
  el.innerHTML = `<div class="bd-h">
      <div><b>${esc(r.company)}</b><div class="bd-role">${esc(r.role)}</div></div>
      <div class="bd-p"><span class="score big">${sc.potential}</span><span class="bd-pl">potential · ${esc(sc.conf)}</span></div>
      <button class="btn tiny ghost" data-drawer-close="1" title="close">✕</button>
    </div>
    ${sc.gated.length ? `<div class="bd-gates">Excluded: ${sc.gated.map(g => `<span class="tag gate">${esc(g.g)}</span> ${esc(g.t)}`).join(' · ')}</div>` : ''}
    <div class="bd-bars">${bars}</div>
    ${Object.entries(sc.c).map(([k, comp]) => chipsFor(k, comp)).join('')}
    ${sc.adj.length ? `<div class="bd-sec"><div class="bd-st">adjustments</div>${whyChips(sc.adj, 6)}</div>` : ''}
    <div class="bd-sec"><div class="bd-st">on the row</div>
      <div class="bd-meta">${[r.channel, r.location, r.band_raw, r.gate_years ? `gate ${r.gate_years}` : null,
        r.applicants != null ? `${r.applicants} applicants` : null,
        r.jd_status ? `JD ${r.jd_status}${r.jd_checked_at ? ' ' + agoLabel(r.jd_checked_at) : ''}` : 'JD not read yet',
        `scored ${agoLabel(sc.at)}`].filter(Boolean).map(esc).join(' · ')}</div>
      ${r.fit_note ? `<div class="r-note">${esc(r.fit_note)}</div>` : ''}
      ${r.notes ? `<div class="r-note">${esc(r.notes)}</div>` : ''}
    </div>`;
  renderLeads();
}
function closeDrawer() { drawerId = null; const el = $('#leadDrawer'); el.hidden = true; el.innerHTML = ''; renderLeads(); }

// ============================ page 3: applications ============================

function renderApps() {
  const rows = S.applications.rows;
  const c = S.applications.stageCounts;

  // The stage strip. Doubles as the filter, because a count you cannot click is a count you have
  // to go and find somewhere else. `scraped` is a lead stage and lives on the Leads page now.
  const strip = S.stages.filter(s => s.id !== 'scraped').map(s => `<button class="st st-${s.id} ${stageFilter === s.id ? 'on' : ''}"
      data-sf="${s.id}" title="${esc(s.hint)}">
      <b>${c[s.id] || 0}</b><span>${esc(s.label)}</span></button>`).join('<i class="arrow">›</i>');
  set('#stageStrip', `<button class="st st-all ${stageFilter === 'all' ? 'on' : ''}" data-sf="all">
      <b>${rows.filter(r => r.stage !== 'closed').length}</b><span>All live</span></button>
    <i class="arrow">›</i>${strip}
    <button class="st st-closed ${stageFilter === 'closed' ? 'on' : ''}" data-sf="closed"
      title="rejected, withdrawn or gone quiet — kept, never deleted"><b>${c.closed || 0}</b><span>Closed</span></button>`);

  const chans = [...new Set(rows.map(r => r.channel || '—'))].sort();
  set('#appFilters', `<span class="fl">channel</span>
    ${['all', ...chans].map(ch => `<button class="chip ${chanFilter === ch ? 'on' : ''}" data-cf="${esc(ch)}">${esc(ch)}</button>`).join('')}`);

  // `live` and `deep` come from the header tiles and match their counts: live = replied or further,
  // deep = assessment or further.
  const DEEP = ['assessment', 'interview', 'converged'];
  let view = rows.filter(r => stageFilter === 'all' ? r.stage !== 'closed'
    : stageFilter === 'live' ? r.replied || DEEP.includes(r.stage)
    : stageFilter === 'deep' ? DEEP.includes(r.stage)
    : r.stage === stageFilter);
  if (chanFilter !== 'all') view = view.filter(r => (r.channel || '—') === chanFilter);
  if (appQuery) {
    const q = appQuery.toLowerCase();
    view = view.filter(r => `${r.company} ${r.role}`.toLowerCase().includes(q));
  }
  set('#appCount', ({ live: 'Live: ', deep: 'Assessment+: ' }[stageFilter] || '') +
    `${view.length} row${view.length === 1 ? '' : 's'}` +
    (appQuery ? ` matching “${appQuery}”` : '') +
    ` · ${rows.filter(r => r.stage !== 'closed').length} live, ${c.closed || 0} closed`);

  if (!view.length) return set('#apps',
    `<div class="empty">${appQuery ? 'Nothing matches that.' : 'Nothing in this stage.'}</div>`);
  set('#apps', `<div class="rows">${view.map(appRow).join('')}</div>`);
}

function appRow(r) {
  const stage = r.stage === 'closed' ? (r.closed_as || 'closed') : r.stage;
  const key = `app:${r.id}`;
  const editing = editApp && editApp.id === r.id;
  return `<div class="r ar ${r.stage === 'closed' ? 'dead' : ''}">
    <span class="pill s-${esc(r.stage)}" title="${esc(r.stage)}">${esc(stage)}</span>
    <span class="score ${r.potential == null ? 'none' : ''}" title="${r.potential == null ? 'no fit score typed on this application' : 'fit, 0–100 — your own judgement'}">${r.potential ?? '·'}</span>
    <span class="co">
      ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noreferrer">${esc(r.company)}</a>` : esc(r.company)}
      ${r.focus ? '<span class="tag focus">pinned</span>' : ''}
      ${r.replied ? '<span class="tag warm">replied</span>' : ''}
    </span>
    <span class="role">${esc(r.role)}</span>
    <span class="ch">${esc(r.channel || '—')}</span>
    <span class="band">${lpa(r.band_min_lpa, r.band_max_lpa)}</span>
    ${askCell(r.ask)}
    <span class="when clickable" title="click to set the next action and its date" data-edit-app="${r.id}">${r.quiet_days != null ? r.quiet_days + 'd quiet' : ago(r.at)}
      ${r.next_action_due ? `<span class="due">due ${esc(r.next_action_due)}</span>` : ''}</span>
    <span class="act">
      <button class="btn tiny ghost info" data-detail="${key}" title="show the note behind this row">ⓘ</button>
      <select data-app="${r.id}" title="move stage">
        ${STAGE_STATUS.map(([v, l]) => `<option value="${v}" ${appStatusOf(r) === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></span>
    ${r.next_action ? `<div class="r-note">${esc(r.next_action)}</div>` : ''}
    ${editing ? `<div class="r-edit">
      <label for="edAction">next action</label>
      <input type="text" id="edAction" value="${esc(editApp.next_action || '')}" placeholder="e.g. follow up with the recruiter">
      <label for="edDue">due</label>
      <input type="date" id="edDue" value="${esc(editApp.next_action_due || '')}">
      <button class="btn tiny primary" data-save-app="${r.id}">Save</button>
      <button class="btn tiny ghost" data-cancel-app="1">Cancel</button>
    </div>` : ''}
    ${detailOpen.has(key) ? `<div class="r-note">${esc(detailOpen.get(key) || 'No note on this row.')}</div>` : ''}
  </div>`;
}

// The row carries a stage, not a status, so the select has to recover the underlying status to
// preselect itself. Replied is the only one the stage cannot express on its own.
function appStatusOf(r) {
  if (r.closed_as) return r.closed_as;
  if (r.replied) return 'replied';
  return { applied: 'applied', assessment: 'screen', interview: 'interview', converged: 'offer' }[r.stage] || 'applied';
}

// ============================ page 3: people ============================

const PEOPLE_FILTERS = [
  ['all', 'All', () => true],
  ['2nd', '2nd degree', p => p.degree === '2nd'],
  ['recruiter', 'Recruiters', p => p.ckind === 'recruiter'],
  ['fde', 'Hiring FDE', p => (p.why || []).some(w => /FDE/.test(w.t))],
  ['contacted', 'Contacted', p => p.status === 'contacted' || p.status === 'replied'],
  ['snoozed', 'Snoozed', p => p.snoozed_until && p.snoozed_until > isoToday()],
];

function renderPeople() {
  const all = S.people;
  const f = PEOPLE_FILTERS.find(x => x[0] === peopleFilter) || PEOPLE_FILTERS[0];
  const view = all.filter(f[2]);

  set('#peopleFilters', PEOPLE_FILTERS.map(([k, l, fn]) =>
    `<button class="chip ${peopleFilter === k ? 'on' : ''}" data-pf="${k}">${esc(l)} <b>${all.filter(fn).length}</b></button>`).join(''));

  const CAP = 200;
  const shown = view.slice(0, CAP);
  $('#peopleCount').textContent = `${view.length} of ${all.length} ranked`
    + (view.length > CAP ? ` · showing the top ${CAP}, ${view.length - CAP} not listed` : '');

  if (!shown.length) return set('#peopleTable', '<div class="empty">No one matches that filter.</div>');

  set('#peopleTable', `<table class="tbl"><thead><tr>
      <th>Fit</th><th>Name</th><th>Headline</th><th>Degree</th><th>Company</th><th>Why</th>
      <th>Status</th><th></th></tr></thead><tbody>
    ${shown.map(p => {
      const snoozed = p.snoozed_until && p.snoozed_until > isoToday();
      return `<tr class="${snoozed ? 'snoozed' : ''}">
        <td>${p.fit}</td>
        <td class="p-name">${p.profile_url ? `<a href="${esc(p.profile_url)}" target="_blank" rel="noreferrer">${esc(p.name)}</a>` : esc(p.name)}</td>
        <td class="p-head" title="${esc(p.headline || '')}">${esc(p.headline || p.role_hint || '—')}</td>
        <td>${p.degree ? `<span class="deg">${esc(p.degree)}</span>` : ''}${p.mutual ? ` <span class="tag warm">${esc(p.mutual)}</span>` : ''}</td>
        <td>${esc(p.company || '—')}</td>
        <td class="p-why" title="${esc((p.why || []).map(w => w.t).join(' · '))}">${esc((p.why || []).slice(0, 2).map(w => w.t).join(' · '))}</td>
        <td><select data-contact-status="${p.id}">
          ${CONTACT_STATUS.map(([v, l]) => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td class="p-act">${snoozed
          ? `<span class="tag">until ${esc(p.snoozed_until)}</span>`
          : `<button class="btn tiny ghost" data-rec="contact" data-id="${p.id}" data-act="snoozed">Snooze</button>`}</td>
      </tr>`;
    }).join('')}</tbody></table>`);
}

// ============================ page 4: stats ============================

// A rate, rendered honestly. `enough` is false when the sample is too small to mean anything, and
// the cell then says so instead of printing a confident percentage off n=2. This is the single
// most important convention on the page: 50% off 4 sends and 50% off 400 sends are different
// facts, and rendering them identically is worse than rendering nothing.
function rateCell(r, { showN = true } = {}) {
  if (!r || !r.n) return '<span class="rate none">no data</span>';
  const body = `<b>${r.pct}%</b>${showN ? `<i>${r.k}/${r.n}</i>` : ''}`;
  if (!r.enough)
    return `<span class="rate thin" title="only ${r.n} data points — needs ${esc(r.need)} to mean anything">${body}<em>±${Math.round((r.hi - r.lo) / 2)}</em></span>`;
  return `<span class="rate">${body}</span>`;
}

// A horizontal proportion bar — a share of a whole is easier to compare by length than by reading
// four percentages down a column.
const propBar = (p, cls = '') => `<span class="pbar ${cls}"><i style="width:${Math.max(1, p)}%"></i></span>`;

function renderStats() {
  const a = S.apps, m = S.mail, sw = S.sweeps, A = S.analytics;

  set('#recommendations', S.recommendations.length
    ? S.recommendations.map(r => `<div class="rec sev-${r.sev}">
        <div class="rec-t">${esc(r.title)}</div>
        <div class="rec-d">${esc(r.detail)}</div>
      </div>`).join('')
    : '<div class="empty">Nothing worth changing — which is itself worth a second look.</div>');

  renderHeadline(A.forecast);
  renderFunnelSteps(A.funnel);
  renderForecast(A.forecast);
  renderRoutes(A.routes);
  renderDeaths(A.deaths);
  renderPlatforms(A.platforms);
  renderLatency(A.latency);
  renderRejections(A.rejections);
  renderCalibration(A.calibration);
  renderBands(A.bands);
  renderSupply(A.supply);

  // --- the original count panels, kept because they answer "is the machine running" ---
  $('#appsHint').textContent = `${a.sent} sent · ${a.live} live · ${a.rejected} rejected`;
  set('#appStats', [
    ['Sent', a.sent, 'hand-sent and actually submitted'],
    ['Live', a.live, 'replied, assessment, interview or offer'],
    ['Reply rate', a.replyRate + '%', 'the number to plan volume against'],
    ['Rejected', a.rejected, 'an explicit no'],
    ['Gone quiet', a.ghosted, 'no movement in 21 days'],
  ].map(([k, v, t]) => `<div class="stat" title="${esc(t)}"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`).join(''));

  const wk = a.weeks, max = Math.max(1, ...wk.map(w => w.n));
  set('#appWeeks', wk.length
    ? `<div class="bars">${wk.map(w => `<div class="bar" title="${esc(w.wk)}: ${w.n} sent">
        <i style="height:${Math.max(4, pct(w.n, max))}%"></i><span>${esc(w.wk.slice(-3))}</span></div>`).join('')}</div>`
    : '');

  set('#mailStats', `<table class="tbl"><thead><tr>
      <th>Surface</th><th>Msgs</th><th>Good</th><th>No</th><th>Last</th></tr></thead><tbody>
    ${m.bySource.map(x => `<tr><td>${esc(x.source)}</td><td>${x.n}</td>
      <td class="${x.good ? 'g' : ''}">${x.good}</td><td>${x.bad}</td>
      <td title="${esc(x.last_ts || '')}">${ago(x.last_ts)}</td></tr>`).join('')}
    </tbody></table>
    <div class="kinds">${m.byKind.map(k => `<span class="chip flat">${esc(k.kind)} <b>${k.n}</b></span>`).join('')}</div>`);

  set('#sweepStats', `<div class="runs">${sw.runs.slice(0, 6).map(r => `<div class="run ${r.hung ? 'hung' : r.ok ? 'ok' : 'bad'}">
      <span class="run-k">${r.kind === 'both' ? 'hunt+mail' : r.kind}</span>
      <span class="run-t" title="${esc(r.started_at)}">${ago(r.started_at)}</span>
      <span class="run-f">${r.findings} found</span>
      <span class="run-s">${r.hung ? 'never finished' : r.ok ? 'ok' : 'failed'}</span>
    </div>`).join('')}</div>
    <table class="tbl"><thead><tr><th>Channel</th><th>Runs</th><th>Worked</th><th>Last note</th></tr></thead><tbody>
    ${sw.byChannel.map(c => `<tr class="${c.ok === 0 ? 'bad' : ''}"><td>${esc(c.channel)}</td>
      <td>${c.runs}</td><td>${c.ok}</td><td class="note">${esc(c.lastNote || '')}</td></tr>`).join('')}
    </tbody></table>`);

  set('#mailFeed', m.recent.map(e => `<div class="ev">
    <span class="ev-k k-${esc(e.kind)}" title="${esc(e.kind)}">${esc(EV_LABEL[e.kind] || e.kind)}</span>
    <span class="ev-t">${esc(e.company || '')} ${esc(e.title || '')}</span>
    <span class="ev-a" title="${esc(e.ts)}">${ago(e.ts)}</span>
  </div>`).join('') || '<div class="empty">No inbound recorded yet.</div>');
}

/** Four numbers. Everything else on the page explains one of them. */
function renderHeadline(F) {
  const rw = S.roadmap.runway;
  set('#headline', `
    <div class="stat" title="sends per week over the last ${F.windowDays} days, against what the target needs">
      <b>${F.perWeek}</b><span>Sent / week ${F.needPerWeek == null ? '' : `· needs ${F.needPerWeek}`}</span></div>
    <div class="stat ${F.replyRate.enough ? '' : 'thin'}" title="live threads ÷ sends${F.replyRate.enough ? '' : ` — only ${F.replyRate.n} sends, needs ${F.replyRate.need}`}">
      <b>${F.replyRate.pct == null ? '—' : F.replyRate.pct + '%'}</b>
      <span>Reply rate · ${F.replyRate.k} of ${F.replyRate.n}${F.replyRate.enough ? '' : ` · ±${Math.round((F.replyRate.hi - F.replyRate.lo) / 2)}`}</span></div>
    <div class="stat"><b>${S.apps.live}</b><span>Live threads</span></div>
    <div class="stat" title="to ${esc(rw.end)}"><b>${rw.left}</b><span>Days of runway</span></div>`);
}

/** The funnel as a ladder of conversion rates. Counts say where things are; rates say where they stop. */
function renderFunnelSteps(f) {
  const c = f.counts;
  set('#funnelSteps', `
    <div class="fsteps">${f.steps.map(s => `
      <div class="fstep ${s.enough ? '' : 'thin'}">
        <div class="fstep-l"><b>${esc(s.from)}</b> <i>&rarr;</i> <b>${esc(s.to)}</b></div>
        <div class="fstep-b">${propBar(s.pct || 0)}</div>
        <div class="fstep-r">${rateCell(s)}</div>
        ${s.note ? `<div class="fstep-n">${esc(s.note)}</div>` : ''}
      </div>`).join('')}
    </div>
    <div class="fnote">Of <b>${c.everFound}</b> leads ever found: ${c.expired} expired,
      ${c.dropped} were judged out, <b>${c.scraped}</b> are still open, ${c.sentFromLead} were sent.
      A further <b>${c.sentDirect}</b> applications were sent straight from a portal and never had a
      lead row, which is why sends (${c.sent}) exceed leads marked applied.</div>`);
}

function renderForecast(F) {
  const span = Math.max(1, F.projLiveHi);
  set('#forecast', `
    <div class="statgrid">
      <div class="stat" title="sends per week over the last ${F.windowDays} days"><b>${F.perWeek}</b><span>Sent / week now</span></div>
      <div class="stat" title="what the current pace produces over the remaining runway"><b>${F.projSends}</b><span>Projected sends</span></div>
      <div class="stat"><b>${F.projLive}</b><span>Projected conversations</span></div>
      <div class="stat" title="what it would take to reach ${F.target} live conversations"><b>${F.needPerWeek == null ? '—' : F.needPerWeek}</b><span>Needed / week</span></div>
    </div>
    <div class="fbar">
      <div class="fbar-t">${F.projLive} conversations projected by day ${F.runwayDays}
        <span class="ci">95% interval ${F.projLiveLo}–${F.projLiveHi}</span></div>
      <div class="fbar-track">
        <i style="left:${pct(F.projLiveLo, span)}%;width:${Math.max(2, pct(F.projLiveHi - F.projLiveLo, span))}%"></i>
        <b style="left:${pct(F.projLive, span)}%"></b>
      </div>
      <div class="fbar-s">${F.shortfall > 0
        ? `<span class="bad">Behind pace.</span> ${F.needSends} sends buys ${F.target} conversations; the current pace reaches ${F.projSends}. Short by ${F.shortfall}.`
        : `<span class="good">On pace.</span> ${F.target} conversations needs about ${F.needSends} sends; the current pace projects ${F.projSends}.`}</div>
    </div>
    ${F.whyNoOfferForecast ? `<div class="caveat">${esc(F.whyNoOfferForecast)}</div>` : ''}`);
}

function renderRoutes(rs) {
  if (!rs.length) return set('#routes', '<div class="empty">Nothing sent yet.</div>');
  const max = Math.max(...rs.map(r => r.n));
  set('#routes', `<div class="routes">${rs.map(r => `
    <div class="route ${r.k > 0 ? 'won' : ''}">
      <div class="route-h"><b>${esc(r.label)}</b>${rateCell(r)}</div>
      <div>${propBar(pct(r.n, max), r.k > 0 ? 'good' : 'flat')}</div>
      <div class="route-n">${esc(r.note)} · <span class="mono">${r.channels.map(esc).join(', ')}</span></div>
    </div>`).join('')}</div>`);
}

function renderDeaths(d) {
  if (!d.total) return set('#deaths', '<div class="empty">No leads have been dropped yet.</div>');
  set('#deaths', `<div class="deaths">${d.buckets.map(b => `
    <div class="death">
      <div class="death-h"><b>${esc(b.label)}</b><span class="death-n">${b.n} <i>${b.pct}%</i></span></div>
      <div>${propBar(b.pct, b.key === 'stale' ? 'bad' : '')}</div>
      <div class="death-x">${esc(b.note)}</div>
    </div>`).join('')}</div>
    <div class="fnote">${d.total} dropped or expired leads carry a reason${d.unlabelled ? `; ${d.unlabelled} do not` : ''}.</div>`);
}

function renderPlatforms(ps) {
  set('#platforms', `<table class="tbl"><thead><tr>
      <th>Platform</th><th>Route</th><th>Sent</th><th>Live</th><th>Reply rate</th><th>Deep</th><th>Median reply</th>
    </tr></thead><tbody>
    ${ps.map(p => `<tr class="${p.k > 0 ? 'good' : p.n >= 15 ? 'bad' : ''}">
      <td>${esc(p.channel)}</td><td class="dimc">${esc(p.route)}</td>
      <td>${p.n}</td><td>${p.k}</td><td>${rateCell(p, { showN: false })}</td><td>${p.deep}</td>
      <td>${p.medianDays == null ? '<span class="rate none">—</span>' : p.medianDays + 'd'}</td>
    </tr>`).join('')}</tbody></table>`);
}

function renderLatency(L) {
  if (!L.n) return set('#latency',
    `<div class="nodata"><b>No answered application has both timestamps yet.</b>
      <span>This fills in as replies arrive — it needs the applied date and the reply date on the same row.</span></div>`);
  set('#latency', `
    <div class="statgrid">
      <div class="stat"><b>${L.median}d</b><span>Median reply</span></div>
      <div class="stat"><b>${L.p90}d</b><span>90th percentile</span></div>
      <div class="stat"><b>${L.max}d</b><span>Slowest ever</span></div>
    </div>
    ${L.enough ? '' : `<div class="caveat">Off ${L.n} replies. Treat this as a shape, not a number.</div>`}
    <div class="waitbox">
      <div class="waitbox-h">${L.open.n} applications are still silent · median ${L.open.median}d</div>
      ${L.open.beyondSlowest == null ? '' : `<div class="waitbox-b">
        <b>${L.open.beyondSlowest}</b> of them have been silent longer than <b>${L.max} days</b> — the slowest
        reply you have ever had. On the evidence you actually possess, those are closed.</div>`}
    </div>`);
}

function renderRejections(R) {
  set('#rejections', `
    <div class="statgrid">
      <div class="stat"><b>${R.n}</b><span>Explicit rejections</span></div>
      <div class="stat"><b>${R.silent}</b><span>Never answered</span></div>
      <div class="stat"><b>${R.medianDays == null ? '—' : R.medianDays + 'd'}</b><span>Median time to no</span></div>
    </div>
    ${R.n ? `<table class="tbl compact"><thead><tr><th>Company</th><th>Via</th><th>Days</th></tr></thead><tbody>
      ${R.rows.map(r => `<tr><td>${esc(r.company)}</td><td class="dimc">${esc(r.channel || '—')}</td>
        <td>${r.days == null ? '—' : r.days + 'd'}</td></tr>`).join('')}
    </tbody></table>` : ''}
    <div class="caveat">Silence outnumbers rejection ${R.silent}:${R.n}. Being ignored is the default outcome,
      so an explicit no is comparatively good news — it is at least a decision.</div>`);
}

function renderCalibration(C) {
  const table = rows => `<table class="tbl compact"><thead><tr><th>Score</th><th>Sent</th><th>Live</th></tr></thead><tbody>
    ${rows.filter(b => b.n).map(b => `<tr><td>${esc(b.label)}</td><td>${b.n}</td><td>${b.k}</td></tr>`).join('')}
  </tbody></table>`;
  if (!C.usable) return set('#calibration',
    `<div class="nodata"><b>Not enough scored sends to answer this yet.</b>
      <span>${C.scored} of ${C.total} sends carry a fit score; this needs about 40. Until then the board's
      ranking is untested — score each application as it goes out and the answer appears here.</span></div>
    ${C.scored ? table(C.buckets) : ''}`);
  set('#calibration', `<table class="tbl"><thead><tr><th>Score</th><th>Sent</th><th>Live</th><th>Reply rate</th></tr></thead><tbody>
    ${C.buckets.map(b => `<tr><td>${esc(b.label)}</td><td>${b.n}</td><td>${b.k}</td><td>${rateCell(b, { showN: false })}</td></tr>`).join('')}
  </tbody></table>`);
}

function renderBands(B) {
  if (!B.buckets.some(b => b.n)) return set('#bands',
    `<div class="nodata"><b>No sent application has a known band.</b>
      <span>${B.unknown} sends posted no band, which is normal — LinkedIn publishes none at all.</span></div>`);
  set('#bands', `<table class="tbl"><thead><tr><th>Band</th><th>Sent</th><th>Live</th><th>Reply rate</th></tr></thead><tbody>
    ${B.buckets.map(b => `<tr><td>${esc(b.label)}</td><td>${b.n}</td><td>${b.k}</td><td>${rateCell(b, { showN: false })}</td></tr>`).join('')}
  </tbody></table>
  ${B.unknown ? `<div class="caveat">${B.unknown} of ${B.known + B.unknown} sends posted no band and are excluded.</div>` : ''}`);
}

function renderSupply(sp) {
  set('#supply', `
    <div class="statgrid">
      <div class="stat"><b>${sp.foundPerDay}</b><span>Found / day</span></div>
      <div class="stat"><b>${sp.sentPerDay}</b><span>Sent / day</span></div>
      <div class="stat"><b>${sp.expiredPerDay}</b><span>Expired / day</span></div>
    </div>
    ${sp.daysToDrainBoard ? `<div class="caveat ${sp.daysToDrainBoard > 120 ? 'bad' : ''}">
      At ${sp.sentPerDay} sends a day, the ${sp.open} open leads are <b>${sp.daysToDrainBoard} days</b>
      of work. Supply is not the constraint.</div>` : ''}
    <table class="tbl compact"><thead><tr><th>Channel</th><th>Found</th><th>Applied</th><th>Expired</th></tr></thead><tbody>
      ${sp.byChannel.slice(0, 10).map(c => `<tr><td>${esc(c.channel)}</td><td>${c.found}</td>
        <td>${c.applied}</td><td class="dimc">${c.expired}</td></tr>`).join('')}
    </tbody></table>
    <div class="fnote">Last ${sp.windowDays} days.</div>`);
}

// ============================ page 5: roadmap ============================

function renderRoadmap() {
  const rw = S.roadmap.runway;
  set('#runwayBar', `<div class="runway">
      <div class="rw-bar"><i style="width:${rw.pct}%"></i></div>
      <div class="rw-legend"><span>${esc(rw.start)}</span>
        <b>${rw.left} days left of ${rw.total}</b><span>${esc(rw.end)}</span></div>
    </div>`);

  set('#phases', S.roadmap.phases.map(p => `<div class="card phase">
    <h2>${esc(p.label)} <span class="hint">${esc(p.hint)}</span>
      <span class="phase-n ${p.done === p.total ? 'full' : ''}">${p.done}/${p.total}</span></h2>
    <div class="items">${p.items.map(i => `<div class="item ${i.done ? 'done' : ''} ${i.auto ? 'auto' : ''}">
      <button class="tick" ${i.auto ? 'disabled title="derived from the database — it ticks itself"' : `data-tick="${esc(i.id)}" data-done="${i.done ? 1 : 0}"`}>${i.done ? '✓' : ''}</button>
      <span class="item-l">${esc(i.label)}${i.auto ? '<span class="tag auto">auto</span>' : ''}</span>
      ${i.note ? `<span class="item-n">${esc(i.note)}</span>` : ''}
    </div>`).join('')}</div>
  </div>`).join(''));
}

// ============================ interaction ============================

const TABS = ['today', 'leads', 'apps', 'people', 'stats', 'roadmap'];
function goto(tab) {
  if (tab === 'board') tab = 'leads';                // the old Board tab's hash still lands somewhere
  if (!TABS.includes(tab)) tab = 'today';
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('on', s.id === 'tab-' + tab);
  location.hash = tab;
}

// One recorded answer. Everything on Today routes through here, so a skip, a snooze and an
// "Applied" are the same shape of write — and every one of them is reversible from Board or People.
async function rec(target, id, action, reason) {
  const r = await post('/api/rec', { target, id: +id, action, reason: reason || null });
  if (r.error) { toast(r.error); return; }
  skipOpen.delete(`${target}:${id}`);
  const what = { applied: r.promoted ? `Marked applied: ${r.promoted}` : 'Marked applied',
                 skipped: 'Skipped — the reason is recorded', snoozed: 'Snoozed for a few days',
                 contacted: 'Marked messaged', opened: null }[action];
  if (what) toast(what);
  return load();
}

document.addEventListener('click', async e => {
  const t = e.target.closest('button, a, [data-edit-app]') || e.target;
  const d = t.dataset || {};
  if (d.tab) return goto(d.tab);

  // --- Today ---
  if (d.rec && d.id && d.act) {
    // `Open` is an anchor: let the new tab open, then record it. Everything else is a button.
    if (d.act === 'opened') { rec(d.rec, d.id, 'opened'); return; }
    e.preventDefault();
    return rec(d.rec, d.id, d.act, d.reason);
  }
  if (d.skipopen) { skipOpen.add(d.skipopen); return render(); }
  if (d.skipcancel) { skipOpen.delete(d.skipcancel); return render(); }
  if (d.addAgenda) { agendaOpen = !agendaOpen; return renderAgenda(); }
  if (d.agendaSave) {
    const body = { title: $('#agTitle').value.trim(), day: $('#agDay').value,
                   time: $('#agTime').value || null, kind: $('#agKind').value,
                   company: $('#agCompany').value.trim() || null };
    if (!body.title || !body.day) return toast('A title and a day are required.');
    const r = await post('/api/agenda', { add: body });
    if (r.error) return toast(r.error);
    agendaOpen = false; toast('Added to the agenda'); return load();
  }
  if (d.agendaDone) { await post('/api/agenda', { id: +d.agendaDone, done: d.undo !== '1' });
                      toast(d.undo === '1' ? 'Put back' : 'Done'); return load(); }
  if (d.agendaDel) { await post('/api/agenda', { id: +d.agendaDel, delete: true }); toast('Removed'); return load(); }
  if (d.followupDone) { await post('/api/agenda', { application_id: +d.followupDone, done: true });
                        toast('Follow-up cleared — the note is in the history'); return load(); }

  // --- Leads ---
  if (d.llane) { leadLane = d.llane; return renderLeads(); }
  if (d.lc) { leadChan = d.lc; return renderLeads(); }
  if (d.lmin != null) { leadMin = +d.lmin; return renderLeads(); }
  if (d.lver) { leadVerified = !leadVerified; return renderLeads(); }
  if (d.lgated) { leadGated = !leadGated; return renderLeads(); }
  if (d.lclaimed) { leadClaimed = !leadClaimed; return renderLeads(); }
  if (d.drawer) return drawerId === +d.drawer ? closeDrawer() : openDrawer(+d.drawer);
  if (d.drawerClose) return closeDrawer();

  // --- Applications ---
  if (d.sf) { stageFilter = d.sf; return renderApps(); }
  if (d.kpi) { stageFilter = d.kpi; chanFilter = 'all'; appQuery = ''; renderApps(); return goto('apps'); }
  if (d.cf) { chanFilter = d.cf; return renderApps(); }
  if (d.pf) { peopleFilter = d.pf; return renderPeople(); }
  if (d.detail) {
    if (detailOpen.has(d.detail)) { detailOpen.delete(d.detail); return renderApps(); }
    const [kind, id] = d.detail.split(':');
    const r = await (await fetch(`/api/row/${kind}/${id}`)).json();
    detailOpen.set(d.detail, r.fit_note || r.notes || null);
    return renderApps();
  }
  if (d.editApp) {
    const r = S.applications.rows.find(x => x.id === +d.editApp);
    editApp = { id: +d.editApp, next_action: r?.next_action || '', next_action_due: r?.next_action_due || '' };
    renderApps(); $('#edAction')?.focus(); return;
  }
  if (d.cancelApp) { editApp = null; return renderApps(); }
  if (d.saveApp) {
    await post(`/api/app/${d.saveApp}`, { next_action: $('#edAction').value.trim(),
                                          next_action_due: $('#edDue').value || null });
    editApp = null; toast('Next action saved'); return load();
  }
  if (d.focus) { await post(`/api/lead/${d.focus}`, { focus: d.on === '1' ? 0 : 1 }); return load(); }
  if (d.claim) {
    const on = d.on === '1';
    await post(`/api/lead/${d.claim}`, { claimed: on ? 0 : 1 });
    toast(on ? 'claim released' : 'marked — Claude has this one');
    return load();
  }
  if (d.lead) {
    // `promote` is the whole outbound path now: it creates the application row, backdates it to
    // today and marks the lead applied. Everything else about sending happens in a browser tab
    // that this dashboard does not drive.
    const body = d.act === 'promote' ? { promote: 1, status: 'applied' } : { status: 'dropped', reason: 'judged out from the board' };
    const r = await post(`/api/lead/${d.lead}`, body);
    if (r.error) toast(r.error);
    else toast(d.act === 'promote' ? `Marked applied: ${r.promoted}` : 'Dropped');
    return load();
  }

  // --- chrome ---
  if (d.tick) { await post('/api/roadmap', { id: d.tick, done: d.done !== '1' }); return load(); }
  if (t.id === 'readAll') { await post('/api/notif/read', {}); return load(); }
  if (t.id === 'huntBtn' || t.id === 'mailBtn') {
    const only = t.id === 'huntBtn' ? 'hunt' : 'mail';
    t.disabled = true; t.textContent = only === 'hunt' ? 'Hunting…' : 'Reading mail…';
    await fetch(`/api/sweep/run?only=${only}`, { method: 'POST' }).catch(() => {});
    toast(only === 'hunt' ? 'Hunt started — the board updates as it goes.' : 'Mail sweep started.');
  }
});

document.addEventListener('change', async e => {
  const d = e.target.dataset;
  if (d.app) { await post(`/api/app/${d.app}`, { status: e.target.value }); toast('Stage moved'); return load(); }
  if (d.contactStatus) { await post(`/api/contact/${d.contactStatus}`, { status: e.target.value });
                         toast('Contact moved'); return load(); }
});

document.addEventListener('input', e => {
  if (e.target.id === 'leadSearch') { leadQuery = e.target.value.trim(); renderLeads(); }
  if (e.target.id === 'appSearch') { appQuery = e.target.value.trim(); renderApps(); }
});

// A render deferred while you were typing runs the moment the field lets go.
document.addEventListener('focusout', () => { if (pending) setTimeout(() => { if (pending) render(); }, 0); });

// 1..6 switch tabs; `/` reaches the lead search from anywhere; Escape closes the drawer.
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && drawerId != null) return closeDrawer();
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  if (e.key >= '1' && e.key <= '6') return goto(TABS[+e.key - 1]);
  if (e.key === '/') { e.preventDefault(); goto('leads'); $('#leadSearch').focus(); }
});

// ---------- live ----------
function connect() {
  const es = new EventSource('/api/stream');
  es.onopen = () => $('#live').classList.remove('off');
  es.onmessage = () => load();
  es.addEventListener('change', () => load());
  es.onerror = () => { $('#live').classList.add('off'); };
}
// Back, forward, and a pasted #people link all have to land on the right tab. Without this the
// hash changes and nothing moves, which reads as a dead link.
window.addEventListener('hashchange', () => goto(location.hash.slice(1) || 'today'));
goto(location.hash.slice(1) || 'today');
load(); connect();
setInterval(load, 120000);   // belt and braces
