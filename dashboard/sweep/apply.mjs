// ladder/dashboard/sweep/apply.mjs — the send path.
//
// Discovery was the easy half. This half puts words in writing under your name, so it is built
// defensively: every draft is checked against the claims your profile marks as failing
// verification before it can leave, and the portals that ban accounts for automated submission
// are never auto-submitted on. A ban on Naukri or LinkedIn mid-search costs more than any number
// of applications gains.
import { all, one, run } from '../db.mjs';
import { PROFILE } from '../profile.mjs';

// ---------------------------------------------------------------------------
// Hard blocklist: claims that failed verification (profile.forbiddenClaims). Encoding them here
// means no future application can repeat one, whatever a draft template says.
// ---------------------------------------------------------------------------
export const FORBIDDEN = PROFILE.forbiddenClaims || [];

/** Returns the violations in a piece of outgoing text. Empty array means it is safe to send. */
export function screen(text) {
  return FORBIDDEN.filter(f => f.re.test(String(text || ''))).map(f => f.why);
}

// ---------------------------------------------------------------------------
// Style gate. The fact screen stops a draft claiming something untrue; this stops it sounding like
// everyone else's.
// ---------------------------------------------------------------------------
export const BANNED_STYLE = [
  { re: /\bpassionate\b/i,               why: '"passionate" — banned in the voice doc' },
  { re: /\bexcited to\b/i,               why: '"excited to" — banned' },
  { re: /I'?d love the opportunity/i,     why: 'banned filler' },
  { re: /\bresonates?\b/i,               why: '"resonates" — banned' },
  { re: /\bdeeply\b/i,                   why: '"deeply" — banned' },
  { re: /^Hi[ ,—-]+I'?m applying for/i,   why: 'generic opener that could start any application' },
  { re: /happy to walk through/i,         why: 'assistant filler' },
  { re: /\bleverage\b|\bsynerg/i,        why: 'consultant-speak' },
  // The em dash used as sentence punctuation is the single most recognisable LLM tell in
  // outbound text, so it is banned outright rather than left to judgement. An en dash spaced as
  // punctuation goes with it. This deliberately does NOT touch ordinary compound hyphens
  // (pre-sales, four-day, forward-deployed): those are correct English. Ranges written with an
  // unspaced en dash (₹35L–₹40L) are also left alone; rewrite those as "to" inside prose.
  { re: /\u2014/,                        why: 'em dash (—) — the clearest AI tell in outbound text; recast the sentence or use a comma, full stop, or brackets' },
  { re: /\s\u2013\s/,                    why: 'spaced en dash (–) used as punctuation — same tell as the em dash' },
  // Never volunteer a weakness. The years figure belongs in its own field and nowhere in prose.
  // These are phrasings that drafts have actually produced.
  { re: /where I'?m short|I'?m not that\.|I don'?t know your domain/i, why: 'volunteers a gap' },
  { re: /\bunder your \S+ ?(year|yr)|below (your|the) \S+ ?(year|yr)/i,    why: 'names the years bar you are under' },
  { re: /judge (the|my) work rather than/i,              why: 'asks to be excused a gap' },
  { re: /\bI'?m (only )?(one|two|three|four|\d+(\.\d+)?) years?( \w+ months?)? in\b/i, why: 'volunteers tenure in prose; years go in their field only' },
];
export function screenStyle(text) {
  return BANNED_STYLE.filter(b => b.re.test(String(text || ''))).map(b => b.why);
}

// ---------------------------------------------------------------------------
// The intro note. Its material is yours, so it lives in the profile (profile.letter): a set of
// blocks, each a hook, a body and a push, tagged with the role vocabulary it answers.
// ---------------------------------------------------------------------------
const IDENTITY = PROFILE.identity || {};
const LETTER = PROFILE.letter || { blocks: {} };
const BLOCKS = LETTER.blocks || {};

/**
 * Compose the note.
 *
 * Lopsided by construction: one block carries the note, a second gets a sentence at most. Opens
 * on a position rather than an introduction. It never closes by naming a gap: the style gate
 * blocks those phrasings, so the line cannot come back.
 */
export function draft(lead) {
  const hay = `${lead.role || ''} ${lead.fit_note || ''} ${lead.notes || ''}`;
  // Count *occurrences*, not truthiness. Without the global flag String.match returns a single
  // match object, so every block that matched at all scored 1 and the tie broke on object order.
  const hits = re => (hay.match(new RegExp(re.source, 'gi')) || []).length;
  const ranked = Object.entries(BLOCKS)
    .map(([k, b]) => [k, b, hits(b.tags)])
    .sort((a, b) => b[2] - a[2]);
  if (!ranked.length) return { body: '', violations: [], style: [], projects: [] };
  const [, lead_block] = ranked[0];
  const second = ranked[1] && ranked[1][2] > 0 ? ranked[1][1] : null;

  // Where the current-work block isn't already carrying the note, one line on it: current work
  // says more about trajectory than any past project does.
  const now = LETTER.current && ranked[0][0] !== LETTER.current.block ? LETTER.current.line : null;

  const parts = [
    lead_block.hook(lead.role || 'This role'),
    lead_block.body,
    lead_block.push,
    second ? second.body : null,
    now,
    LETTER.disposition || null,
    LETTER.closing ? LETTER.closing(IDENTITY) : null,
  ].filter(Boolean);

  const body = parts.join('\n\n');
  return { body, violations: screen(body), style: screenStyle(body),
           projects: [ranked[0][0], second ? ranked[1][0] : null].filter(Boolean) };
}


// ---------------------------------------------------------------------------
// Custom application questions.
//
// YC dialogs often carry a required question beyond the intro note, and Send stays disabled until
// it is answered — which is why the first batch failed on every company that asks one. Answers are
// drawn from the same verified material as the drafts. Anything unrecognised is NOT guessed at:
// the application is left queued and flagged, because a wrong answer to "are you authorised to
// work in the US" is far more damaging than an application not sent.
// ---------------------------------------------------------------------------
// Global answers. `null` here means "never auto-answer this generically" — it does NOT mean the
// question is unanswerable. A per-application answer in `applications.answers` overrides any of
// these (see answerFor), and writing a real, company-specific answer is the intended way to clear
// a `needs-you` on "why this company". Refusing generically and answering specifically are the
// same policy, not two.
//
// Before writing that answer, open the listing and check four things — the cached band lies:
//   1. Is it actually paid?  ("equity only for now" while the board showed a cash band)
//   2. Does it hire in India? (plenty are US/Canada only)
//   3. Is the gate in range?  (a 9+ year bar hides behind a junior-sounding title)
//   4. Is the listing live?
// In one batch ten of eleven queued Wellfound rows failed one of these.
export const ANSWERS = [
  // The refusals come first so no personal answer can pre-empt them on a mixed question.
  { re: /why (are you |do you )?(interested|want|applying)|why (this|our) (company|role|team)/i,
    a: null },        // company-specific — needs you, never auto-answered
  { re: /authoriz|visa|sponsor|work permit|eligible to work/i,
    a: null },        // legally consequential — never auto-answered
  { re: /salary|compensation|expected ctc|current ctc/i,
    a: null },        // your decision, always
  // Your own answers (profile.answers): "most impressive thing", notice period, and so on.
  ...(PROFILE.answers || []),
  // Contact fields the portals ask for outright. They come from profile.identity, so they are
  // filled rather than escalated — but LinkedIn must be matched BEFORE the /link/ rule below, which otherwise
  // answers "LinkedIn Profile*" with a GitHub URL.
  { re: /linkedin/i,
    a: IDENTITY.linkedin ?? null },
  { re: /^phone|phone ?number|mobile ?number|contact ?number/i,
    a: IDENTITY.phone ?? null },
  { re: /github|portfolio|link/i,
    a: IDENTITY.github ?? null },
];

/**
 * Best answer for a question, or null when it must not be auto-answered.
 *
 * `extra` is the per-application answer map (applications.answers) and is consulted FIRST, so a
 * company-specific answer beats the global refusal. That is the whole point: "why this company"
 * is refused globally because no generic answer to it is honest, not because the question is
 * unanswerable — given a real answer written for that employer, it should go.
 */
export function answerFor(question, extra = null) {
  if (extra) {
    const q = String(question || '').toLowerCase();
    for (const [key, val] of Object.entries(extra))
      // '' is a deliberate "leave this optional box empty", not a missing answer.
      if (val != null && q.includes(String(key).toLowerCase())) return val;
  }
  const hit = ANSWERS.find(x => x.re.test(question));
  return hit ? hit.a : undefined;      // undefined = unrecognised, null = deliberately refused
}

// ---------------------------------------------------------------------------
// Per-portal behaviour.
//
//   automated — your own logged-in profile, one application at a time, at human pace. Normal use
//               of the product, just driven from here.
//   assisted  — Naukri and LinkedIn ban accounts for automated submission. We prepare and open;
//               the final click is your. This is a hard line, not a setting.
//   external  — the listing is a redirect into someone else's ATS. We resolve the destination
//               and hand it over rather than pretend we can fill an unknown form.
// ---------------------------------------------------------------------------
export const APPLY_MODE = {
  wellfound:   'automated',
  'yc-waas':   'automated',
  instahyre:   'assisted',
  // foundit's apply needs a logged-in session and its own flow; never auto-submit there.
  foundit:     'assisted',
  hirist:      'assisted',
  naukri:      'assisted',     // ToS: bulk/automated apply is a ban risk
  linkedin:    'assisted',     // same
  indeed:      'external',
  glassdoor:   'external',
  hn:          'external',
};

/** Has this lead already been applied to? Identity mirrors the applications unique index. */
export function alreadyApplied(lead) {
  return !!one(`SELECT id FROM applications WHERE archived=0
                AND company=? AND role=?`, lead.company, lead.role);
}

/**
 * Build the queue. Writes application rows at status 'queued' carrying their draft, so the
 * board shows exactly what would go out before anything does.
 */
export function queue({ minScore = 62, floor = 25, limit = 100, channels = null } = {}) {
  const rows = all(`SELECT * FROM leads
                    WHERE status IN ('new','shortlisted')
                      AND score >= ? AND COALESCE(band_max_lpa, band_min_lpa, 0) >= ?
                      AND url LIKE 'http%'
                    ORDER BY score DESC LIMIT ?`, minScore, floor, limit * 3);

  const out = { queued: [], skipped_applied: 0, skipped_channel: 0, blocked: [] };
  for (const l of rows) {
    if (out.queued.length >= limit) break;
    if (channels && !channels.includes(l.channel)) { out.skipped_channel++; continue; }
    if (alreadyApplied(l)) { out.skipped_applied++; continue; }

    const q = queueOne(l);
    if (q.error === 'blocked') { out.blocked.push({ company: l.company, role: l.role, why: q.why }); continue; }
    if (q.error) continue;
    out.queued.push(q);
  }
  return out;
}

/**
 * Queue exactly one lead — the body of the loop above, pulled out so the dashboard's "Queue it"
 * button writes an identical row to the batch path. It used to have no route into the queue at
 * all: the only UI action on a lead was "mark applied", which records an application that was
 * never sent and stores the 180-character card blurb where the draft belongs.
 */
export function queueOne(lead, { body = null } = {}) {
  // A hand-written body replaces the template outright. Without this, a lead whose real answer had
  // already been written still had to pass through draft(), and a template defect (an em dash in
  // the template) blocked the send of text that never contained it. Same two gates either way.
  const d = body != null
    ? { body: String(body), violations: screen(body), style: screenStyle(body) }
    : draft(lead);
  if (d.violations.length) return { error: 'blocked', why: d.violations };
  // The style gate blocks too, not just reports. Until 2026-09-25 it was advisory, so when the
  // em-dash rule was added on 09-23 every draft the templates produced violated it and every one
  // of them was still queueable. A rule the send path does not enforce is a note in a file.
  if (d.style.length) return { error: 'blocked', why: d.style };

  // Look at archived rows too. `idx_app_identity` is UNIQUE over (company, role, channel,
  // external_id) and does not care about the archived flag, so an archived row still owns the
  // slot: INSERT OR IGNORE silently does nothing and the old code reported "already queued" for
  // something that was not in the queue and could not be put there. That is what happened to
  // a lead after the queue was archived back to Leads.
  const existing = one(`SELECT id, status, archived FROM applications WHERE company=? AND role=?`,
                       lead.company, lead.role);

  if (existing && !existing.archived) {
    // Say which of the two it is. "already applied" on a row merely sitting in the queue reads as
    // a failure and sends you looking for an application that was never sent.
    // A lead never goes to `queued` — that status is retired (2026-09-12). A draft is a
    // shortlisted lead with an application row waiting; a sent one is applied.
    run("UPDATE leads SET status=? WHERE id=?", existing.status === 'queued' ? 'shortlisted' : 'applied', lead.id);
    return { error: existing.status === 'queued'
      ? 'already in the queue — look on the Queue tab'
      : `already applied (status: ${existing.status})` };
  }

  if (existing) {                                   // archived — bring it back rather than refuse
    run(`UPDATE applications SET archived=0, status='queued', notes=?, fit_score=?,
         send_check=NULL, send_check_at=NULL, updated_at=datetime('now') WHERE id=?`,
        d.body, lead.score, existing.id);
    run("UPDATE leads SET status='shortlisted' WHERE id=?", lead.id);
    return { id: existing.id, company: lead.company, role: lead.role, restored: true,
             channel: lead.channel, mode: APPLY_MODE[lead.channel] || 'external', score: lead.score };
  }

  const r = run(`INSERT INTO applications
      (company, role, location, channel, url, external_id, band_raw, band_min_lpa, band_max_lpa,
       gate_years, status, fit_score, notes, band_basis)
     VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
    lead.company, lead.role, lead.location, lead.channel, lead.url, lead.external_id, lead.band_raw,
    lead.band_min_lpa, lead.band_max_lpa, lead.gate_years, lead.score, d.body, lead.band_basis);
  run("UPDATE leads SET status='shortlisted' WHERE id=?", lead.id);
  return { id: Number(r.lastInsertRowid), company: lead.company, role: lead.role,
           channel: lead.channel, mode: APPLY_MODE[lead.channel] || 'external', score: lead.score };
}

/** Can this channel be sent from the dashboard at all? The UI asks before offering a button. */
export const canSend = channel => Object.prototype.hasOwnProperty.call(ADAPTERS, channel);

// ---------------------------------------------------------------------------
// Submission adapters.
// ---------------------------------------------------------------------------

/** Type into a React-controlled field so the framework registers the value, not just the DOM. */
const TYPE_INTO = `(el, text) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
  set.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}`;

/**
 * YC WaaS: Apply opens a dialog with a single note field and a Send button.
 * Every step is verified before the next: no apply control, no note field, or no Send button all
 * abort rather than guess, because a half-driven form is how you submit an empty application.
 */
// The one honest signal YC gives: the Apply control becomes a non-interactive "Applied" label.
// Body-text phrases like "application sent" never appear, and dialog-absence proves nothing —
// a dialog closes on failure too, which is how the first send reported success it hadn't earned.
const YC_APPLIED = `[...document.querySelectorAll('button,a')].some(x => (x.innerText||'').trim() === 'Applied')`;

async function applyYC(page, app, note, { dryRun = false } = {}) {
  const dirty = screen(note).concat(screenStyle(note));
  if (dirty.length) return { ok: false, needsHuman: true, note: `draft blocked: ${dirty.join('; ')}` };
  await page.goto(app.url, { settle: 8000 });
  if (await page.evaluate(`return ${YC_APPLIED}`))
    return { ok: true, already: true, note: 'already applied on the portal' };

  const opened = await page.evaluate(`
    const b = [...document.querySelectorAll('button,a')].find(x => (x.innerText||'').trim() === 'Apply');
    if (!b) return false; b.click(); return true;`);
  if (!opened) return { ok: false, note: 'no Apply control on the page' };
  await new Promise(r => setTimeout(r, 4000));

  // Read the dialog's shape before typing: the intro note is the first field, and anything after
  // it is a company question that gates Send.
  const shape = await page.evaluate(`
    const d = document.querySelector('[role=dialog]');
    if (!d) return null;
    const tas = [...d.querySelectorAll('textarea')];
    const txt = d.innerText;
    const qs = (txt.match(/[^\\n]{12,220}\\?[^\\n]{0,40}|[^\\n]*\\*\\s*$/gm) || [])
      .map(x => x.trim()).filter(x => x.length > 12);
    return { count: tas.length, questions: qs.slice(0, 4), dialogText: txt.slice(0, 600) };`);
  if (!shape) return { ok: false, note: 'apply dialog did not open' };

  const answers = [];
  if (shape.count > 1) {
    // Match each extra field to a question in the dialog text.
    for (let i = 1; i < shape.count; i++) {
      const q = shape.questions[i - 1] || shape.dialogText;
      const a = answerFor(q);
      if (a === undefined) return { ok: false, needsHuman: true, question: q.slice(0, 160),
                                    note: `unrecognised question — left for you: "${q.slice(0, 90)}"` };
      if (a === null) return { ok: false, needsHuman: true, question: q.slice(0, 160),
                               note: `question must be answered by you: "${q.slice(0, 90)}"` };
      const why = screen(a).concat(screenStyle(a));
      if (why.length) return { ok: false, needsHuman: true, question: q.slice(0, 160),
                               note: `answer blocked: ${why.join('; ')}` };
      answers.push(a);
    }
  }

  // Type through the browser's own input pipeline. A synthetic value-set does not always register
  // with the framework, and a field the framework thinks is empty keeps Send disabled.
  const fields = [note, ...answers];
  for (let i = 0; i < fields.length; i++) {
    // Select any existing content first: insertText replaces a selection but appends at a bare
    // caret, so a dialog that reopens holding a saved draft would send the note twice over.
    const focused = await page.evaluate(`
      const tas = [...document.querySelectorAll('[role=dialog] textarea')];
      if (!tas[${i}]) return false;
      tas[${i}].focus();
      if (tas[${i}].setSelectionRange) tas[${i}].setSelectionRange(0, (tas[${i}].value || '').length);
      return true;`);
    if (!focused) return { ok: false, note: `field ${i + 1} missing` };
    await page.send('Input.insertText', { text: fields[i] });
    await new Promise(r => setTimeout(r, 800));
  }
  const filled = await page.evaluate(`
    return [...document.querySelectorAll('[role=dialog] textarea')].map(t => t.value.length).join(',')`);

  const noteLen = await page.evaluate(`
    const t = document.querySelector('[role=dialog] textarea');
    return t ? (t.value || '').length : -1;`);
  if (noteLen !== String(note).length)
    return { ok: false, note: `note did not land cleanly — ${noteLen} chars in the box, ${String(note).length} drafted` };

  // Same stop as Wellfound: fill the dialog exactly as a real send would, then hand back what is
  // in it without clicking Send.
  if (dryRun) return { ok: false, dryRun: true, chars: filled,
    note: `dry run — dialog filled, not submitted (${shape.count} field(s))` };

  await new Promise(r => setTimeout(r, 1500));
  const sent = await page.evaluate(`
    const b = [...document.querySelectorAll('[role=dialog] button')].find(x => /^send$/i.test((x.innerText||'').trim()));
    if (!b) return 'missing';
    if (b.disabled) return 'disabled';
    b.click(); return 'clicked';`);
  if (sent !== 'clicked') return { ok: false, note: `Send ${sent} (fields: ${filled})` };
  await new Promise(r => setTimeout(r, 6000));

  // Reload and re-read rather than trusting the post-click DOM: the only acceptable proof is the
  // portal itself saying Applied.
  await page.goto(app.url, { settle: 6000 });
  const confirmed = await page.evaluate(`return ${YC_APPLIED}`);
  // Say what was agreed to on your behalf. YC raises a native confirm on a req whose years bar you
  // are under, and accepting it silently would mean the record shows a clean send while the portal
  // asked a question nobody told you about.
  const asked = (page.dialogs || []).map(d => d.message).filter(Boolean);

  // A quota wall is not a defect and not something to retry into. A YC application is a *message
  // to the team* ("Reach out to <name> at <company>"), and the account gets a limited number of them.
  // The cap is announced only in a native dialog at submit time, which used to freeze the tab and
  // surface as "portal still shows Apply" — a portal limit wearing a code bug's clothes.
  const quota = asked.find(m => /limit of applications|reached your limit|application limit/i.test(m));
  if (quota && !confirmed)
    return { ok: false, quota: true, needsHuman: true, chars: filled, dialogs: asked,
             note: `YC says: "${quota}" Nothing was sent. The draft is intact; this one waits for the cap to reset.` };

  const suffix = asked.length ? ` (accepted: "${asked.join('" / "').slice(0, 160)}")` : '';
  return { ok: confirmed, chars: filled, dialogs: asked,
           note: (confirmed ? 'sent — portal shows Applied' : 'clicked Send but portal still shows Apply') + suffix };
}

// ---------------------------------------------------------------------------
// Wellfound.
//
// Apply opens an in-page form: a note, plus whatever question set the company attached. There is
// no fixed field list — one company asks nothing, the next asks phone + US work authorisation +
// LinkedIn, a third gates on a location qualification radio. So the form is read through the
// submit button it belongs to and every field is routed through answerFor(); a field we cannot
// answer stops the send instead of submitting a form with a blank required box.
// ---------------------------------------------------------------------------
const WF_SUBMIT = '[data-test="JobApplicationModal--SubmitButton"]';

// Where you actually live (profile.homeCity). Your Wellfound *profile* location may differ, and
// this widget asks where you are, not what your profile says. Answer it truthfully; the profile is
// a search filter, this is a statement to an employer.
const HOME_CITY = PROFILE.homeCity || '';

/**
 * "This job does not support the locations on your profile."
 *
 * Wellfound renders the whole form anyway and disables every field until you answer a two-part
 * qualification: a radio ("I am currently in…" / "I can relocate to…") and a react-select city.
 * Until 2026-09-25 the adapter saw only the disabled textarea and reported the listing as closed,
 * which is how a role in your own city was refused as out of reach.
 *
 * `living_in` with your real city is tried first. Relocation is a promise, so it is only offered
 * when staying put cannot clear the gate, and the result says which one was used.
 */
async function resolveLocation(page, jobCity) {
  const present = await page.evaluate(
    `return !!document.querySelector('[name="qualification.location.action"]')`);
  if (!present) return { needed: false };

  const attempt = async (action, city) => {
    const ok = await page.evaluate(`
      const r = document.getElementById('form-input--qualification.location.action--${action}');
      if (!r) return false; r.click(); return true;`);
    if (!ok) return null;
    await new Promise(r => setTimeout(r, 1400));
    const focused = await page.evaluate(`
      const el = document.getElementById('react-select-form-input--qualification.location.locationId-input');
      if (!el) return false; el.focus(); return document.activeElement === el;`);
    if (!focused) return null;
    // insertText appends at the caret, so a second attempt would search "DelhiPalo Alto".
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await page.send('Input.insertText', { text: city });
    await new Promise(r => setTimeout(r, 3000));
    // react-select commits on mousedown, not click, so a bare .click() picks nothing.
    const chose = await page.evaluate(`
      const o = document.querySelector('[id^="react-select-form-input--qualification.location.locationId-option"]');
      if (!o) return null;
      const t = (o.innerText || '').trim();
      for (const type of ['mousedown', 'mouseup', 'click'])
        o.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      return t;`);
    if (!chose) return null;
    await new Promise(r => setTimeout(r, 2500));
    const live = await page.evaluate(`
      const sub = document.querySelector('${WF_SUBMIT}');
      return !!sub && !sub.disabled;`);
    return live ? { action, city: chose } : null;
  };

  let r = HOME_CITY ? await attempt('living_in', HOME_CITY) : null;
  if (!r && jobCity && !(HOME_CITY && new RegExp(HOME_CITY, 'i').test(jobCity))) r = await attempt('relocate_to', jobCity);
  if (!r) return { needed: true, ok: false };
  return { needed: true, ok: true, ...r };
}

/** The city out of a Wellfound location blurb: "In office \u2022 Delhi 2 years of exp 2 days ago Save". */
const cityOf = loc => {
  const m = String(loc || '').match(/(?:In office|Hybrid|Remote)?\s*\u2022?\s*([A-Za-z][A-Za-z .-]+?)\s*(?:\d|$)/);
  return m ? m[1].trim() : '';
};
const WF_APPS   = 'https://wellfound.com/jobs/applications';

const WF_READ_FORM = `
  const sub = document.querySelector('${WF_SUBMIT}');
  if (!sub) return null;
  const form = sub.closest('form');
  if (!form) return null;
  const labelFor = el => {
    if (el.labels && el.labels[0]) return el.labels[0].innerText.trim();
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.innerText.trim(); }
    // Only the Yes/No radios carry a real <label for>. "Phone*" and "LinkedIn Profile*" are plain
    // siblings, so without this walk they read as an empty question and every send that had one
    // stopped as "unrecognised question" with nothing to show the user.
    let n = el.parentElement;
    for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
      const t = (n.innerText || '').trim();
      if (t && t.length < 250) return t;
    }
    return '';
  };
  const els = [...form.querySelectorAll('input, textarea, select')]
    // name="" is react-select's own search box, not a question. qualification.* is the location
    // widget, which resolveLocation below has already answered; both read as an empty question
    // and abort the send as "unrecognised" if they reach the planner.
    .filter(x => x.type !== 'hidden' && x.name !== 'search' && x.name &&
                 !x.name.startsWith('qualification.'));
  const out = [], seen = new Set();
  for (const el of els) {
    if (el.name === 'userNote') { out.push({ kind: 'note', name: el.name, question: 'note' }); continue; }
    if (el.type === 'radio') {
      if (seen.has(el.name)) continue;
      seen.add(el.name);
      const options = els.filter(x => x.name === el.name)
                         .map(x => ({ value: x.value, label: labelFor(x) }));
      // The question is the enclosing text with the option labels subtracted out.
      let q = '', n = el.parentElement;
      for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
        let t = (n.innerText || '').trim();
        for (const o of options) if (o.label) t = t.split(o.label).join(' ');
        t = t.replace(/\\s+/g, ' ').trim();
        if (t.length > 8 && t.length < 300) { q = t; break; }
      }
      out.push({ kind: 'radio', name: el.name, question: q, options });
      continue;
    }
    out.push({ kind: 'text', name: el.name, question: labelFor(el) });
  }
  return out;`;

/** Company as it appears in a list: DB rows carry "SciSpace (Typeset)", the portal says "SciSpace". */
const needle = c => String(c || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();

async function applyWellfound(page, app, note, { dryRun = false } = {}) {
  const dirty = screen(note).concat(screenStyle(note));
  if (dirty.length) return { ok: false, needsHuman: true, note: `draft blocked: ${dirty.join('; ')}` };
  // Answers written for this specific employer, if any. Parsed once, defensively: a malformed
  // blob must fall back to the global rules rather than throw mid-application.
  let appAnswers = null;
  try { appAnswers = app.answers ? JSON.parse(app.answers) : null; } catch { appAnswers = null; }
  await page.goto(app.url, { settle: 7000 });
  if (await page.evaluate(`return /you applied|application sent|applied on/i.test(document.body.innerText)`))
    return { ok: true, already: true, note: 'already applied on the portal' };

  const opened = await page.evaluate(`
    const b = [...document.querySelectorAll('button, a[role="button"]')]
      .find(x => /^apply( now)?$/i.test((x.innerText||'').trim()));
    if (!b) return false;
    b.click(); return true;`);
  if (!opened) return { ok: false, note: 'no Apply control on the page' };

  // The form mounts asynchronously; poll rather than sleep a guessed interval.
  let fields = null;
  for (let i = 0; i < 8 && !fields; i++) {
    await new Promise(r => setTimeout(r, 1500));
    fields = await page.evaluate(WF_READ_FORM);
  }
  if (!fields) return { ok: false, note: 'apply form did not open' };

  // Answer the location qualification before anything else: it holds every other field disabled.
  const loc = await resolveLocation(page, cityOf(app.location));
  if (loc.needed && !loc.ok)
    return { ok: false, needsHuman: true,
      note: `location gate: neither "currently in ${HOME_CITY}" nor "relocate to ${cityOf(app.location) || 'the job city'}" cleared it` };
  if (loc.needed) fields = await page.evaluate(WF_READ_FORM);   // the form re-renders once it clears

  // A form with nothing in it at all is a bare confirm dialog: Send submits the profile alone,
  // with nothing written. Brave's three reqs are like that. The note is the entire reason this
  // pipeline exists, so a shot that cannot carry one is handed back rather than spent.
  if (!fields.length)
    return { ok: false, needsHuman: true,
      note: 'bare confirm dialog — Send would submit your profile with nothing written. Apply by hand if you want it.' };

  // Missing a note box is NOT the same as a bare dialog, and conflating the two hid a dozen live
  // listings behind "sends your profile alone". Plenty of companies drop the cover letter and ask
  // their own questions instead — "What interests you about working for this company?" is where
  // the note would have gone. Those still go through the question routing below; they simply
  // carry no draft, which the caller is told about rather than left to infer.
  const hasNote = fields.some(f => f.kind === 'note');

  // Some companies gate on location and say so inside the form while still rendering the whole
  // thing — Doma's textarea is present but dead, so the fill silently wrote nothing. Read the
  // refusal off the page and repeat it, rather than reporting a typing failure we did not have.
  const gate = await page.evaluate(`
    const sub = document.querySelector('${WF_SUBMIT}');
    const form = sub && sub.closest('form');
    // Every writable field, not just userNote. A company that asks its own questions instead of
    // a cover letter has no userNote at all, so the old check passed a fully disabled form.
    const els = form ? [...form.querySelectorAll('input, textarea, select')]
      .filter(x => x.type !== 'hidden' && x.type !== 'radio' && x.name !== 'search') : [];
    const dead = els.length > 0 && els.some(x => x.disabled || x.readOnly);
    const txt = form ? form.innerText : '';
    const m = txt.match(/[^\\n]*not accepting applications[^\\n]*/i)
           || txt.match(/[^\\n]*(does not offer visa sponsorship|indicates you require sponsorship)[^\\n]*/i);
    return { dead, reason: m ? m[0].trim() : null };`);
  if (gate.reason || gate.dead)
    return { ok: false, needsHuman: true,
      note: gate.reason || 'a required field in this form is disabled — the listing is not taking the application' };

  // Decide every field before touching any of them. A form half-filled and then abandoned is
  // worse than one never started: Wellfound keeps the draft and it looks like a withdrawn send.
  const plan = [];
  for (const f of fields) {
    if (f.kind === 'note') { plan.push({ ...f, value: note }); continue; }
    const q = f.question || '';
    const a = answerFor(q, appAnswers);
    if (a === undefined) return { ok: false, needsHuman: true, question: q.slice(0, 160),
      note: `unrecognised question — left for you: "${q.slice(0, 90)}"` };
    if (a === null) return { ok: false, needsHuman: true, question: q.slice(0, 160),
      note: `question must be answered by you: "${q.slice(0, 90)}"` };
    if (a === '' && f.kind === 'text') continue;
    if (f.kind === 'radio') {
      const opt = f.options.find(o => o.label && new RegExp(`^${o.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(a));
      if (!opt) return { ok: false, needsHuman: true, question: q.slice(0, 160),
        note: `no option matches "${a}" for: "${q.slice(0, 70)}"` };
      plan.push({ ...f, value: opt.value });
      continue;
    }
    plan.push({ ...f, value: a });
  }

  // Screen every value about to be typed, not only the note. Custom-question answers carry the
  // whole application on forms with no cover-letter box, and until 2026-10-17 they went in
  // unchecked: the gates only saw them when the same text happened to be passed as the note.
  const dirtyAnswer = plan.filter(f => f.kind !== 'radio')
    .map(f => ({ f, why: screen(f.value).concat(screenStyle(f.value)) })).find(x => x.why.length);
  if (dirtyAnswer) return { ok: false, needsHuman: true, question: (dirtyAnswer.f.question || '').slice(0, 160),
    note: `answer blocked (${dirtyAnswer.f.question || dirtyAnswer.f.name}): ${dirtyAnswer.why.join('; ')}` };

  // Type through the browser's own input pipeline — a synthetic value-set does not always
  // register with the framework, and a field it thinks is empty fails validation on submit.
  for (const f of plan) {
    const sel = `[name="${f.name}"]`;
    if (f.kind === 'radio') {
      const clicked = await page.evaluate(`
        const r = document.querySelector('[name="${f.name}"][value="${f.value}"]');
        if (!r) return false;
        r.click(); return true;`);
      if (!clicked) return { ok: false, note: `radio ${f.name} not settable` };
    } else {
      // Select what is already there before typing. Wellfound keeps a draft of the note between
      // visits, and Input.insertText replaces a *selection* but appends at a bare caret — which
      // is how the first dry run filled the box with the draft twice, 3948 chars of it.
      const focused = await page.evaluate(`
        const el = document.querySelector('${sel}');
        if (!el) return 'missing';
        if (el.disabled || el.readOnly) return 'dead';
        el.focus();
        if (document.activeElement !== el) return 'unfocusable';
        if (el.setSelectionRange) el.setSelectionRange(0, (el.value || '').length);
        return 'ok';`);
      if (focused !== 'ok') return { ok: false, needsHuman: focused !== 'missing',
        note: `field ${f.name} is ${focused} — nothing typed (${f.question || f.kind})` };
      await page.send('Input.insertText', { text: String(f.value) });
      // Read back from the field we meant, not from the form. On 2026-09-23 a disabled custom
      // question let focus stay where it was and 899 characters of cover letter went into
      // Wellfound's global search box, with the form still reporting a plausible fill.
      const landed = await page.evaluate(`
        const el = document.querySelector('${sel}');
        return el ? (el.value || '').length : -1;`);
      if (landed !== String(f.value).length)
        return { ok: false, needsHuman: true,
          note: `${f.name} did not take the text — ${landed} chars in it, ${String(f.value).length} sent. Aborted before submit.` };
    }
    await new Promise(r => setTimeout(r, 700));
  }

  // The note is the whole point of the send, so verify it landed character-for-character rather
  // than trusting that typing worked. A duplicated or truncated note is not worth a shot.
  if (hasNote) {
    const noteLen = await page.evaluate(`
      const el = document.querySelector('[name="userNote"]');
      return el ? (el.value || '').length : -1;`);
    if (noteLen !== String(note).length)
      return { ok: false, note: `note did not land cleanly — ${noteLen} chars in the box, ${String(note).length} drafted` };
  }

  const filled = await page.evaluate(`
    const sub = document.querySelector('${WF_SUBMIT}');
    const form = sub && sub.closest('form');
    if (!form) return 'form gone';
    return [...form.querySelectorAll('input,textarea')]
      .filter(x => x.type !== 'hidden' && x.name !== 'search')
      .map(x => x.type === 'radio' ? (x.checked ? x.value : '') : String((x.value||'').length))
      .filter(Boolean).join(',');`);

  // A dry run stops here, with the form filled exactly as a real send would leave it. This is how
  // a new question set gets proven safe before anything is submitted under your name.
  if (dryRun) return { ok: false, dryRun: true, chars: filled, noNote: !hasNote,
    note: `dry run — form filled, not submitted${hasNote ? '' : ' [NO COVER-LETTER BOX — the draft has nowhere to go]'}`
        + ` (${plan.map(f => f.question || f.kind).join(' | ').slice(0, 160)})` };

  await new Promise(r => setTimeout(r, 1200));
  const sent = await page.evaluate(`
    const b = document.querySelector('${WF_SUBMIT}');
    if (!b) return 'missing';
    if (b.disabled) return 'disabled';
    b.click(); return 'clicked';`);
  if (sent !== 'clicked') return { ok: false, note: `Send ${sent} (fields: ${filled})` };
  await new Promise(r => setTimeout(r, 7000));

  // Proof comes from Wellfound's own applications list, never from the modal closing — it closes
  // on a rejected submit too, which is exactly how the first YC send reported success it had not
  // earned. Not listed means not sent, and the row stays queued.
  // Match the company AND the role on adjacent lines. Company alone is not proof: with three
  // reqs at one company queued, so once the first landed the second and third would have verified
  // against the first one's row and reported a success they had not earned.
  await page.goto(WF_APPS, { settle: 6000 });
  const listed = await page.evaluate(`
    // Exact match on either spelling. The portal sometimes shows the bracketed part and sometimes
    // doesn't: "SciSpace (Typeset)" lists as "SciSpace", but "Artha Labs (part of Attention Tag)"
    // lists in full, and stripping alone reported such a send as failed. Never a substring
    // match: the role must still sit on the next line, which is what keeps three reqs at one company apart.
    const want = ${JSON.stringify([...new Set([String(app.company || '').replace(/\s+/g, ' ').trim(), needle(app.company)])])};
    const role = ${JSON.stringify(String(app.role || '').trim())};
    const lines = document.body.innerText.split('\\n').map(x => x.trim());
    return lines.some((l, i) => want.includes(l) && (lines[i + 1] || '') === role);`);
  return { ok: listed, chars: filled,
           note: listed ? 'sent — listed on Wellfound applications, matched by company and role'
                        : 'clicked Send but the company/role pair is not on the applications list' };
}

export const ADAPTERS = { 'yc-waas': applyYC, yc: applyYC, wellfound: applyWellfound };
