// ladder/dashboard/sweep/browser.mjs — a Chrome the sweep owns. Zero dependencies.
//
// Why this exists: SWEEP.md used to say the logged-in portals "cannot be automated" because a
// headless `claude -p` has no Chrome bridge. That is true of *Claude's* bridge and false of the
// conclusion. Chrome ships its own remote-control interface (the DevTools Protocol) and Node 24
// ships a WebSocket client, so the sweep can drive a real browser with no npm install and no
// dependency on being in an interactive session.
//
// The profile at sweep/chrome-profile is logged in to the portals once, by hand
// (`./ladder browser login`), and keeps those cookies for months. It is deliberately NOT your
// day-to-day profile: a sweep must never fight your browsing for control of a tab, and a portal
// that bumps one session must not sign you out of the other.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE = process.env.LADDER_CHROME_PROFILE || join(HERE, 'chrome-profile');
export const PORT = +(process.env.LADDER_CDP_PORT || 9222);

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].find(p => existsSync(p));

// Headless Chrome advertises "HeadlessChrome" in its UA, which some portals score as a bot.
// Overriding it costs nothing and removes a whole class of silent empty-result failures.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cdpUp(port = PORT, ms = 800) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * Get a browser to drive. Reuses one already listening on PORT — which is what makes
 * `browser login` (headful, left open) and a later sweep cooperate instead of collide:
 * a Chrome profile directory can only be held by one process at a time.
 */
export async function launch({ headless = true, quiet = true } = {}) {
  if (!CHROME) throw new Error('no Chrome found in /Applications');
  const already = await cdpUp();
  // Reuse only when the running instance can serve the request. A headful login flow that
  // silently attaches to a headless browser opens its tabs where nobody can see them — which is
  // exactly what happened on 2026-08-27: "Chrome is open with 3 login tabs" and no window.
  // Reuse only when the running instance matches the mode asked for. This is symmetric on
  // purpose: a headful login window must not be attached to by a scrape, or every sweep opens
  // tabs in your face while you are working. Cookies live in the profile, not the process, so
  // taking the window down costs nothing.
  const running = already ? await isHeadless() : null;
  if (already && running === headless) {
    return { port: PORT, reused: true, version: already.Browser, shutdown: async () => {} };
  }
  if (already) { stop(); await waitForPortFree(); }

  mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling',   // headless tabs otherwise stall mid-scrape
    '--disable-renderer-backgrounding',
    '--window-size=1440,900',
  ];
  if (headless) args.push('--headless=new');
  const child = spawn(CHROME, [...args, 'about:blank'],
    { detached: true, stdio: quiet ? 'ignore' : 'inherit' });
  child.unref();

  for (let i = 0; i < 30; i++) {
    const v = await cdpUp();
    if (v) return {
      port: PORT, reused: false, version: v.Browser, pid: child.pid,
      shutdown: async () => { try { process.kill(child.pid, 'SIGTERM'); } catch {} },
    };
    await sleep(500);
  }
  throw new Error('Chrome did not open a debugging port within 15s');
}

/** Is there a real, visible window? The inverse of isHeadless, exported for the login flow. */
export async function isVisible() { return !(await isHeadless()); }

/** Is the instance on PORT running headless? Its own user-agent is the giveaway. */
async function isHeadless() {
  const v = await cdpUp();
  return /headless/i.test(v?.['User-Agent'] || '');
}

/** pkill returns immediately; the port stays bound for a moment after. Wait for it to actually go. */
async function waitForPortFree(ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await cdpUp(PORT, 400))) return true;
    await sleep(300);
  }
  return false;
}

/** Is the browser still answering? A wedged Chrome accepts connections but never replies. */
export async function healthy(port = PORT) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch { return false; }
}

/** Is a ladder-owned Chrome currently listening? */
export async function status() {
  const v = await cdpUp();
  return { running: !!v, port: PORT, version: v?.Browser ?? null, profile: PROFILE,
           profileExists: existsSync(PROFILE) };
}

/** Stop whatever is on PORT — but only if it is ours, never a stray Chrome of yours. */
export function stop() {
  // No leading dashes in the pattern: pkill parses "--user-data-dir=..." as its own option and
  // silently matches nothing, so stop() reported success-by-omission and every "restart Chrome"
  // path quietly did nothing. Still profile-scoped, so it can never touch your own Chrome.
  const r = spawnSync('pkill', ['-f', `user-data-dir=${PROFILE}`], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * One tab, with the handful of CDP calls a scraper actually needs.
 * Every method throws on protocol error rather than returning undefined — a scrape that
 * silently yields nothing is indistinguishable from a portal with no jobs, and that
 * ambiguity is exactly what makes a sweep untrustworthy.
 */
export async function newPage(port = PORT) {
  // Bounded, always. An unbounded fetch here is what turned one wedged Naukri tab into a
  // four-hour stall on 2026-08-27: the navigate timeout fired correctly, but the *next*
  // /json/new never returned, so the pass hung with no error until launchd killed it.
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,
    { method: 'PUT', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`cdp /json/new returned ${res.status}`);
  const tab = await res.json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error('cdp socket failed')); });
  // Every native dialog this tab raises, in order, so a caller can report what it agreed to.
  const dialogs = [];
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    // Messages without an id are events. They used to be dropped wholesale, which made native
    // dialogs unhandleable: window.confirm freezes the renderer until it is answered, so every
    // subsequent CDP call on the tab hangs and the failure is indistinguishable from a dead
    // browser. YC raises one at submit time when the account is out of applications, which is why
    // a clicked Send once reported "portal still shows Apply" with no reason attached. (The
    // qualifications warning is *not* a dialog — it is inline text in the form, and harmless.)
    if (msg.id == null) {
      if (msg.method === 'Page.javascriptDialogOpening') {
        dialogs.push({ type: msg.params.type, message: msg.params.message });
        // Accept. The dialog is the portal asking whether to proceed with an application already
        // filled in and submitted on purpose, and leaving it unanswered wedges the tab. A
        // beforeunload gets the same answer, which is the right one for a page we are done with.
        ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;                                  // our own dialog-handling reply lands here
    pending.delete(msg.id);
    msg.error ? p.no(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : p.ok(msg.result);
  };
  const send = (method, params = {}, timeout = 30_000) => new Promise((ok, no) => {
    const m = ++id;
    pending.set(m, { ok, no, method });
    ws.send(JSON.stringify({ id: m, method, params }));
    setTimeout(() => { if (pending.delete(m)) no(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setUserAgentOverride', { userAgent: UA });

  const evaluate = async (expression, timeout = 30_000) => {
    const r = await send('Runtime.evaluate',
      { expression: `(() => { ${expression} })()`, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error('page js: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  return {
    id: tab.id,
    send,
    evaluate,
    dialogs,                       // native dialogs accepted on this tab, in order

    /** Navigate and wait for the document to settle (not just for the load event). */
    async goto(url, { settle = 2500, until = null, timeout = 45_000 } = {}) {
      await send('Page.navigate', { url }, timeout);
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await sleep(400);
        const ready = await evaluate('return document.readyState').catch(() => null);
        if (ready === 'complete') break;
      }
      await sleep(settle);
      if (until) {
        const deadline2 = Date.now() + 15_000;
        while (Date.now() < deadline2) {
          if (await evaluate(`return !!(${until})`).catch(() => false)) break;
          await sleep(500);
        }
      }
      return this.url();
    },
    url:   () => evaluate('return location.href'),
    title: () => evaluate('return document.title'),
    text:  () => evaluate('return document.body ? document.body.innerText : ""'),
    /**
     * A real mouse wheel, dispatched through the input pipeline rather than the DOM.
     *
     * `window.scrollBy` and `el.scrollTop = …` are synthetic: they move the viewport but never
     * produce a wheel event, and a virtualised feed that loads on wheel simply ignores them.
     * Measured on LinkedIn content search 2026-09-09 — the same query returned 3 results under
     * scrollBy and ran to the end-of-results marker under a real wheel. Any channel whose card
     * count is a small round number is suspect for exactly this reason.
     */
    async wheel({ x = 700, y = 450, dy = 900 } = {}) {
      await send('Input.dispatchMouseEvent',
        { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, pointerType: 'mouse' });
    },

    /**
     * Wheel until a counter stops growing. `count` is a JS expression returning a number —
     * usually the number of cards matched. Terminates on stability, not on a fixed iteration
     * count, so a long list is fully loaded and a short one costs three rounds.
     */
    async wheelUntilStable({ count, max = 80, pause = 800, stableRounds = 3,
                             budgetMs = 120_000, x = 700, y = 450, dy = 1200 } = {}) {
      // Deliberately NOT terminating on an "end of results" marker: LinkedIn renders its
      // "Are these results helpful?" footer below the list from the very first paint, so it is
      // true while three cards are showing and 90 are still unloaded. Tested 2026-09-09 — it
      // stopped every query at round 0. A count that stops moving is the only honest signal.
      const read = () => evaluate(`return (${count})`).catch(() => -1);
      const t0 = Date.now(), deadline = t0 + budgetMs;
      let prev = await read(), stable = 0, rounds = 0, n = prev, why = 'max';
      for (; rounds < max; rounds++) {
        if (Date.now() > deadline) { why = 'budget'; break; }
        await this.wheel({ x, y, dy });
        await sleep(pause);
        n = await read();
        if (n === prev) { if (++stable >= stableRounds) { why = 'stable'; break; } } else stable = 0;
        prev = n;
      }
      return { n, rounds, why, ms: Date.now() - t0 };
    },

    /**
     * Trigger lazy-loading lists. YC WaaS in particular only fetches the next page on a real
     * scroll event — window.scrollTo alone does nothing, which is why this steps and waits.
     */
    async scroll(times = 6, pause = 900) {
      for (let i = 0; i < times; i++) {
        // document.body is null until the page paints; unguarded this throws and takes the whole
        // channel down as "scrape failed" when the only problem was arriving a moment early.
        const ok = await evaluate('if (!document.body) return 0; window.scrollBy(0, document.body.scrollHeight); return 1')
          .catch(() => 0);
        if (!ok) await sleep(1000);
        await sleep(pause);
      }
      return evaluate('return document.body ? document.body.innerText.length : 0').catch(() => 0);
    },
    async close() {
      try { await fetch(`http://127.0.0.1:${port}/json/close/${tab.id}`, { signal: AbortSignal.timeout(8000) }); }
      catch {}
      ws.close();
    },
  };
}
