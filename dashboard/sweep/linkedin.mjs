// ladder/dashboard/sweep/linkedin.mjs — LinkedIn as four surfaces, not one.
//
// The old approach was seven /jobs/search/ URLs scraping whatever cards happened to render.
// It produced 112 leads, 2 above the floor, 12 sends and 0 humans. Three reasons, all measured
// on 2026-09-09:
//
//   1. Job search serves ADS first. `fde in India` claims 6,252 results; 13 of the first 14
//      cards are `Promoted` and none contain "FDE". Relevance order is ad order.
//   2. The list lazy-loads on a REAL wheel event. window.scrollBy does nothing, so a cold read
//      returns ~3-9 cards and looks like the whole supply. Measured: 9 -> 9 under scrollBy,
//      9 -> 106 under page.wheelUntilStable().
//   3. Premium already ranks jobs for you (top-applicant, hiring-in-network) and we never asked.
//
// Everything here reads. Nothing connects, messages, or applies — that line is deliberate:
// the account is what the referral route depends on and it cannot be re-bought.
import { PROFILE } from './browser.mjs';
import { PROFILE as ME } from '../profile.mjs';

/* ------------------------------------------------------------------ card extraction ----- */

// Two card shapes, one reader.
//
// Collections anchor on the /jobs/view/<id> routing contract, never on a class. LinkedIn serves
// hashed, build-generated class names under a server-driven UI — there is no semantic class left.
//
// AI search (/jobs/search-results/, which every /jobs/search/ URL redirects to since classic
// search was retired — measured 2026-11-02) has NO /jobs/view/ link on its cards; only the
// selected job carries one, which is why the old reader returned exactly 1 card per query. The
// id lives in the card's own key: componentkey="job-card-component-ref-<jobId>".
const CARD_JS = `
  const out = [], seen = new Set();
  // "(Verified job)" is appended to the first title line, and that card then repeats the title
  // bare on the next line. Reading the second line as the company is how "Applied AI Engineer"
  // became the employer of "Applied AI Engineer".
  const strip = s => (s || '').replace(/\\s*\\(Verified job\\)\\s*$/i, '').replace(/\\s+/g, ' ').trim();
  const cards = [];
  for (const el of document.querySelectorAll('[componentkey^="job-card-component-ref-"][role=button]')) {
    const id = el.getAttribute('componentkey').slice('job-card-component-ref-'.length);
    const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    if (!/^\\d+$/.test(id) || !lines.length) continue;
    const role = strip(lines[0]);
    const i = lines[1] && strip(lines[1]) === role ? 2 : 1;
    cards.push({ id, el, role, company: lines[i], location: lines[i + 1], url: 'https://www.linkedin.com/jobs/view/' + id + '/' });
  }
  for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
    const m = a.href.match(/\\/jobs\\/view\\/(\\d+)/);
    if (!m) continue;
    const li = a.closest('li') || a.parentElement?.parentElement;
    if (!li) continue;
    const lines = (li.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const role = strip(a.textContent) || strip(lines[0]) || null;
    // Company/location sit directly under the title in document order on every collection view.
    // Reading them positionally survives redesigns that reshuffle class names.
    const ri = lines.findIndex(l => l && role && strip(l).startsWith(role.slice(0, 24)));
    const rest = lines.slice(ri + 1).filter(l => strip(l) !== role);
    cards.push({ id: m[1], el: li, role, company: rest[0], location: rest[1], url: a.href.split('?')[0] });
  }
  for (const c of cards) {
    if (seen.has(c.id)) continue;
    const t = (c.el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    seen.add(c.id);
    out.push({
      external_id: c.id,
      url: c.url,
      role: c.role || null,
      company: c.company || null,
      location: c.location || null,
      // "Promoted" is plain text on the card. It is a paid placement, NOT a fake job: dropping
      // it threw away 40 of 44 in-lane jobs on "Top job picks" (2026-11-02). It is kept and
      // flagged, and the scorer takes its -10 from the fit note.
      promoted: /(^|\\s)Promoted(\\s|$)/.test(t),
      verified: /\\(Verified job\\)/i.test(t),
      top_applicant: /be a top applicant/i.test(t),
      early: /Be an early applicant/i.test(t),
      easy_apply: /Easy Apply/i.test(t),
      viewed: /(^|\\s)Viewed(\\s|$)/.test(t),
      // The referral signal, sitting in plain sight and thrown away until now.
      // Singular and plural both occur — "1 school alum works here" / "4 school alumni work
      // here" — and matching only the plural silently zeroed the referral signal on every card
      // that had exactly one.
      alumni: (t.match(/(\\d+)\\s+school alum(?:ni)?\\s+works?\\s+here/i) || [])[1] || null,
      connections: (t.match(/(\\d+)\\s+connections?\\s+works?\\s+here/i) || [])[1] || null,
      // Hirer responsiveness. "Actively reviewing applicants" is a live employer; a stated
      // review time is a process that exists at all.
      actively_reviewing: /Actively reviewing applicants/i.test(t),
      review_time: (t.match(/review time is typically ([^\\n·]{1,24})/i) || [])[1] || null,
      posted: (t.match(/(\\d+\\s+(?:minute|hour|day|week|month)s?\\s+ago)/i) || [])[1] || null,
      // Two shapes on this surface. LinkedIn's own India band carries no currency symbol at
      // all ("1M INR/yr - 2M INR/yr" = Rs10L-20L); parseBand needs the symbol, so normalise.
      band_raw: (() => {
        const inr = t.match(/([\\d.]+)\\s*M\\s*INR\\/yr\\s*(?:-|–|to)\\s*([\\d.]+)\\s*M\\s*INR\\/yr/i);
        if (inr) return '₹' + inr[1] + 'M - ₹' + inr[2] + 'M';
        return (t.match(/[₹$][\\d.,]+\\s*[KLM]?\\s*(?:-|–|to)\\s*[₹$]?\\s*[\\d.,]+\\s*[KLM]?(?:\\/yr|\\/hr)?/i) || [])[0] || null;
      })(),
      text: t.slice(0, 700),
    });
  }
  return out;
`;


/** Distinguish "nothing matched" from "we could not look" — never let them render the same. */
const PAGE_STATE = `
  const t = document.body ? document.body.innerText : '';
  return JSON.stringify({
    empty:    /No results found|No matching jobs|didn'?t match/i.test(t),
    authWall: /^\\s*(Sign in|Join now)/i.test(t.slice(0, 200)) || /Sign in to continue/i.test(t),
    throttle: /unusual activity|try again later|temporarily restricted|too many requests/i.test(t),
    len: t.length,
  });
`;

async function loadAndRead(page, url, { settle = 4500, max = 30, budgetMs = 45_000 } = {}) {
  await page.goto(url, { settle });
  const state = JSON.parse(await page.evaluate(PAGE_STATE));
  if (state.authWall) throw new Error('not logged in');
  if (state.throttle) throw new Error('throttled by LinkedIn — back off');
  if (state.empty) return { cards: [], scroll: { n: 0, rounds: 0, why: 'no-results' }, state };
  // x=400, not the default 700. Job views are two panes: the list scrolls in a container at
  // roughly x=149..652 and the job detail occupies x=653..1277. Wheeling at 700 scrolled the
  // DETAIL pane, so every collection stopped at its first 7 cards and reported "stable".
  //
  // Small steps, harvested as we go. Cards render only once they intersect the viewport, and a
  // 1200px wheel jumps clean past some of them: every collection page read 19-20 of its 25
  // (2026-11-02). At 500px all 25 render by the fourth step. Reading after every step and
  // merging by id also survives a list that un-renders what has scrolled away.
  const byId = new Map(), t0 = Date.now();
  const take = async () => {
    let fresh = 0;
    for (const c of await page.evaluate(CARD_JS)) if (!byId.has(c.external_id)) { byId.set(c.external_id, c); fresh++; }
    return fresh;
  };
  await take();
  let rounds = 0, stable = 0, why = 'max';
  for (; byId.size < max; rounds++) {
    if (rounds >= 40 || Date.now() - t0 > budgetMs) { why = 'budget'; break; }
    await page.wheel({ x: 400, dy: 500 });
    await new Promise(r => setTimeout(r, 700));
    if (await take()) stable = 0;
    else if (++stable >= 3) { why = 'stable'; break; }
  }
  return { cards: [...byId.values()], scroll: { n: byId.size, rounds, why, ms: Date.now() - t0 }, state };
}

// A person reading job lists pauses between pages. So does this: the account is the asset, and
// the pass now makes ~4x the page loads it did.
const pace = () => new Promise(r => setTimeout(r, 1500 + Math.random() * 2500));

/* ------------------------------------------------------------------ surface 1: collections */

// Premium already ranked these against your profile. No keywords, no guessing, and they carry
// the responsiveness and alumni signals that job search buries.
//
// Depth is per collection, set from sizes measured 2026-11-02: top-applicant 116 results,
// top-choice 27, recommended ("Top job picks for you") 660. The last six were never read at all
// and returned 19-24 in-lane jobs new to the board from their first two pages each. They exist
// only as URLs: the Jobs home links none of them. `top-companies` is "top US companies" and is
// left out; `still-hiring`, `few-applicants` and `hiring-now` do not exist.
export const COLLECTIONS = [
  { key: 'top-applicant',     pages: 5,  label: "jobs where you'd be a top applicant" },
  { key: 'hiring-in-network', pages: 4,  label: 'jobs people in your network are hiring for' },
  { key: 'recommended',       pages: 15, label: 'top job picks for you' },
  { key: 'top-choice',        pages: 2,  label: 'top choice eligible' },
  { key: 'easy-apply',        pages: 4,  label: 'Easy Apply jobs' },
  { key: 'remote-jobs',       pages: 4,  label: 'remote jobs' },
  { key: 'hybrid',            pages: 4,  label: 'hybrid jobs' },
  { key: 'small-business',    pages: 4,  label: 'small businesses' },
  { key: 'career-growth',     pages: 4,  label: 'career growth & learning' },
  { key: 'work-life-balance', pages: 4,  label: 'work life balance' },
];

export async function scrapeCollections(newPage, { only = null, pages = null, log = () => {} } = {}) {
  const want = only?.length ? COLLECTIONS.filter(c => only.includes(c.key)) : COLLECTIONS;
  const leads = [], report = [];
  for (const c of want) {
    let scanned = 0, promoted = 0, err = null;
    const seen = new Set();
    // Collections paginate 25 at a time behind ?start=N — verified 2026-09-09: start=0/25/50
    // return disjoint id sets. The wheel loads one page; `start` walks them.
    for (let p = 0; p < (pages ?? c.pages); p++) {
      const page = await newPage();
      try {
        const { cards } = await loadAndRead(page,
          `https://www.linkedin.com/jobs/collections/${c.key}/?start=${p * 25}`, { max: 25, budgetMs: 35_000 });
        // A page that repeats the previous one means we have run past the end; stop rather than
        // spend the remaining budget re-reading the same rows.
        const fresh = cards.filter(x => !seen.has(x.external_id));
        if (!fresh.length) break;
        for (const x of fresh) {
          seen.add(x.external_id);
          if (x.promoted) promoted++;
          leads.push({ ...x, channel: 'linkedin', source: `collection:${c.key}` });
        }
        scanned += fresh.length;
      } catch (e) { err = e.message; break; }
      finally { await page.close(); }
      await pace();
    }
    report.push({ surface: c.key, ok: !err, scanned, promoted, kept: scanned, note: err });
    log(`  ${c.key.padEnd(18)} ${err ? '✗ ' + err + ` (after ${scanned})` : `${scanned} read, ${promoted} of them promoted`}`);
    if (err && /throttled/.test(err)) break;          // stop the surface, not just the collection
  }
  return { leads, report };
}

/* ------------------------------------------------------------------ surface 2: job search  */

// AI-powered search. Classic /jobs/search/ now redirects here and its old filters (f_E, sortBy)
// are gone: "Some filters may no longer be available, but you can type them into search". It
// paginates behind &start=N in disjoint pages of 25 (measured 2026-11-02, 0 overlap between
// start=0/25/50), and India is the default from your profile. 5 test queries x 4 pages returned
// 77-89 in-lane jobs per 100, 68-78 of them new to the board.
//
// Grouped by the four lanes you target. No experience filter: the scraper loads wide and the
// JD gate check judges the bar, which is a fact on the page rather than LinkedIn's coarse level.
export const SEARCH_LANES = {
  fde:        ['forward deployed engineer', 'forward deployment engineer', 'solutions engineer AI',
               'customer engineer AI', 'AI deployment engineer'],
  workflows:  ['AI automation engineer', 'agentic AI engineer', 'AI agent developer', 'LLM workflow engineer'],
  generalist: ['AI engineer', 'applied AI engineer', 'generative AI engineer', 'founding engineer AI',
               'AI product engineer'],
  ml:         ['machine learning engineer', 'LLM engineer', 'MLOps engineer'],
};
export const SEARCHES = Object.entries(SEARCH_LANES).flatMap(([lane, qs]) => qs.map(k => ({ lane, k })));

// A daily run reads the last 3 days, 3 pages deep: wide enough to survive one missed hunt.
// A backfill reads the week, 4 deep. f_TPR takes any window in seconds.
const WINDOWS = { day: 86_400, '3d': 259_200, week: 604_800 };

export async function scrapeSearch(newPage, { window = '3d', pages = 3, queries = null, log = () => {} } = {}) {
  const leads = [], report = [];
  const tpr = WINDOWS[window] || +window || WINDOWS['3d'];
  const list = queries?.length ? queries.map(k => ({ lane: 'adhoc', k })) : SEARCHES;
  for (const s of list) {
    const seen = new Set();
    let promoted = 0, err = null, read = 0;
    for (let p = 0; p < pages; p++) {
      const page = await newPage();
      try {
        const url = 'https://www.linkedin.com/jobs/search-results/?keywords=' + encodeURIComponent(s.k)
          + `&f_TPR=r${tpr}` + (p ? `&start=${p * 25}` : '');
        const { cards } = await loadAndRead(page, url, { max: 25, budgetMs: 30_000 });
        const fresh = cards.filter(x => !seen.has(x.external_id));
        if (!fresh.length) break;
        for (const x of fresh) {
          seen.add(x.external_id);
          if (x.promoted) promoted++;
          leads.push({ ...x, channel: 'linkedin', source: `search:${s.k}` });
        }
        read += fresh.length;
        if (fresh.length < 20) break;                   // a short page is the last page
      } catch (e) { err = e.message; break; }
      finally { await page.close(); }
      await pace();
    }
    report.push({ surface: s.k, lane: s.lane, ok: !err, scanned: read, promoted, kept: read, note: err });
    log(`  ${(s.lane + ' · ' + s.k).padEnd(40)} ${err ? '✗ ' + err + ` (after ${read})` : `${read} read`}`);
    if (err && /throttled|not logged in/.test(err)) break;
  }
  return { leads, report };
}

/* ------------------------------------------------------------------ surface 3: posts ----- */

// The channel that was invisible. A recruiter's "I'm hiring an FDE in Bangalore" post has no job
// URL — it has a person — so it had nowhere to land in `leads` and was dropped by construction.
// These rows go to `contacts`.
//
// Query design is the product here. Vary the vocabulary deliberately: practitioners and in-house
// recruiters type the acronym, bodyshops broadcast the full phrase, and the two return almost
// disjoint sets. Every query must carry an India anchor — unanchored FDE queries come back
// dominated by US C2C staffing spam (W2/1099/H1B).
export const POST_QUERIES = [
  'hiring "forward deployed engineer" India', 'fde hiring bangalore', 'fde hiring india',
  'hiring "solutions engineer" AI India', 'hiring "applied AI engineer" India',
  'hiring "AI engineer" India', 'hiring "AI engineer" Bangalore',
  'hiring "agentic AI" engineer India', 'hiring "LLM engineer" India',
  'hiring "AI agents" engineer Bengaluru', '#ForwardDeployedEngineer India',
  'hiring "deployment engineer" AI India', 'hiring "customer engineer" AI India',
  'hiring "founding engineer" AI India', '"forward deployed" hiring Bengaluru',
  'hiring "machine learning engineer" Bangalore startup',
];

const POST_JS = `
  const out = [], seen = new Set();
  for (const c of document.querySelectorAll('[componentkey$="FeedType_FLAGSHIP_SEARCH"]')) {
    const k = (c.getAttribute('componentkey')||'').replace(/^expanded/,'').replace(/FeedType_FLAGSHIP_SEARCH$/,'');
    // Comment sub-containers reuse the parent's key with this infix; without the guard every
    // post is counted twice and the empty one wins.
    if (!k || k.includes('replaceableCommentTools') || seen.has(k)) continue;
    const t = (c.innerText||'').replace(/\\s+/g,' ').trim();
    if (!t) continue;
    seen.add(k);
    const a = c.querySelector('a[href*="/in/"]');
    // Parse the FLATTENED text, not the line array. The actor block renders as
    //   Feed post / Name / • 2nd / Headline... / 5d •
    // with the degree on its own line, so line-based matching returned the bare "• 2nd" and
    // every one of 161 contacts landed with name '(unknown)' and headline '• 2nd'.
    const who = t.match(/^Feed post\\s+(.{1,70}?)\\s+•\\s*(1st|2nd|3rd\\+?)\\s+(.*?)\\s+\\d+\\s*(?:m|h|d|w|mo)\\b/);
    // Company pages post without a degree: "Feed post Forward Deployed Engineer Jobs 23h • Follow"
    const page = who ? null : t.match(/^Feed post\\s+(.{1,70}?)\\s+\\d+\\s*(?:m|h|d|w|mo)\\b/);
    out.push({
      post_id: k,
      profile_url: a ? a.href.split('?')[0] : null,
      name: who ? who[1].trim() : (page ? page[1].trim() : null),
      degree: who ? who[2] : null,
      headline: who ? who[3].slice(0, 220).trim() : null,
      india: /india|bangalore|bengaluru|hyderabad|gurugram|gurgaon|noida|pune|mumbai|delhi|chennai/i.test(t),
      us_spam: /\\bW2\\b|\\bC2C\\b|\\bH1B\\b|\\bUSC\\b|corp to corp/i.test(t),
      hiring: /#hiring|we are hiring|we'?re hiring|i'?m hiring|now hiring|is hiring|open role/i.test(t),
      recruiter: /recruit|talent acquisition|staffing|people ops|hr\\b/i.test(t),
      has_job_card: /View job/i.test(t),
      // A recruiter post often EMBEDS the req, and those reqs frequently never appear in job
      // search at all — which is the whole reason this surface is worth running. The card renders
      // as three lines directly above the "View job" marker:
      //     AI Solutions Architect (FDE) / Revli / Ghent (Hybrid) / View job
      // Verified against live posts 2026-09-09. Previously this was detected and discarded, so
      // the posts pass produced 161 people and zero leads.
      job: (() => {
        const lines = (c.innerText || '').split('\\n').map(x => x.trim()).filter(Boolean);
        const vi = lines.findIndex(x => /^View job$/i.test(x));
        if (vi < 3) return null;
        const a = [...c.querySelectorAll('a[href]')]
          .map(x => x.href).find(h => /\\/jobs\\/view\\/\\d+/.test(h)) || null;
        return {
          role: lines[vi - 3] || null,
          company: lines[vi - 2] || null,
          location: lines[vi - 1] || null,
          url: a ? a.split('?')[0] : null,
          external_id: a ? (a.match(/\\/jobs\\/view\\/(\\d+)/) || [])[1] : null,
        };
      })(),
      text: t.slice(0, 1200),
    });
  }
  return out;
`;

const COUNT_POSTS = `document.querySelectorAll('[componentkey$="FeedType_FLAGSHIP_SEARCH"]').length`;

// A query known to return posts, used to tell a real zero from a throttled one.
// LinkedIn does NOT say "unusual activity" when it rate-limits content search — it returns a
// clean "No results found" page, which is byte-for-byte what a genuinely empty query returns.
// Measured 2026-09-09: `fde hiring bangalore` returned 62 posts, and ten minutes and ten queries
// later the identical URL returned "No results found". Without this check the pass records
// silence as supply, which is the one failure this whole sweep exists to prevent.
const CANARY = 'hiring engineer';

async function isThrottled(newPage) {
  const page = await newPage();
  try {
    await page.goto('https://www.linkedin.com/search/results/content/?keywords='
      + encodeURIComponent(CANARY), { settle: 5000 });
    const n = await page.evaluate(`return ${COUNT_POSTS}`);
    return n === 0;
  } catch { return false; } finally { await page.close(); }
}

export async function scrapePosts(newPage, { queries = POST_QUERIES, log = () => {} } = {}) {
  const contacts = [], jobs = [], report = [];
  let throttled = false;
  for (const q of queries) {
    if (throttled) { report.push({ query: q, ok: false, note: 'skipped — throttled' }); continue; }
    const page = await newPage();
    try {
      const url = 'https://www.linkedin.com/search/results/content/?keywords='
        + encodeURIComponent(q) + '&sortBy=%22date_posted%22';
      await page.goto(url, { settle: 4000 });
      const state = JSON.parse(await page.evaluate(PAGE_STATE));
      if (state.authWall) throw new Error('not logged in');
      if (state.throttle) throw new Error('throttled — back off');
      let posts = [];
      if (!state.empty) {
        // Content search is a single-column feed in the window, so the default wheel x is right
        // here — unlike the two-pane job views, which need x=400.
        await page.wheelUntilStable({ count: COUNT_POSTS, max: 25, budgetMs: 35_000 });
        posts = await page.evaluate(POST_JS);
      }
      // An empty result is not trusted until the canary says the surface is still answering.
      if (state.empty) {
        if (await isThrottled(newPage)) {
          throttled = true;
          report.push({ query: q, ok: false, note: 'THROTTLED — canary also empty; zeros are not real' });
          log(`  ${q.slice(0, 40).padEnd(42)} ⚠ THROTTLED — stopping posts pass`);
          continue;
        }
      }
      const kept = posts.filter(p => p.profile_url && p.hiring && !p.us_spam);
      for (const p of kept) contacts.push({ ...p, query: q });
      // Embedded reqs become leads. Keep them even when the poster was filtered out as US spam
      // only if the job itself looks India-relevant; the poster and the req are separate facts.
      for (const p of posts) {
        if (!p.job || !p.job.role || !p.job.company || !p.job.url) continue;
        if (p.us_spam && !/india|bangalore|bengaluru|hyderabad|gurugram|noida|pune|mumbai|delhi|chennai|remote/i.test(p.job.location || '')) continue;
        jobs.push({ ...p.job, channel: 'linkedin', source: 'post:' + q,
                    fit_note: 'found inside a hiring post by ' + (p.name || 'unknown') });
      }
      const jobsHere = posts.filter(p => p.job && p.job.url).length;
      report.push({ query: q, ok: true, scanned: posts.length, kept: kept.length,
                    jobs: jobsHere, us_dropped: posts.filter(p => p.us_spam).length, empty: !!state.empty });
      log(`  ${q.slice(0, 40).padEnd(42)} ${state.empty ? 'no results' : `${posts.length} posts → ${kept.length} people, ${jobsHere} embedded jobs`}`);
    } catch (e) {
      report.push({ query: q, ok: false, note: e.message });
      log(`  ${q.slice(0, 40).padEnd(42)} ✗ ${e.message}`);
    } finally { await page.close(); }
  }
  return { contacts, jobs, report, throttled };
}

/* ------------------------------------------------------------------ surface 4: messages -- */

// The gap that let a warm referral sit 8 days: run-sweep reads Gmail and nothing else, so a
// reply arriving as a LinkedIn DM did not exist to the dashboard.
//
// The metric that matters is the AGE OF AN UNANSWERED INBOUND, not the unread count. A warm
// thread had been *read* — it just never got answered, so nothing flagged it.
const MSG_JS = `
  const out = [];
  for (const li of document.querySelectorAll('li')) {
    const raw = li.innerText || '';
    const lines = raw.split('\\n').map(s => s.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    // A conversation row always carries a timestamp: a clock time today, or a "Sep 8" date.
    const stamp = lines.find(l => /^\\d{1,2}:\\d{2}\\s?(AM|PM)$/i.test(l)
                              || /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}$/i.test(l));
    if (!stamp) continue;
    // lines[0] is NOT reliably the name: LinkedIn puts a presence indicator ("Status is online",
    // "Status is reachable") ahead of it on some rows, which silently renamed four threads to
    // "Status is reachable" on the first run.
    const NOISE = /^(Status is |Open the options|Focused$|Other$|Conversation List|Attention screen reader)/i;
    const name = lines.find(l => !NOISE.test(l)
      && !/^\\d{1,2}:\\d{2}\\s?(AM|PM)$/i.test(l)
      && !/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}$/i.test(l)
      && !/^(You:|[^:]{1,40}:)\\s/.test(l));
    if (!name) continue;
    // LinkedIn puts paid placements in the thread list; an ICICI credit-card ad is not a lead.
    if (/\\bSponsored\\b/i.test(raw)) continue;
    // Only a real "Sender: text" preview counts. The last line is often an accessibility label
    // ("Open the options list in your conversation with ...") which reads like content and is not.
    const preview = lines.find(l => /^(You:|[^:]{1,40}:)\\s/.test(l)) || null;
    out.push({
      name, stamp,
      preview: preview ? preview.slice(0, 300) : null,
      // "You: ..." means the ball is in their court. Anything else is an inbound waiting on you.
      // No parsable preview means we cannot tell who spoke last. Treat that as needing a look
      // rather than as handled — the failure mode to avoid is a silent "all clear".
      last_from_me: preview ? /^You:/.test(preview) : false,
      unread: /unread/i.test(raw),
      profile_url: (li.querySelector('a[href*="/in/"]') || {}).href || null,
    });
  }
  return out;
`;

export async function sweepMessages(newPage, { log = () => {} } = {}) {
  const page = await newPage();
  try {
    await page.goto('https://www.linkedin.com/messaging/', { settle: 7000 });
    const state = JSON.parse(await page.evaluate(PAGE_STATE));
    if (state.authWall) throw new Error('not logged in');
    const threads = await page.evaluate(MSG_JS);
    const awaitingHim = threads.filter(t => !t.last_from_me);
    log(`  ${threads.length} threads, ${awaitingHim.length} awaiting your reply`);
    return { threads, awaitingHim, ok: true };
  } catch (e) {
    log(`  ✗ ${e.message}`);
    return { threads: [], awaitingHim: [], ok: false, note: e.message };
  } finally { await page.close(); }
}

/* ------------------------------------------------------------------ gate check ---------- */

// The filter that matters cannot be read from a card. Coralogix's "8+ years" and Lucidity's
// "4-8 Years / EST hours" were invisible until the JD body was opened — which is why a hand
// check of 30 leads produced 4 keepers and 8 wasted page loads.
//
// ⚠️ Scope to the DETAIL PANE, never document.body. A job view renders the left-hand results
// list too, so body-level reads bled one card's "322 school alumni" and another's band onto
// unrelated companies — the same defect as the Wellfound band bug.
export const JD_JS = `
  // Find the container by textContent, NOT innerText. innerText forces a layout on every call,
  // so filtering all ~5000 elements with it cost ~37s per page and put a 334-lead pass at 3.4
  // hours. textContent is free; innerText is then read once, on the single node we settled on.
  let node = null;
  for (const e of document.querySelectorAll('section, div, article')) {
    if (!/About the job/i.test(e.textContent || '')) continue;
    // Deepest match wins: the smallest element still containing the marker is the JD block.
    if (!node || (e.textContent || '').length < (node.textContent || '').length) node = e;
  }
  for (let i = 0; i < 6 && node && (node.textContent || '').length < 400; i++) node = node.parentElement;
  const t = (node ? node.innerText : '');
  if (!t) return JSON.stringify({ scoped: false });
  // The applicant count sits in the top card, on one line with the location and the posting age:
  // "Delhi, Delhi, India · 1 week ago · Over 100 people clicked apply" (measured 2026-09-12; the
  // older "N applicants" wording is kept as an alternative). Anchor on the smallest element that
  // carries a NUMERIC phrase — the similar-jobs rail says "Actively reviewing applicants" and
  // "Candidates who clicked apply" three times over, with no number, so it can never match.
  // "Over 100" is a floor: recorded as 101 so ">100" reads as what it is.
  const NUM = /(over|be among the first)?\\s*(\\d[\\d,]*)(\\+)?\\s*(?:people clicked apply|applicants)/i;
  let line = null;
  for (const e of document.querySelectorAll('span, div, p, li')) {
    const tc = e.textContent || '';
    if (tc.length > 300 || !NUM.test(tc)) continue;
    if (!line || tc.length < (line.textContent || '').length) line = e;
  }
  let applicants = null, applicants_raw = null, posted_raw = null, promoted = false, company_url = null, company_name = null;
  if (line) {
    const lt = line.innerText || line.textContent || '';
    const m = lt.match(NUM);
    applicants = +m[2].replace(/,/g, '') + ((/over/i.test(m[1] || '') || m[3]) ? 1 : 0);
    applicants_raw = m[0].trim();
    const pm = lt.match(/(\\d+\\s+(?:minute|hour|day|week|month)s?\\s+ago)/i);
    if (pm) posted_raw = pm[1];
    // The company link is the top card's own; climb only until one appears.
    for (let i = 0, n = line; i < 8 && n && !company_url; i++, n = n.parentElement) {
      const c = n.querySelector('a[href*="/company/"]');
      if (c) {
        company_url = c.href.split('?')[0];
        // The name is what resolves a card that never printed one (stored as "(unknown #id)").
        // A logo link carries no text, so take the first company link that does.
        company_name = [...n.querySelectorAll('a[href*="/company/"]')].map(x => (x.textContent || '').replace(/\\s+/g, ' ').trim()).find(Boolean) || null;
        promoted = /Promoted by hirer/i.test(n.innerText || '');
      }
    }
  }
  const spans = [...t.matchAll(/(\\d{1,2})\\s*(?:\\+|-|–|to)\\s*(\\d{1,2})?\\s*\\+?\\s*years?/gi)]
    .map(m => +m[1]).filter(n => n > 0 && n < 25);
  return JSON.stringify({
    scoped: true,
    chars: t.length,
    closed: /no longer accepting applications/i.test(t),
    // The most lenient defensible reading: the smallest minimum the JD states anywhere.
    // Dropping a lead on the strictest number would reject roles whose real bar is lower.
    min_years: spans.length ? Math.min(...spans) : null,
    // A staffing shop fronting an unnamed employer. "on behalf of our client" is the tell that
    // Wisemonk's "Agentic AI Engineer" was an agency listing, not a product company.
    agency: /on behalf of our client|our client,|staffing|recruitment (agency|firm)|c2c|corp to corp/i.test(t),
    k8s: /kubernetes|k8s/i.test(t),
    remote: /remote/i.test(t),
    est_hours: /EST|PST|US (time|hours)|overlap with US/i.test(t),
    applicants, applicants_raw, posted_raw, promoted, company_url, company_name,
    text: t.slice(0, 6000),
  });
`;

/**
 * The verdict on a read JD, as a pure function of what JD_JS returned. Shared by gateCheck and
 * the enrichment pass so the two can never disagree about what "out of range" means.
 * Returns { verdict: 'pass' | 'drop' | 'agency' | 'unknown', reason }.
 */
export function judgeJD(d, { ceiling = 3 } = {}) {
  if (!d || !d.scoped) return { verdict: 'unknown', reason: 'JD body did not render' };
  if (d.closed) return { verdict: 'drop', reason: 'posting closed — no longer accepting applications' };
  // A staffing shop fronting an unnamed employer is a gate, not a drop: it is reversible from
  // the Leads tab if the read was wrong, and the row stays visible with its reason.
  if (d.agency) return { verdict: 'agency', reason: 'staffing agency fronting an unnamed client — product companies only' };
  if (d.min_years != null && d.min_years > ceiling)
    return { verdict: 'drop', reason: `experience gate is ${d.min_years}+ years against your ${ME.yearsExperience ?? '?'} — out of range, not a stretch` };
  // An unstated gate is NOT a pass; it is a question — so it returns 'unknown' and the lead
  // stays on the board unshortlisted. Treating it as a pass is what made the first run mark
  // 268 of 317 as shortlisted, which is a filter that filters nothing.
  if (d.min_years == null) return { verdict: 'unknown', reason: 'no stated gate in the JD — confirm before applying' };
  return { verdict: 'pass', reason: `gate ${d.min_years}+ years, within the ${ceiling}-year ceiling` };
}

/**
 * Open one job and read the gate out of the JD body.
 * Returns { verdict: 'pass' | 'drop' | 'unknown', reason }.
 */
export async function gateCheck(newPage, lead, { ceiling = 3 } = {}) {
  const page = await newPage();
  try {
    await page.goto(lead.url, { settle: 3000 });
    const raw = await page.evaluate(JD_JS);
    const d = JSON.parse(raw);
    const j = judgeJD(d, { ceiling });
    // gateCheck's callers only knew pass/drop/unknown; an agency read stays a drop here.
    return { ...d, ...j, verdict: j.verdict === 'agency' ? 'drop' : j.verdict };
  } catch (e) {
    return { verdict: 'unknown', reason: e.message };
  } finally { await page.close(); }
}
