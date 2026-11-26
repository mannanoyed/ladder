#!/usr/bin/env node --no-warnings
// launchd entrypoint for the morning sweep.
//
// Why node and not bash: a LaunchAgent that execs /bin/bash cannot read ~/Documents under macOS
// TCC — it dies with "Operation not permitted" before the script's first line. The node binary
// already has that access (the dashboard server job proves it), so node is the entrypoint and
// everything else is spawned from here.
//
// AUTH: runs on your claude.ai login, never an ANTHROPIC_API_KEY. Two reasons:
//   1. an API key (a work one, say) should not be billed for a personal job search
//   2. with any API key set, Claude Code disables the claude.ai connectors — no Gmail, no sweep
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const LOGS = join(DIR, 'sweep', 'logs');
mkdirSync(LOGS, { recursive: true });

const now = new Date();
// local time, not UTC — a 15:05 IST run filed as "0935" is unreadable
const p2 = n => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
const log = createWriteStream(join(LOGS, `${stamp}.log`), { flags: 'a' });
const say = m => { log.write(m + '\n'); console.log(m); };
const MODE = process.argv[2] || '--scheduled';
// The hunt (portals → new jobs) and the mail sweep (Gmail → replies and status changes) are two
// jobs sharing one process. `--hunt` and `--mail` run one of them; anything else runs both, so
// the 08:00 schedule and a plain manual run are unchanged.
const ONLY = MODE === '--hunt' ? 'hunt' : MODE === '--mail' ? 'mail' : null;
const doHunt = ONLY !== 'mail';
const doMail = ONLY !== 'hunt';

// strip every auth override so Claude Code falls back to the personal claude.ai login
const ENV = { ...process.env };
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
                 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete ENV[k];
ENV.PATH = [process.env.HOME + '/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
            ENV.PATH || ''].join(':');

const cli = (...a) => spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), ...a],
                                { cwd: DIR, encoding: 'utf8' });
const notify = (level, title, body) => cli('notify', '--level', level, '--title', title, '--body', body);

say(`=== ladder sweep ${stamp} (${MODE}) ===`);

// --- portals first ---------------------------------------------------------
// This runs before the Gmail guard on purpose. Scraping goes through Chrome's own DevTools
// Protocol (sweep/browser.mjs) and needs no Claude session at all, so a broken connector must
// not cost us the portal pass too. Deterministic code, no model in the loop, ~2 minutes.
let portals = { status: 0 };
if (doHunt) {
say('--- portals ---');
// --all, not the default. Without it `portals` falls back to OPEN_PORTALS — the four that need
// no login — so Wellfound, YC WaaS and LinkedIn were excluded from every scheduled run by
// construction, and logging into them bought nothing. A lapsed session now reports as a failed
// channel and goes red, which is the whole point of tracking freshness.
portals = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'portals', '--all'],
  // 45 min, not 15. All 12 portals with auth is a much bigger pass than the 4 open ones this
  // budget was set for; the scheduled run was hitting the cap and reporting a partial sweep as
  // a failed one. Raised 2026-09-03.
  { cwd: DIR, encoding: 'utf8', timeout: 45 * 60_000 });
for (const line of ((portals.stderr || '') + '\n' + (portals.stdout || '')).split('\n'))
  if (line.trim()) say(line.trimEnd());
if (portals.status !== 0)
  notify('info', 'Portal sweep did not finish cleanly',
    `Lead discovery may be short today. See dashboard/sweep/logs/${stamp}.log`);

// --- linkedin: its own pass, four surfaces ---------------------------------
// Not part of the portal sweep: LinkedIn is jobs + collections + posts + messages, writes to
// two tables, and its posts surface throttles after ~6 queries.
say('--- linkedin ---');
const li = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'linkedin',
  '--only', 'collections,search'],
  // 40 min, not 20. Since 2026-11-02 the pass reads 10 collections (50 pages) and 17 AI-search
  // queries (up to 3 pages each), with a pause between loads: ~100 page loads, not ~24.
  { cwd: DIR, encoding: 'utf8', timeout: 40 * 60_000 });
for (const line of ((li.stderr || '') + '\n' + (li.stdout || '')).split('\n'))
  if (line.trim()) say(line.trimEnd());
if (li.status !== 0)
  notify('info', 'LinkedIn pass did not finish cleanly',
    `Collections/messages may be stale. See dashboard/sweep/logs/${stamp}.log`);

// --- expire: clear leads too old to convert -------------------------------
// A probability test, not a liveness one. By the time a req is a week old the recruiter has
// worked through a stack of applicants, so a late application converts badly whether or not the
// posting is still up. Ages from posted_at when the card gave one, discovered_at otherwise.
// Warm routes (referral/direct/inbound) and your focus picks are exempt — those do not decay.
// Runs BEFORE reconcile so the board it reconciles is already the live one.
const exp = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'expire'],
  { cwd: DIR, encoding: 'utf8', timeout: 60_000 });
say('--- expire ---');
say((exp.stdout || exp.stderr || '(no output)').trim());

// --- clean: the second half of "load wide, clean after" --------------------
// The scrapers keep everything that is not certainly junk; this puts each new lead in one of your
// four lanes (FDE, AI workflows, AI generalist, ML), drops off-lane rows WITH the reason on the
// row, and folds one req seen on several channels into one. Before reconcile and enrichment, so
// the JD reads are spent on in-lane leads only. `ladder clean undo` reverses any rule.
const cln = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'clean'],
  { cwd: DIR, encoding: 'utf8', timeout: 2 * 60_000 });
say('--- clean ---');
say((cln.stdout || cln.stderr || '(no output)').trim());
if (cln.status !== 0)
  notify('info', 'Clean failed', `Off-lane leads may be on the board. See logs/${stamp}.log`);

// --- reconcile: deterministic, and deliberately NOT inside the Gmail pass ---
//
// This was step 5 of SWEEP.md, which means it only ever ran if the model-driven mail pass got
// that far. It hadn't, for days: on 2026-08-28 a single manual run marked 94 leads as already
// applied and took the open-lead board from 512 to 418. A third of the "new" leads on the board
// were roles you had already applied to, and the duplicate-application problem it exists to
// prevent had been compounding the whole time.
//
// Nothing here needs a model or a network: it matches leads against the application log, drops
// companies already validated as dead, rescores, and backfills bands. It runs on the portal
// pass's output, so it belongs here — after discovery, before anything that can abort.
const rec = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'reconcile'],
  { cwd: DIR, encoding: 'utf8', timeout: 3 * 60_000 });
say('--- reconcile ---');
say((rec.stdout || rec.stderr || '(no output)').trim());
if (rec.status !== 0)
  notify('info', 'Reconcile failed', `Duplicate leads may be on the board. See logs/${stamp}.log`);

// --- sort: a JD, a date and a price on every row (sweep/sort.mjs) ---
// Plain HTTP, no browser: LinkedIn's public job pages, LinkedIn twins for Indeed and Glassdoor
// rows, AmbitionBox for the company's engineers. Before enrich, so the browser pass is left only
// what plain HTTP cannot reach. Its own budget inside (kv sort_budget_min, 20 min), a hard cap here.
say('--- sort ---');
const srt = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'sort'],
  { cwd: DIR, encoding: 'utf8', timeout: 30 * 60_000 });   // budget 20 min + the last requests
for (const line of ((srt.stderr || '') + '\n' + (srt.stdout || '')).split('\n'))
  if (line.trim()) say(line.trimEnd());
if (srt.status !== 0)
  notify('info', 'Sort did not finish', `Some rows are still ranked on guesses. See logs/${stamp}.log`);

// --- enrich: read the JD and the company page for the best unread leads ---
// After reconcile so it scores the board as it stands; before the YC check so a slow page cannot
// hold up the deterministic tail. Bounded by its own budgets inside, and by a hard timeout here.
// It may fail; the hunt may not.
say('--- enrich ---');
const enr = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'enrich'],
  { cwd: DIR, encoding: 'utf8', timeout: 22 * 60_000 });   // leads 14 min + companies
for (const line of ((enr.stderr || '') + '\n' + (enr.stdout || '')).split('\n'))
  if (line.trim()) say(line.trimEnd());
if (enr.status !== 0)
  notify('info', 'Enrichment did not finish', `JD and company reads may be short today. See logs/${stamp}.log`);
}
if (!doHunt) say('--- portals + reconcile skipped (mail-only run) ---');

// YC's cap is invisible until you walk into it, so check every morning whether a slot has come
// back. Deterministic, offline, and it belongs on the hunt side rather than behind the mail guard.
const yc = cli('yc', 'check');
say('--- yc allowance ---');
say((yc.stdout || yc.stderr || '(no output)').trim());

if (!doMail) { say(`=== hunt-only run complete ===`); process.exit(portals.status === 0 ? 0 : 1); }


// --- linkedin messages: part of the MAIL half, not the hunt -----------------
// "Run hunt" finds leads; "Run mail sweep" finds replies. A reply that arrives as a LinkedIn DM
// is a reply, so it belongs here — it used to run inside the hunt, which meant clicking
// "Run mail sweep" to check for an answer silently skipped an entire inbound channel. That is
// how a warm referral sat unanswered for eight days.
say('--- linkedin messages ---');
const lim = spawnSync(process.execPath, ['--no-warnings', join(DIR, 'cli.mjs'), 'linkedin', '--only', 'messages'],
  { cwd: DIR, encoding: 'utf8', timeout: 5 * 60_000 });
for (const line of ((lim.stderr || '') + '\n' + (lim.stdout || '')).split('\n'))
  if (line.trim()) say(line.trimEnd());
if (lim.status !== 0)
  notify('info', 'LinkedIn message sweep failed', 'Inbound DMs may be unread. See the log.');

// --- guard: refuse to run blind ---
//
// Retried, because a single reading is not evidence. On 2026-08-28 this printed "No MCP servers
// configured" once, at 08:09, and aborted the entire mail pass; the identical probe run by hand
// and again under a launchd job with this exact env returned all three connectors Connected. One
// transient answer — a token refresh, a concurrent `claude`, an auto-update swapping the binary
// mid-read — should cost a retry, not the day's mail. Three tries over ~40s, and the binary that
// answered is logged so a version skew shows up in the log instead of being guessed at later.
let out = '', connected = false;
for (let attempt = 1; attempt <= 3 && !connected; attempt++) {
  if (attempt > 1) {
    say(`Gmail connector probe attempt ${attempt - 1} said no — retrying in 20s`);
    spawnSync('sleep', ['20']);
  }
  const probe = spawnSync('claude', ['mcp', 'list'], { env: ENV, encoding: 'utf8', timeout: 90_000 });
  out = (probe.stdout || '') + (probe.stderr || '');
  if (probe.error) out += `\n[spawn error: ${probe.error.message}]`;
  if (probe.signal) out += `\n[killed by ${probe.signal} — probe exceeded its 90s timeout]`;
  connected = /claude\.ai Gmail.*Connected/i.test(out);
}
if (!connected) {
  // The hunt and the mail sweep are two jobs that happen to share a process. Discovery and
  // reconcile have already finished by this point, so saying "nothing was swept" — as this did on
  // 2026-08-28 — reports a total loss when in fact only the mail half failed. Name what ran.
  const huntNote = portals.status === 0
    ? 'The hunt already finished: new leads were found and reconciled, and they are on the board.'
    : 'The hunt did not finish cleanly either — check the portal lines above.';
  say(`ABORT (mail only): the claude.ai Gmail connector did not answer on three attempts. ${huntNote}`);
  say(out.slice(0, 800));
  notify('urgent', 'Mail sweep skipped — Gmail connector unavailable',
    `No mail was checked, so replies and status changes are not up to date. ${huntNote} `
    + 'Check that Claude Code is logged in to claude.ai and that no ANTHROPIC_API_KEY is overriding it.');
  process.exit(1);
}
const which = spawnSync('command', ['-v', 'claude'], { env: ENV, encoding: 'utf8', shell: true });
const ver = spawnSync('claude', ['--version'], { env: ENV, encoding: 'utf8', timeout: 60_000 });
say(`auth ok: personal claude.ai login, Gmail connector live `
  + `(${(which.stdout || '?').trim()} — ${(ver.stdout || '?').trim()})`);

// Your own copy (SWEEP.local.md, gitignored) wins over the shipped generic prompt.
const SWEEP_DOC = existsSync(join(DIR, 'sweep', 'SWEEP.local.md')) ? 'SWEEP.local.md' : 'SWEEP.md';
const PROMPT = `Run the ladder morning sweep. Follow ${DIR}/sweep/${SWEEP_DOC} exactly, start to finish.
Working directory is ${DIR}. Today is ${now.toISOString().slice(0, 10)}. Mode: ${MODE}.
You are unattended — do not ask questions. Finish by calling 'sweep finish'.`;

const child = spawn('claude', ['-p', PROMPT, '--model', 'opus', '--permission-mode', 'acceptEdits', '--allowedTools',
  'Bash(node:*)', 'Bash(cat:*)', 'Bash(date:*)', 'Read', 'Write', 'Glob', 'Grep',
  'mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread',
  'mcp__claude_ai_Gmail__get_message', 'mcp__claude_ai_Gmail__send_message',
], { cwd: DIR, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });   // no stdin — it is unattended

child.stdout.on('data', d => say(String(d).trimEnd()));
child.stderr.on('data', d => say(String(d).trimEnd()));

// 35 min, not 20. The mail half alone can lose ten minutes to a single hung Gmail connector call
// (16 Sep: one get_thread sat for ~9 minutes before a retry succeeded), and the agent still has
// the hunt's leads to judge after it. At 20 the wrapper was SIGKILLing a sweep that had already
// done its work — see the completion check below.
let killed = false;
const kill = setTimeout(() => {
  killed = true;
  say('TIMEOUT after 35 min — killing');
  child.kill('SIGKILL');
}, 35 * 60_000);

// Did the agent actually finish? `sweep finish` stamps finished_at on the row this run opened, so
// that column — not the exit code — is the honest test. A SIGKILL lands as exit null, and for two
// mornings running that raised a red "Sweep failed" over a sweep that had written its brief,
// closed its row and simply not exited before the wall clock. A false urgent alert is worse than
// no alert: it is the one that teaches you to stop reading them.
const finishedCleanly = () => {
  const r = cli('sweep', 'list', '--limit', '1');
  try { return !!JSON.parse(r.stdout)[0]?.finished_at; } catch { return false; }
};

child.on('close', code => {
  clearTimeout(kill);
  say(`=== exit ${code} ===`);
  if (code !== 0 && killed && finishedCleanly())
    notify('info', 'Sweep ran over its 35-minute budget',
      `The agent finished its work and closed the sweep row, then the wrapper killed it on the wall `
      + `clock. Nothing was lost. If this repeats, the budget is too tight rather than the sweep `
      + `broken. See dashboard/sweep/logs/${stamp}.log`);
  else if (code !== 0)
    notify('urgent', `Sweep failed (exit ${code})`, `See dashboard/sweep/logs/${stamp}.log`);
  // keep 30 days of logs
  const cut = Date.now() - 30 * 864e5;
  for (const f of readdirSync(LOGS)) {
    const p = join(LOGS, f);
    if (f.endsWith('.log') && !f.startsWith('server') && !f.startsWith('launchd')
        && statSync(p).mtimeMs < cut) { try { unlinkSync(p); } catch {} }
  }
  process.exit(code ?? 1);
});
