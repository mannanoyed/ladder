// ladder/dashboard/sweep/portals.mjs — the portal scrapers.
//
// Three of these (naukri, indeed, glassdoor) serve full results logged out, so they
// run unattended with no credentials at all. Three (wellfound, ycwaas, linkedin) sit behind a
// login and need the profile from `./ladder browser login`; when the session lapses they report
// needsLogin rather than quietly returning an empty list, because "no jobs" and "logged out"
// looking the same is what makes a scraper lie to you.
import { launch, newPage, healthy, stop } from './browser.mjs';
import { parseBand } from '../lib.mjs';
import { laneOf } from '../lane.mjs';

/**
 * Portals quote money three incompatible ways: "₹35,000 a month", "₹2,40,000 /year" and
 * "₹18-25 LPA". parseBand() understands only the third — hand it "2,40,000" and it reads two
 * hundred forty thousand *lakhs*. So absolute rupee figures are normalised here first, and only
 * the lakh/crore shorthand is delegated.
 */
export function parseMoney(raw) {
  if (!raw) return { min: null, max: null, raw: null };
  // Commas are removed, never replaced with a space: "2,40,000" must stay one number.
  const s = String(raw).replace(/[–—]/g, '-').replace(/,/g, '').replace(/\s+/g, ' ').trim();
  if (/not disclosed|not specified|unpaid|competitive/i.test(s)) return { min: null, max: null, raw };

  // An hourly rate is not an annual band and must never be presented as one. Glassdoor lists
  // gig work as "₹50.00 - ₹100.00" with no unit at all; read as lakhs that becomes a ₹100L
  // job at the top of the board, which is how a scraper destroys its own credibility.
  if (/per hour|\/\s*hr|an hour|hourly/i.test(s)) return { min: null, max: null, raw };

  // Lakh/crore shorthand is already parseBand's job and it does it better.
  if (/\d\s*(l\b|lpa|lakh|cr\b|crore|k\b|m\b)/i.test(s) || /\$/.test(s)) {
    const b = parseBand(s);
    if (b.min != null) return { ...b, raw };
  }

  const nums = [...s.matchAll(/(\d{4,9})/g)].map(m => parseInt(m[1], 10)).filter(n => n >= 1000);
  // No unit and no figure big enough to be a rupee salary: unknowable, so say so. Falling through
  // to parseBand here is what turns "₹50.00" into fifty lakh.
  if (!nums.length) return { min: null, max: null, raw };

  const monthly = /\/\s*mo|per month|a month|monthly|p\.?m\.?\b/i.test(s);
  const mult = monthly ? 12 : 1;
  const lpa = n => Math.round((n * mult / 1e5) * 10) / 10;
  const lo = lpa(Math.min(...nums)), hi = lpa(Math.max(...nums));
  return { min: lo, max: hi, raw };
}

/**
 * Pull the money phrase out of a card's text. The range form is tried first and on purpose:
 * "$190K - $230K" carries its unit on both numbers, and a pattern that allows the unit only
 * before the dash matches just "$190K" — halving the top of every YC band.
 */

/**
 * A US salary is not an India offer.
 *
 * A $250K posting converts to ₹308L, which then sits at the very top of the ranked board — a
 * number you will never be offered from India. Market research puts the real arbitrage at "US/EU
 * company at half its home band = ₹40-60L", so a dollar band on a role that is not India-located
 * is scaled to what an India hire actually gets, and relabelled so the board says why.
 */
const INDIA_RE = /\bindia\b|\bbengaluru\b|\bbangalore\b|\bdelhi\b|\bgurgaon\b|\bgurugram\b|\bnoida\b|\bhyderabad\b|\bpune\b|\bmumbai\b|\bchennai\b/i;
export const INDIA_DISCOUNT = 0.45;
export function indiaAdjust(money, location, text) {
  if (!money || money.min == null) return money;
  if (!/\$/.test(String(money.raw || ''))) return money;
  if (INDIA_RE.test(`${location || ''} ${text || ''}`)) return money;   // already a localised band
  const r = n => n == null ? null : Math.round(n * INDIA_DISCOUNT * 10) / 10;
  return { min: r(money.min), max: r(money.max),
           raw: `${money.raw} (US band; ~₹${r(money.min)}–${r(money.max)}L India-adjusted)` };
}

const UNIT = '(?:K|M|L|LPA|lakh|Cr|crore)';
const CUR = '(?:₹|Rs\\.?|INR|\\$)';
const INR = '(?:₹|Rs\\.?|INR)';
const moneyIn = txt => {
  const t = String(txt || '');
  const rng = c => new RegExp(`${c}\\s*[\\d,.]+\\s*${UNIT}?\\s*(?:-|–|to)\\s*${c === INR ? `${INR}?` : `${CUR}?`}\\s*[\\d,.]+\\s*${UNIT}?(?:\\s*(?:INR|USD))?`, 'i');
  const single = new RegExp(`${CUR}\\s*[\\d,.]+\\s*${UNIT}?(?:\\s*(?:a month|per month|/month|/year|per year|a year))?`, 'i');
  // A rupee figure wins over a dollar one whenever a card carries both. Multi-region YC posts
  // list a US band and a localised India band side by side; the dollar number is the offer you
  // will not get, and taking it turns a ₹20-60L India role into a ₹96-264L fiction.
  return (t.match(rng(INR)) || t.match(rng(CUR)) || t.match(single) || [null])[0];
};

const yearsIn = txt => (String(txt || '').match(/(\d+)\s*(?:-|to)\s*(\d+)\s*(?:\+)?\s*(?:yrs?|years?)|(\d+)\s*\+?\s*(?:yrs?|years?)/i) || [null])[0];

const abs = (href, origin) => { try { return new URL(href, origin).href; } catch { return null; } };

/**
 * Auth detection by login wall, not by profile chrome.
 *
 * Every per-portal check here used to hunt for a profile-menu selector remembered from the site's
 * current design. Those fail silently and in both directions: YC's `loggedIn` returned *true* on
 * a 404 page purely because the URL held no "sign_in" and the page had no sign-in link. A
 * password field and a /login redirect are contracts the site cannot change without changing how
 * logging in works.
 *
 * `authProbe` must be a URL that is genuinely gated — one that bounces to login when logged out.
 */
export async function atLoginWall(page) {
  return page.evaluate(`
    if (!document.body) return true;                      // nothing loaded yet — treat as unknown
    const t = document.title || '';
    // A gated URL that 404s tells us nothing about the session, and "nothing" is not "authenticated".
    // YC WaaS returns "File Not Found" for /applications and /profile when signed out, which passed
    // a naive wall check and reported a logged-out account as logged in.
    if (/404|file not found|page not found/i.test(t)) return true;
    // Positive evidence wins. A signed-in page can still carry a hidden "Log In" node in a
    // collapsed mobile menu — YC does exactly that, and reading it as logged-out flipped a
    // freshly authenticated session back to "needs login". Sign-out and profile controls only
    // exist when a session does, so they settle it.
    const signedIn = [...document.querySelectorAll('a, button')].some(x => {
      const t = (x.innerText || '').trim();
      const h = x.getAttribute('href') || '';
      return /^(sign ?out|log ?out|my profile|your profile)$/i.test(t)
          || /sign_out|logout|\\/logout/i.test(h);
    });
    if (signedIn) return false;
    if (/\\/(login|signin|sign_in|authwall|uas\\/login|nlogin)/i.test(location.href)) return true;
    if (document.querySelector('input[type="password"]')) return true;
    // A visible control whose text is literally "Log In" is the one signal that works across
    // sites: when a session exists they render an account name instead. Matching on the href was
    // not enough — YC sends login to account.ycombinator.com/magic, a different domain entirely,
    // so an href pattern missed it and reported a signed-out account as signed in.
    return [...document.querySelectorAll('a, button')]
      .some(x => /^(log ?in|sign ?in)$/i.test((x.innerText || '').trim()));
  `);
}

/**
 * Navigate a portal's gated URL and decide whether the session is live.
 *
 * Confirms a negative twice, and never on a first impression. Wellfound bounces through an
 * interim URL on the way to /jobs/applications; read at 4s that looked exactly like a login wall,
 * so a fully logged-in account reported "logged out" and the sweep skipped the best channel it
 * has. A positive can be trusted immediately — you cannot see a logged-in page by accident.
 */
/**
 * The lowest number of years a listing asks for, or null when it says nothing.
 * "4 years of exp" -> 4 · "4-8 Years" -> 4 · "1 year of exp" -> 1
 */
/**
 * "2 weeks ago" / "3 days ago" -> an ISO timestamp. Null when nothing was stated.
 *
 * Expiry is a probability test measured from when a job was POSTED. Without this, a Wellfound
 * listing that went up two months ago and is scraped today is aged from `discovered_at` and gets
 * a full fresh window it has not earned — and Wellfound is the channel where that matters most:
 * page-1 listings run to a 14-day median, deeper pages to ~30.
 */
export function agoToTimestamp(str) {
  // Glassdoor writes the age as "24h", "6d", "30d+" and nothing else. Accepted only when that is
  // the WHOLE string, so a card-text fallback cannot read "4d" out of "4d printer engineer".
  // Until 2026-11-02 none of these parsed, so every Glassdoor lead aged from the day we found it.
  const c = String(str || '').trim().match(/^(\d+)\s*([hdwm])\+?$/i);
  if (c) return agoToTimestamp(`${c[1]} ${{ h: 'hour', d: 'day', w: 'week', m: 'month' }[c[2].toLowerCase()]} ago`);
  const m = String(str || '').match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return null;
  const n = +m[1], u = m[2].toLowerCase();
  const mins = u === 'minute' ? n : u === 'hour' ? n * 60 : u === 'day' ? n * 1440
             : u === 'week' ? n * 10080 : u === 'month' ? n * 43200 : n * 525600;
  return new Date(Date.now() - mins * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function gateMinYears(g) {
  const m = String(g || '').match(/(\d{1,2})/);
  const n = m ? +m[1] : null;
  return n != null && n >= 0 && n < 30 ? n : null;
}

// Standing ceiling: a stated minimum of 4+ years is out (your rule, 3 Nov 2026; was "4 max"). Not
// a stretch. Wellfound prints this on the card 73% of the time, so it costs nothing here — on
// LinkedIn the same fact only exists in the JD body and cost 317 page-opens to recover.
export const GATE_CEILING = 3;

// A challenge page, in any of the shapes measured so far: Cloudflare's "Just a moment...",
// Indeed's "Additional Verification Required", Glassdoor's "Humans only". Read from the title and
// the first lines of the body, which is all a challenge page has.
const WALL_JS = `return /just a moment|additional verification required|verify you are (a )?human|humans only|unusual traffic|are you a robot/i.test(document.title + ' ' + (document.body ? document.body.innerText : '').slice(0, 500))`;

export async function checkAuth(page, P) {
  await page.goto(P.authProbe || P.searches[0], { settle: 8000 });
  if (!(await P.loggedIn(page))) {
    await new Promise(r => setTimeout(r, 4000));          // let a slow redirect finish
    return !(await atLoginWall(page));
  }
  return true;
}

// ---------------------------------------------------------------------------
// The lanes. Everything else — IoT, generic full-stack, data entry — is noise.
// ---------------------------------------------------------------------------
export const LANE = /\b(ai|ml|llm|genai|gen-ai|agent|agentic|rag|nlp|machine learning|deep learning|mlops|forward.?deployed|fde|solutions? engineer|applied scientist|prompt|eval|inference|vector|langchain|transformer)\b/i;
// "AI Trainer" reads like an AI role and is annotation gig work paid by the hour; it floods
// Glassdoor with dozens of near-identical posts from a single advertiser.
const ANTI = /\b(intern(ship)?|fresher|trainee|trainer|teacher|tutor|faculty|sales|bpo|telecall|recruiter|data entry|annotat[a-z]*|labell?[a-z]*|content writer|seo|freelanc[a-z]*|electrical|mechanical|firmware|embedded|iot|hardware|robotics|civil|qa engineer|tester|design)\b/i;

// Since 2026-11-02 the scrapers load wide and clean.mjs decides the lane after load, with the
// reason on the row. LANE / inLane stay for the probes and the per-company cap's old callers;
// the scrape itself only refuses what is certainly junk.
export const isJunkTitle = role => ANTI.test(String(role || ''));
export function inLane(role, extra = '') {
  const hay = `${role} ${extra}`;
  return LANE.test(hay) && !ANTI.test(role);
}

/**
 * Reject reqs whose *minimum* experience is above the ceiling. Your rule (3 Nov 2026): a stated
 * minimum of 4+ years is out, so anything asking more than GATE_CEILING (3) never becomes a lead.
 */
export function gateReachable(gate, maxMinYears = GATE_CEILING) {
  const m = String(gate || '').match(/(\d+)\s*(?:-|to)\s*(\d+)/) || String(gate || '').match(/(\d+)\s*\+/);
  if (!m) return true;                       // unstated gate is not a reason to drop
  return parseInt(m[1], 10) <= maxMinYears;
}

// ---------------------------------------------------------------------------
// Scrapers. Each returns raw rows; scoring, dedupe and the floor filter happen in sweepPortals.
// ---------------------------------------------------------------------------

const naukri = {
  key: 'naukri', label: 'Naukri', needsAuth: false,
  loginUrl: 'https://www.naukri.com/nlogin/login',
  searches: [
    'https://www.naukri.com/artificial-intelligence-jobs?experience=2',
    'https://www.naukri.com/machine-learning-engineer-jobs?experience=2',
    'https://www.naukri.com/llm-jobs?experience=2',
    'https://www.naukri.com/generative-ai-jobs?experience=2',
    'https://www.naukri.com/agentic-ai-jobs?experience=2',
    'https://www.naukri.com/forward-deployed-engineer-jobs',
    'https://www.naukri.com/mlops-jobs?experience=2',
    'https://www.naukri.com/rag-jobs?experience=2',
    'https://www.naukri.com/ai-platform-engineer-jobs?experience=2',
    'https://www.naukri.com/langchain-jobs',
  ],
  authProbe: 'https://www.naukri.com/mnjuser/profile',
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    return page.evaluate(`
      const out = [];
      for (const c of document.querySelectorAll('.srp-jobtuple-wrapper')) {
        const a = c.querySelector('a.title');
        if (!a) continue;
        out.push({
          role: a.textContent.trim(),
          url: a.href,
          external_id: c.getAttribute('data-job-id') || null,
          company: c.querySelector('a.comp-name')?.textContent.trim() || null,
          location: c.querySelector('.locWdth')?.textContent.trim() || null,
          gate_years: c.querySelector('.expwdth')?.textContent.trim() || null,
          posted: c.querySelector('.job-post-day')?.textContent.trim() || null,
          text: c.innerText.replace(/\\s+/g, ' ').slice(0, 1000),
        });
      }
      return out;
    `);
  },
};

const indeed = {
  key: 'indeed', label: 'Indeed', needsAuth: false,
  loginUrl: 'https://secure.indeed.com/account/login',
  // Page 2 of an Indeed search demands a sign-in on a logged-out profile (`page-two-signin`,
  // measured 2026-11-02), so depth is unreachable without your account. Breadth is not: each CITY
  // is its own page-1 corpus. "AI engineer, 7 days" India + 6 cities + Remote returned 124
  // distinct jobs from 11 page-1 reads, 59 new to the board, against ~16 from India alone.
  // The three broad queries get every city; the narrow ones get India and Bengaluru, where a city
  // split adds little because the whole result set fits on one page.
  searches: (() => {
    const CITIES = ['India', 'Bengaluru, Karnataka', 'Gurugram, Haryana', 'Pune, Maharashtra',
                    'Hyderabad, Telangana', 'Noida, Uttar Pradesh', 'Remote'];
    const BROAD = [['"AI engineer"', 7], ['"machine learning"', 7], ['LLM OR "generative AI"', 7]];
    const NARROW = [['"forward deployed" OR "forward deployment" OR "solutions engineer" AI', 14],
                    ['"agentic AI" OR "AI agents"', 14], ['"AI automation" OR "workflow automation" LLM', 14],
                    ['RAG OR "vector database" OR langchain', 14], ['MLOps OR "ML platform"', 14],
                    ['"founding engineer"', 30]];
    const url = (q, l, d) => `https://in.indeed.com/jobs?q=${encodeURIComponent(q).replace(/%20/g, '+')}&l=${encodeURIComponent(l).replace(/%20/g, '+')}&fromage=${d}`;
    return [...BROAD.flatMap(([q, d]) => CITIES.map(l => url(q, l, d))),
            ...NARROW.flatMap(([q, d]) => ['India', 'Bengaluru, Karnataka'].map(l => url(q, l, d)))];
  })(),
  // 33 page loads at ~8s each plus the pause. The flat 150s budget would stop it a third of the way in.
  budgetMs: 600_000,
  // Back-to-back loads drew the challenge after 29 searches in 3.5 minutes (2026-11-02). A person
  // reading results pauses between searches; so does this.
  paceMs: [2000, 5000],
  authProbe: 'https://myjobs.indeed.com/saved',
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    return page.evaluate(`
      // Both selectors match one card (an outline wrapping a beacon), so every job came back twice
      // and "224 scanned" was ~112. Keyed on the job key.
      const out = [], seen = new Set();
      for (const c of document.querySelectorAll('.cardOutline, [class*="job_seen_beacon"]')) {
        const a = c.querySelector('h2 a, a.jcs-JobTitle');
        if (!a) continue;
        const jk = new URLSearchParams(a.search || '').get('jk') || a.getAttribute('data-jk') || a.href;
        if (seen.has(jk)) continue;
        seen.add(jk);
        out.push({
          role: (a.querySelector('span')?.textContent || a.textContent).trim(),
          url: a.href,
          external_id: new URLSearchParams(a.search || '').get('jk') || a.getAttribute('data-jk') || null,
          company: c.querySelector('[data-testid="company-name"]')?.textContent.trim() || null,
          location: c.querySelector('[data-testid="text-location"]')?.textContent.trim() || null,
          text: c.innerText.replace(/\\s+/g, ' ').slice(0, 1000),
        });
      }
      return out;
    `);
  },
};

const glassdoor = {
  key: 'glassdoor', label: 'Glassdoor', needsAuth: false,
  loginUrl: 'https://www.glassdoor.co.in/profile/login_input.htm',
  searches: [
    'https://www.glassdoor.co.in/Job/india-ai-engineer-jobs-SRCH_IL.0,5_IN115_KO6,17.htm',
    'https://www.glassdoor.co.in/Job/india-machine-learning-engineer-jobs-SRCH_IL.0,5_IN115_KO6,31.htm',
    'https://www.glassdoor.co.in/Job/india-generative-ai-engineer-jobs-SRCH_IL.0,5_IN115_KO6,28.htm',
    'https://www.glassdoor.co.in/Job/india-forward-deployed-engineer-jobs-SRCH_IL.0,5_IN115_KO6,31.htm',
    'https://www.glassdoor.co.in/Job/india-mlops-engineer-jobs-SRCH_IL.0,5_IN115_KO6,20.htm',
    'https://www.glassdoor.co.in/Job/india-llm-engineer-jobs-SRCH_IL.0,5_IN115_KO6,18.htm',
  ],
  authProbe: 'https://www.glassdoor.co.in/member/home/index.htm',
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    // Glassdoor's class names carry a build hash (JobCard_jobTitle__GLyJ1) that changes on deploy,
    // so match on the stable prefix rather than the whole token.
    return page.evaluate(`
      const out = [];
      const pick = (c, frag) => c.querySelector('[class*="' + frag + '"]')?.textContent.trim() || null;
      for (const c of document.querySelectorAll('.jobCard, [class*="JobsList_jobListItem"]')) {
        const a = c.querySelector('a[class*="jobTitle"], a[data-test="job-link"]');
        if (!a) continue;
        out.push({
          role: a.textContent.trim(),
          url: a.href,
          external_id: (a.href.match(/jobListingId=(\\d+)/) || [])[1] || null,
          company: pick(c, 'compactEmployerName') || pick(c, 'EmployerProfile_'),
          location: pick(c, 'JobCard_location'),
          posted: pick(c, 'listingAge'),
          text: c.innerText.replace(/\\s+/g, ' ').slice(0, 1000),
        });
      }
      return out;
    `);
  },
};

const wellfound = {
  key: 'wellfound', label: 'Wellfound', needsAuth: true,
  loginUrl: 'https://wellfound.com/login',
  // Wellfound PAGINATES — it does not lazy-load. Measured 2026-09-09: `?page=N` returns disjoint
  // sets of ~47 and the AI-engineer/india page reports "2495 results · Page 1 of 53". We were
  // reading page 1 of 53 on the channel with the best strong-lead ratio on the board.
  //
  // CITY SLUGS ARE NOT REDUNDANT WITH /india. Overlap against india page 1, measured:
  // gurgaon 0/29, bangalore 14/42, pune 12/39, hyderabad 8/39. Gurgaon shared nothing at all.
  // Each city is its own corpus, so rotating them is real supply, not the same jobs re-listed.
  //
  // ⚠️ Only slugs Wellfound actually recognises. `delhi`, `ncr` and `remote` are NOT recognised:
  // they silently fall back to an unfiltered global list — 14,206 results whose first cards are
  // Dubai, Riyadh, New York and San Francisco. The tell is a missing "Jobs in <City>" heading,
  // which `scrape` now checks for. Never add a slug without confirming that heading appears.
  //
  // Depth is deliberately uneven: /india is the deep corpus, cities are shallow because they are
  // small (120–638 results) and page 6+ runs to a ~30-day median, which the 10-day expiry kills
  // on arrival anyway.
  // ⚠️ ROLE SLUGS ARE AS TREACHEROUS AS LOCATION SLUGS. Measured 2026-09-15 by fetching
  // /role/l/<slug>/india and reading the landed URL. An invalid role slug does NOT 404 — it
  // redirects to /location/india and serves the unfiltered India board. These are INVALID and
  // must never be added: forward-deployed-engineer, llm-engineer, nlp-engineer,
  // deep-learning-engineer, research-engineer. Note the first one: your primary lane has no
  // role slug on Wellfound at all, so FDE reqs only ever surface through the solutions-* slugs.
  //
  // ⚠️ `ai-engineer` IS NOT `artificial-intelligence-engineer`. They are separate corpora:
  // 738 vs 2545 results, and only 16 of 39 job ids on page 1 of ai-engineer also appear on
  // page 1 of artificial-intelligence-engineer. We read one of the two AI boards until now.
  //
  // Depth is weighted by precision, not by corpus size — software-engineer has 690 results but
  // most are not your lane, while ai-engineer at 738 nearly all are.
  searches: (() => {
    // [slug, india pages, city pages, include /role/r/ remote page]
    const ROLES = [
      ['artificial-intelligence-engineer', 6, 2, true],
      ['machine-learning-engineer',        6, 2, true],
      ['ai-engineer',                      6, 2, true],   // added 2026-09-15, separate corpus
      ['solutions-engineer',               3, 0, true],   // FDE proxy — scorer buckets these title:fde
      ['solutions-architect',              2, 0, false],  // FDE proxy
      // AI generalist: full-stack seats at AI-native startups. 28 cards on page 1 (2026-11-02);
      // clean.mjs keeps the AI-native ones and drops the rest with a reason.
      ['full-stack-engineer',              2, 0, false],
      ['backend-engineer',                 2, 0, false],
      ['software-engineer',                2, 0, false],
      ['data-scientist',                   1, 0, false],  // only 49 results in India
      ['data-engineer',                    1, 0, false],
    ];
    const CITIES = ['bangalore', 'gurgaon', 'pune', 'hyderabad', 'noida'];
    const paged = (base, n) => Array.from({ length: n }, (_, i) => i === 0 ? base : `${base}?page=${i + 1}`);
    const out = [];
    for (const [r, indiaPages, cityPages, remote] of ROLES) {
      out.push(...paged(`https://wellfound.com/role/l/${r}/india`, indiaPages));
      if (cityPages) for (const c of CITIES) out.push(...paged(`https://wellfound.com/role/l/${r}/${c}`, cityPages));
      if (remote) out.push(`https://wellfound.com/role/r/${r}`);
    }
    return out;
  })(),
  // ~62 URLs at ~6s each plus slack (was 35 / 480s before the 2026-09-15 slug expansion). The
  // flat 150s cut this off mid-first-search and reported "budget exhausted" as though the
  // platform were empty.
  budgetMs: 800_000,
  applicationsUrl: 'https://wellfound.com/jobs/applications',
  authProbe: 'https://wellfound.com/jobs/applications',
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    // Refuse an unrecognised location slug. Wellfound does not 404 on one — it REDIRECTS to the
    // bare role page and serves an unfiltered GLOBAL board (14,206 rows; Dubai, Riyadh, New York,
    // San Francisco on page 1). `delhi`, `ncr` and `remote` all behave this way.
    //
    // The tell is the landed path, not the page text. Valid pages stay where they were asked for:
    //   /role/l/<role>/gurgaon  -> /role/l/<role>/gurgaon      (h1 "... Jobs in Gurgaon")
    //   /role/r/<role>          -> /role/r/<role>              (h1 "Remote ... Jobs")
    //   /role/l/<role>/delhi    -> /role/<role>   ← rejected, bare path, no /l/ or /r/
    //
    // Two earlier guards failed here and both let the global board through: whole-page "Jobs in"
    // text (the fallback matches it via footer links) and an h1 check gated on `/role/l/` (the
    // redirect means the path no longer contains /role/l/, so the gate never ran). 26 global rows
    // reached the board before this was right.
    //
    // A THIRD fallback shape, found 2026-09-15: an invalid ROLE slug (forward-deployed-engineer,
    // llm-engineer, nlp-engineer, …) redirects to /location/india — which does NOT start with
    // /role/, so the "not a role page" escape below waved the whole global India board through.
    // Reject /location/ explicitly rather than trusting that escape.
    //   /role/l/forward-deployed-engineer/india -> /location/india   ← rejected
    const okSlug = await page.evaluate(`
      const p = location.pathname;
      if (p.startsWith('/location/')) return 0;             // invalid ROLE slug fell back here
      if (!p.startsWith('/role/')) return 1;               // /jobs?... search pages are not role pages
      return (p.startsWith('/role/l/') || p.startsWith('/role/r/')) ? 1 : 0;`);
    if (!okSlug) return [];
    // Wellfound groups jobs under a company header: the company link is not inside the job card,
    // it precedes a run of them. Walking up from a job link therefore finds either nothing or the
    // entire list container — which is why every row came back company-less and was discarded,
    // including an "Agentic AI Engineer, Remote India, ₹22L+". Document order attributes each job
    // to the header it actually sits under.
    return page.evaluate(`
      const out = [], seen = new Set();
      let company = null, companyUrl = null;
      for (const a of document.querySelectorAll('a[href^="/company/"], a[href*="/jobs/"]')) {
        const href = a.getAttribute('href') || '';
        if (href.startsWith('/company/')) {
          const t = a.textContent.replace(/\\s+/g, ' ').trim();
          // logo links carry no text; fall back to the slug so the run is not orphaned
          company = t || href.split('/')[2].replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
          // The company page is where size, stage and funding live; enrichment reads it later.
          companyUrl = a.href.split('?')[0];
          continue;
        }
        const m = a.href.match(/\\/jobs\\/(\\d+)/);
        if (!m || seen.has(m[1]) || !company) continue;
        seen.add(m[1]);
        // Wellfound's class names are build-hashed, so 'div[class*="styles_component"]' stopped
        // matching and every row fell back to the bare <a> — whose innerText is the WHOLE PAGE.
        // That is how 136 of 154 leads ended up sharing five identical band+gate pairs: each row
        // inherited the first salary and experience figure printed anywhere on the search page.
        // Walk up structurally instead: the card is the largest ancestor still containing exactly
        // one job link. That survives any class rename.
        let card = a, up = a;
        for (let i = 0; i < 10 && up.parentElement; i++) {
          up = up.parentElement;
          if (up.querySelectorAll('a[href*="/jobs/"]').length !== 1) break;
          card = up;
        }
        const title = a.querySelector('[class*="styles_title"]');
        const txt = (card.innerText || a.textContent || '').replace(/\\s+/g, ' ');
        // Read band and gate off the CARD, never the page. A job that states no band must come
        // back null — an inherited number is worse than a blank, because it ranks.
        const band = (txt.match(/₹[\\d.]+L\\s*[–-]\\s*₹[\\d.]+L|\\$[\\d,]+k?\\s*[–-]\\s*\\$[\\d,]+k?/) || [null])[0];
        const gate = (txt.match(/(\\d+\\+?\\s*years? of exp)/) || [null, null])[1];
        out.push({
          role: (title ? title.textContent : a.textContent).replace(/\\s+/g, ' ').trim(),
          url: a.href, external_id: m[1], company, company_url: companyUrl,
          band_raw: band, gate_years: gate,
          location: (txt.match(/(Remote only|Onsite or remote|In office)[^$₹]{0,40}/) || [null])[0],
          text: txt.slice(0, 1000),
        });
      }
      return out;
    `);
  },

  /**
   * Application status — the reason Wellfound is worth a login at all.
   *
   * Read from the text, not from selectors. The list renders as a flat run of
   * company / role / status / date lines, and every class name on the page is a build-hashed
   * Tailwind token that changes on deploy. Guessing at those returned zero rows against a page
   * that plainly showed six applications.
   */
  async statuses(page) {
    return page.evaluate(`
      const L = (document.body ? document.body.innerText : '').split('\\n').map(s => s.trim()).filter(Boolean);
      const STATUS = /^(Pending|Viewed|Seen|Replied|Rejected|Not a fit|Interviewing|Hired|Archived)$/i;
      const out = [];
      for (let i = 2; i < L.length; i++) {
        if (!STATUS.test(L[i])) continue;
        const company = L[i - 2], role = L[i - 1], when = L[i + 1] || null;
        // A real row always ends in a date. Without that check the tab bar itself
        // ("Applications / Ongoing / Archived") parses as an archived application.
        if (!company || !role || STATUS.test(role) || STATUS.test(company)) continue;
        if (!when || !/\\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\\b|\\d{1,2}\\/\\d{1,2}/i.test(when)) continue;
        out.push({ company, role, status_raw: L[i], when,
                   text: company + ' — ' + role + ' — ' + L[i] + (when ? ' — ' + when : '') });
      }
      return out;
    `);
  },
};

const ycwaas = {
  key: 'yc-waas', label: 'YC WaaS', needsAuth: true,
  loginUrl: 'https://www.workatastartup.com/sign_in',
  // /companies?... silently redirects to / and drops every filter, so the scrape was reading the
  // generic landing feed rather than the India engineering pool. /jobs?... keeps its query string.
  searches: [
    'https://www.workatastartup.com/jobs?role=eng&jobType=fulltime&sortBy=created_desc&locations=IN',
    'https://www.workatastartup.com/jobs?role=eng&jobType=fulltime&sortBy=created_desc&remote=true',
  ],
  messagesUrl: 'https://www.workatastartup.com/messages',
  authProbe: 'https://www.workatastartup.com/companies',
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    await page.scroll(8, 1000);   // infinite scroll: only a real scroll event fetches the next page
    return page.evaluate(`
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/jobs/"]')) {
        const m = a.href.match(/\\/jobs\\/(\\d+)/);
        if (!m || seen.has(m[1])) continue;
        // Climb to the ancestor that actually carries the company link. closest('div') stopped at
        // a bare text wrapper holding no company, so every row was discarded as company-less —
        // 30 scanned, 0 kept, including roles that had already passed the lane filter.
        let card = a.parentElement, co = null;
        for (let i = 0; i < 6 && card; i++, card = card.parentElement) {
          co = card.querySelector('a[href*="/companies/"]');
          if (co) break;
        }
        if (!co) continue;
        seen.add(m[1]);
        // The company anchor reads "Keeper (W19)•AI tax filing for complex returns" — the half
        // after the bullet is a hand-written one-line pitch, which is a far better "why" than
        // the run-together card text the scraper was storing.
        const parts = co.textContent.trim().split('\\u2022');
        const tagline = (parts[1] || '').trim();
        // The batch in the anchor — "(W19)" — is a company fact worth keeping before it is
        // stripped off the name; the company link is where team size lives.
        const batch = (parts[0].match(/\\(([A-Za-z]{1,2}\\d{2})\\)\\s*$/) || [])[1] || null;
        out.push({
          role: a.textContent.trim(), url: a.href, external_id: m[1],
          pitch: tagline || null,
          yc_batch: batch ? batch.toUpperCase() : null,
          company_url: co.href.split('?')[0],
          company: parts[0].replace(/\\s*\\([A-Za-z]{1,2}\\d{2}\\)\\s*$/, '').trim() || null,
          // Card text runs together ("...Francisco, CA, USFull stack$190K"), so anchor on a
          // city/region shape and bail to null rather than store a mangled string. A null
          // location is honest; "Francisco, CA, USFull stack$190K" is noise that reads as data.
          location: (() => {
            const m = card.innerText.match(/(Remote[^\\n$]{0,40}|[A-Z][A-Za-z]+(?:\\s[A-Z][A-Za-z]+)?,\\s*[A-Z]{2}(?:,\\s*[A-Z]{2})?)/);
            // Card text runs together, so cut at the first token that belongs to the next field.
            // "Full st" appears truncated as often as "Full stack", hence the loose prefix.
            const v = m && m[0].replace(/(Full ?st|Back ?end|Front ?end|Machine ?learn|Design|Fulltime|Apply|\\$|₹).*$/i, '')
                               .replace(/[\\s/;,]+$/, '').trim();
            return v && v.length <= 48 ? v : null;
          })(),
          text: (card.innerText || '').replace(/\\s+/g, ' ').slice(0, 1000),
        });
      }
      return out;
    `);
  },
};

const linkedin = {
  key: 'linkedin', label: 'LinkedIn', needsAuth: true,
  // AUTH ONLY. LinkedIn is scraped by sweep/linkedin.mjs now, across four surfaces instead of
  // one. This entry stays so `./ladder browser check|login --only linkedin` keeps working, but
  // sweepPortals must not run the searches below: they carry no sortBy=DD, so they come back in
  // relevance order, which is ad order — 19 of 21 cards Promoted, measured 2026-09-09. Leaving
  // both live meant every nightly run re-polluted the board with paid placements.
  authOnly: true,
  loginUrl: 'https://www.linkedin.com/login',
  // One query was scanning seven cards a night on the channel with the most inbound recruiters.
  searches: [
    'https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&location=India&f_TPR=r604800',
    'https://www.linkedin.com/jobs/search/?keywords=Machine%20Learning%20Engineer&location=India&f_TPR=r604800',
    'https://www.linkedin.com/jobs/search/?keywords=Agentic%20AI&location=India&f_TPR=r1209600',
    'https://www.linkedin.com/jobs/search/?keywords=Forward%20Deployed%20Engineer&location=India&f_TPR=r2592000',
    'https://www.linkedin.com/jobs/search/?keywords=LLM%20Engineer&location=India&f_TPR=r1209600',
    'https://www.linkedin.com/jobs/search/?keywords=Founding%20Engineer&location=India&f_TPR=r2592000',
    'https://www.linkedin.com/jobs/search/?keywords=MLOps&location=India&f_TPR=r1209600',
  ],
  authProbe: 'https://www.linkedin.com/feed/',
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    return page.evaluate(`
      const out = [], seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
        const m = a.href.match(/\\/jobs\\/view\\/(\\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const card = a.closest('li, .job-card-container') || a.parentElement;
        out.push({
          role: a.textContent.replace(/\\s+/g, ' ').trim(), url: a.href.split('?')[0], external_id: m[1],
          company: card?.querySelector('[class*="subtitle"], .job-card-container__company-name')?.textContent.trim() || null,
          location: card?.querySelector('[class*="caption"], .job-card-container__metadata-item')?.textContent.trim() || null,
          text: (card?.innerText || '').replace(/\\s+/g, ' ').slice(0, 1000),
        });
      }
      return out;
    `);
  },
};

const instahyre = {
  key: 'instahyre', label: 'Instahyre', needsAuth: false,
  loginUrl: 'https://www.instahyre.com/login/',
  authProbe: 'https://www.instahyre.com/candidate/opportunities/',
  // The SPA search route renders nothing without a session; the static category pages do.
  searches: [
    'https://www.instahyre.com/artificial-intelligence-jobs/',
    'https://www.instahyre.com/machine-learning-jobs/',
    'https://www.instahyre.com/data-science-jobs/',
  ],
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    return page.evaluate(`
      const out = [], seen = new Set();
      for (const el of document.querySelectorAll('.employer-job-name')) {
        // Titles read "Company - Role"; the em-dash split is the only structure on offer.
        const raw = el.innerText.replace(/\\s+/g, ' ').trim();
        const i = raw.indexOf(' - ');
        if (i < 1) continue;
        const company = raw.slice(0, i).trim(), role = raw.slice(i + 3).trim();
        if (!company || !role || seen.has(raw)) continue;
        seen.add(raw);
        let a = el.closest('a[href]');
        for (let n = el, k = 0; !a && n && k < 6; n = n.parentElement, k++) a = n.querySelector && n.querySelector('a[href]');
        const card = el.closest('[class*="job"], li, div') || el;
        out.push({ role, company, url: a ? a.href : location.href, external_id: null,
                   location: null, text: (card.innerText || raw).replace(/\\s+/g, ' ').slice(0, 1000) });
      }
      return out;
    `);
  },
};

const hirist = {
  key: 'hirist', label: 'Hirist', needsAuth: false,
  loginUrl: 'https://www.hirist.tech/login',
  authProbe: 'https://www.hirist.tech/my-applications',
  searches: [
    'https://www.hirist.tech/search/machine-learning-jobs',
    'https://www.hirist.tech/search/artificial-intelligence-jobs',
    'https://www.hirist.tech/search/generative-ai-jobs',
    'https://www.hirist.tech/search/data-science-jobs',
  ],
  async loggedIn(page) { return !(await atLoginWall(page)); },
  async scrape(page) {
    return page.evaluate(`
      const out = [], seen = new Set();
      for (const card of document.querySelectorAll('.joblist-card-v2')) {
        const a = card.querySelector('a[href^="/j/"]');
        const raw = (card.innerText || '').replace(/\\s+/g, ' ').trim();
        const head = raw.split(/\\d+\\s*-\\s*\\d+\\s*yrs/)[0].trim();
        const i = head.indexOf(' - ');
        if (i < 1) continue;
        let company = head.slice(0, i).trim(), role = head.slice(i + 3).trim();
        // Some Hirist rows are titled "AI Engineer - LLM/RAG" with no employer at all, which
        // put the job title in the company column. A company name that is itself a job title
        // is the tell; without a real employer the row is not a usable lead.
        const TITLEISH = /\\b(engineer|developer|architect|scientist|analyst|manager|lead|consultant|specialist)\\b/i;
        if (TITLEISH.test(company)) continue;
        const id = a ? (a.getAttribute('href').match(/-(\\d+)\\?/) || [])[1] : null;
        if (!company || !role || seen.has(company + role)) continue;
        seen.add(company + role);
        out.push({ role, company, url: a ? a.href : null, external_id: id || null,
                   gate_years: (raw.match(/(\\d+\\s*-\\s*\\d+\\s*yrs)/) || [])[1] || null,
                   location: (raw.match(/yrs\\s+([A-Za-z ,/]+?)\\s{2,}|yrs\\s+([A-Z][a-z]+)/) || [])[1] || null,
                   text: raw.slice(0, 1000) });
      }
      return out;
    `);
  },
};

// foundit (the former Monster India). Search works fully logged out — 300+ results on a plain
// query — so login buys only the skill-match score and one-click apply, not access.
//
// The card carries no href, but its inner `.cardContainer` div's id IS the job id, and
// https://www.foundit.in/job/<any-slug>-<id> resolves to the posting (verified in-browser
// 2026-09-13; curl gets a 403 bot wall, which hid this). Until then every foundit lead got a
// title+employer *search* URL that foundit answers with "Sorry No Results Found", and 43 live
// leads were marked expired by hand because "the link never showed the job".
const foundit = {
  key: 'foundit', label: 'foundit (Monster)', needsAuth: false,
  loginUrl: 'https://www.foundit.in/seeker/login',
  authProbe: 'https://www.foundit.in/seeker/profile',
  searches: [
    'https://www.foundit.in/srp/results?query=machine%20learning%20engineer&locations=India',
    'https://www.foundit.in/srp/results?query=artificial%20intelligence%20engineer&locations=India',
    'https://www.foundit.in/srp/results?query=generative%20ai%20engineer&locations=India',
    'https://www.foundit.in/srp/results?query=forward%20deployed%20engineer&locations=India',
    'https://www.foundit.in/srp/results?query=applied%20ai%20engineer&locations=India',
  ],
  // "Login to check your skill match score" is the logged-out tell, and it sits on the SRP itself.
  async loggedIn(page) {
    const t = await page.evaluate(`(document.body||{}).innerText || ''`);
    return !/login to check your skill match/i.test(String(t || ''));
  },
  async scrape(page) {
    return page.evaluate(`
      const out = [], seen = new Set();
      for (const card of document.querySelectorAll('.srpResultCardContainer')) {
        const q = sel => { const e = card.querySelector(sel); return e ? e.innerText.trim() : ''; };
        const role = q('.jobTitle'), company = q('.companyName');
        const jobId = (card.querySelector('.cardContainer[id]') || {}).id || null;
        if (!role || !company || seen.has(company + role)) continue;
        seen.add(company + role);
        const raw = (card.innerText || '').replace(/\\s+/g, ' ').trim();
        // .experienceSalary holds "1 - 3 Years" and, when the employer states one, a band beside it.
        const es = q('.experienceSalary');
        const rows = [...card.querySelectorAll('.bodyRow .details')].map(e => e.innerText.trim());
        // The years row is whichever one says Years; location is the next non-empty row that does not.
        const gate = (es.match(/([\\d.]+\\s*-\\s*[\\d.]+\\s*Years?)/i) || [])[1]
                  || (raw.match(/([\\d.]+\\s*-\\s*[\\d.]+\\s*Years?)/i) || [])[1]
                  // "Fresher" is foundit's own word for a zero-experience req. It belongs in the
                  // gate, and it was previously falling through into the location column.
                  || (/\\bFresher\\b/i.test(es) ? 'Fresher' : null);
        const EXPISH = /Years?|Fresher|Early Applicant|Posted /i;
        const loc = rows.find(r => r && !EXPISH.test(r)) || null;
        const band = (raw.match(/₹\\s?[\\d.,]+\\s*(?:-|–|to)\\s*₹?\\s?[\\d.,]+\\s*(?:L|Lakh|LPA)/i) || [])[0] || null;
        out.push({
          role, company, gate_years: gate, location: loc, band_raw: band,
          // foundit flags a young posting on the card; it is a competition signal the scorer reads.
          early: /Early Applicant/i.test(raw),
          // Slug is cosmetic — foundit routes on the trailing id alone.
          url: jobId
            ? 'https://www.foundit.in/job/' + (role + '-' + company).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + jobId
            : 'https://www.foundit.in/srp/results?query=' + encodeURIComponent(role + ' ' + company) + '&locations=India',
          external_id: jobId,
          text: raw.slice(0, 1000),
        });
      }
      return out;
    `);
  },
};

/**
 * Hacker News "Who is Hiring". Not scraped — HN exposes a public Algolia index, so this is a
 * JSON read of the current month's thread. Unusually high AI-startup density and almost no
 * overlap with the Indian boards, which is exactly what a marginal channel should look like.
 */
const hnhiring = {
  key: 'hn', label: 'HN Hiring', needsAuth: false,
  searches: [],                               // no browser involved
  async loggedIn() { return true; },
  async api() {
    const s = await (await fetch(
      'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring&hitsPerPage=1',
      { signal: AbortSignal.timeout(15000) })).json();
    const story = s.hits?.[0];
    if (!story) return [];
    const c = await (await fetch(
      `https://hn.algolia.com/api/v1/search?tags=comment,story_${story.objectID}&hitsPerPage=600`,
      { signal: AbortSignal.timeout(20000) })).json();
    const out = [];
    for (const h of c.hits || []) {
      const t = String(h.comment_text || '').replace(/<[^>]+>/g, ' ')
        .replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&#38;/g, '&')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      // Top-level posts open "Company | Role | Location | ..." by long-standing convention, but
      // the convention is loose: some posts are a paragraph, some are a person's name. Anything
      // that does not parse cleanly is skipped rather than guessed at.
      const head = t.split('|').map(x => x.trim());
      if (head.length < 2) continue;
      const company = head[0];
      if (!company || company.length > 44 || /[.!?]\s/.test(company)) continue;   // a sentence is not a company
      const role = head.slice(1).find(x =>
        x.length <= 70 && /\b(engineer|scientist|developer|mts|founding|architect)\b/i.test(x));
      if (!role) continue;

      // HN is overwhelmingly North American. Keep only what you could actually take: an explicit
      // India mention, or genuinely global remote with no US/NA restriction anywhere in the post.
      const US_ONLY = /\b(US|USA|U\.S\.|North America|NA|Canada|Can)\b[^|]{0,18}\bonly\b|\(\s*(US|USA|US\/Can|North America)[^)]*\)|US\s*[–-]\s*Remote|must be (located |based )?in the (US|United States)|ONSITE\s+(NYC|SF|San Francisco|New York)/i;
      const INDIA = /\bindia\b|\bbengaluru\b|\bbangalore\b|\bdelhi\b|\bgurgaon\b|\bnoida\b|\bhyderabad\b|\bpune\b/i;
      const GLOBAL_REMOTE = /\bremote\b.{0,30}\b(worldwide|anywhere|global|any timezone)\b|\b(worldwide|anywhere in the world)\b/i;
      if (!INDIA.test(t) && !(/(^|\W)remote(\W|$)/i.test(t) && !US_ONLY.test(t)) && !GLOBAL_REMOTE.test(t)) continue;
      if (US_ONLY.test(t) && !INDIA.test(t)) continue;

      out.push({ company, role: role.slice(0, 90),
                 url: `https://news.ycombinator.com/item?id=${h.objectID}`,
                 external_id: String(h.objectID),
                 location: head.find(x => x.length <= 60 && /remote|india|worldwide|anywhere/i.test(x)) || null,
                 text: t.slice(0, 1000) });
    }
    return out;
  },
};

// ORDER IS RUN ORDER. sweepPortals iterates Object.keys(PORTALS) in sequence with a 150s budget
// each, so whatever sits first spends the pass's time first — and on a bad morning wedges the
// browser for everything behind it. Naukri sat at position 1 and burned its full budget failing
// every day this week, which is why 08:00 reached three channels of ten. Measured 2026-09-09: a
// run without naukri completed all seven remaining channels. Nothing is removed — the weakest
// two simply run last, where failing costs only their own budget.
export const PORTALS = { wellfound, 'yc-waas': ycwaas, linkedin, hn: hnhiring,
                         indeed, glassdoor, instahyre, hirist,
                         naukri, foundit };
export const OPEN_PORTALS = Object.values(PORTALS).filter(p => !p.needsAuth).map(p => p.key);

/**
 * Run every requested portal and return leads + a channel report.
 * The channel report is what drives the dashboard's freshness strip, so a portal that failed
 * must say so — never be omitted and never be reported ok with zero rows.
 */
// One card, through the scrape-time filters, onto `leads`. A factory so the end-of-pass retry of a
// channel that hit a bot check, and rows collected by hand in your own Chrome (`filterRows`), run
// exactly the same rules as the scraper's first attempt.
function makeIngest({ floor = 18, perCompany = 3, leads, seen = new Set(), perCo = new Map() }) {
  return (key, rows, c) => {
    for (const r of rows) {
      if (!r.role || !r.company) continue;
      // Junk only. The lane is clean.mjs's call after load, where it can see the company and
      // the JD and write its reason down; the old LANE regex here lost every "Forward
      // Deployment Engineer" and every backend role at an AI-native startup.
      if (isJunkTitle(r.role)) continue;
      // Drop on a STATED gate only. An unstated one is a question, not a pass, and is left
      // on the board to be confirmed rather than silently binned.
      const gy = gateMinYears(r.gate_years);
      if (gy != null && gy > GATE_CEILING) { c.gated++; continue; }
      if (!gateReachable(r.gate_years || yearsIn(r.text))) continue;
      const k = `${r.company}|${r.role}`.toLowerCase();
      if (seen.has(k)) continue;
      const co = r.company.toLowerCase().trim();
      // The cap counts in-lane rows only, or a company's off-lane posts would use up the
      // slots before its AI role was reached.
      const lane = laneOf({ role: r.role, company: r.company, fit_note: r.text }).lane;
      if (lane !== 'off' && (perCo.get(co) || 0) >= perCompany) continue;
      seen.add(k);
      if (lane !== 'off') perCo.set(co, (perCo.get(co) || 0) + 1);
      const money = indiaAdjust(parseMoney(moneyIn(r.text)), r.location, r.text);
      const top = money.max ?? money.min;
      // "₹4L - ₹8L (Glassdoor Est.)" is Glassdoor's guess, not the employer's band, and it runs
      // absurdly low for AI roles (₹4–7L on Google and Persistent FDE reqs). It neither trips the
      // floor nor gets stored: upsertLead re-parses any band_raw it is given, so a guess kept as
      // text would come back as numbers. The scorer estimates comp its own way. "Employer Est."
      // stays a stated band.
      const guess = /Glassdoor Est/i.test(r.text || '');
      // Unknown band is kept — a startup that hides comp is not a startup that pays badly.
      if (!guess && top != null && top < floor) continue;
      if (guess) { money.raw = null; money.min = money.max = null; }
      leads.push({
        company: r.company, role: r.role, location: r.location || null,
        channel: key, url: r.url, external_id: r.external_id || null,
        band_raw: money.raw || null, band_min_lpa: money.min, band_max_lpa: money.max,
        gate_years: r.gate_years || yearsIn(r.text) || null,
        // Read from whatever the portal stated on the card, falling back to the card text.
        posted_at: agoToTimestamp(r.posted) || agoToTimestamp(r.text) || null,
        // A readable one-liner if the portal gave us one; the raw card text only as a
        // fallback, trimmed, because a "why" nobody can read is a why nobody reads.
        fit_note: ((r.early ? 'early applicant · ' : '') + (r.pitch || (r.text || '').replace(/\s+/g, ' '))).slice(0, 180) || null,
        source: `portal:${key}`,
        company_url: r.company_url || null,
        yc_batch: r.yc_batch || null,       // not a leads column: cli routes it to companies
      });
      c.kept++;
    }
  };
}

/** Rows gathered outside the sweep (your own Chrome), through the same filters. Writes nothing. */
export function filterRows(key, rows, { floor = 18, perCompany = 3 } = {}) {
  const leads = [], counts = { kept: 0, gated: 0 };
  makeIngest({ floor, perCompany, leads })(key, rows, counts);
  return { leads, counts };
}

export async function sweepPortals({ only = null, floor = 18, headless = true,
                                     perCompany = 3, perChannelMs = 150_000, log = () => {} } = {}) {
  const keys = only?.length ? only : Object.keys(PORTALS);
  const browser = await launch({ headless });
  const channels = [], leads = [], statuses = [];
  const seen = new Set();
  // One employer posting the same req twelve times is one lead, not twelve. Without a cap a
  // single high-volume advertiser owns the whole board.
  const perCo = new Map();

  const ingest = makeIngest({ floor, perCompany, leads, seen, perCo });

  // Searches that hit a bot check, retried once at the end of the pass (see below).
  const deferred = [];

  for (const key of keys) {
    const P = PORTALS[key];
    if (!P) { channels.push({ channel: key, ok: false, note: 'unknown portal' }); continue; }
    if (P.authOnly) {
      channels.push({ channel: key, ok: true, note: 'handled by sweep/linkedin.mjs — not scraped here' });
      continue;
    }
    let found = 0, authOk = null, err = null;
    const counts = { kept: 0, gated: 0 };

    // API-only channels (HN) take no browser at all. Handled up front so the browser plumbing
    // below never has to pretend a JSON endpoint is a web page.
    if (P.api) {
      try {
        const rows = await P.api();
        found = rows.length;
        for (const r of rows) {
          if (!r.role || !r.company || isJunkTitle(r.role)) continue;
          if (!gateReachable(r.gate_years || yearsIn(r.text))) continue;
          const k = `${r.company}|${r.role}`.toLowerCase();
          if (seen.has(k)) continue;
          const co = r.company.toLowerCase().trim();
          const lane = laneOf({ role: r.role, company: r.company, fit_note: r.text }).lane;
          if (lane !== 'off' && (perCo.get(co) || 0) >= perCompany) continue;
          seen.add(k); if (lane !== 'off') perCo.set(co, (perCo.get(co) || 0) + 1);
          const money = indiaAdjust(parseMoney(moneyIn(r.text)), r.location, r.text);
          const top = money.max ?? money.min;
          if (top != null && top < floor) continue;
          leads.push({ company: r.company, role: r.role, location: r.location || null,
            channel: key, url: r.url, external_id: r.external_id || null,
            band_raw: money.raw || null, band_min_lpa: money.min, band_max_lpa: money.max,
            gate_years: r.gate_years || yearsIn(r.text) || null,
            // Read from whatever the portal stated on the card, falling back to the card text.
            posted_at: agoToTimestamp(r.posted) || agoToTimestamp(r.text) || null,
            fit_note: (r.pitch || (r.text || '')).slice(0, 180) || null, source: `portal:${key}` });
          counts.kept++;
        }
      } catch (e) { err = e.message; }
      channels.push({ channel: key, ok: !err && found > 0, note: err || `${found} scanned, ${counts.kept} kept above ₹${floor}L` });
      log(`  ${P.label.padEnd(11)} ${!err && found ? '✓' : '✗'}  ${err || `${found} scanned → ${counts.kept} kept`}`);
      continue;
    }

    // Each channel gets its own budget. Channels run in sequence, so without one the slowest
    // starves every channel behind it — on 2026-08-27 Naukri hung and Indeed, Glassdoor and
    // Internshala never ran at all, turning one bad portal into a zero-lead morning.
    // A portal may declare its own budget. Wellfound paginates 53 pages deep and is the
    // highest-quality channel on the board (50% of its surviving leads score strong, against 3%
    // for LinkedIn), so it earns more of the pass than a flat 150s allows.
    const budget = P.budgetMs ?? perChannelMs;
    const deadline = Date.now() + budget;

    // A wedged browser accepts connections but never answers. Restart it rather than let the
    // next channel inherit the damage.
    if (!(await healthy())) {
      log(`  browser unresponsive — restarting before ${P.label}`);
      try {
        stop();
        await new Promise(r => setTimeout(r, 1500));
        await launch({ headless });
      } catch (e) {
        // Chrome refusing to come back up is fatal to this channel, not to the run. Record it and
        // let the next channel try again — the relaunch often succeeds on the second attempt.
        channels.push({ channel: key, ok: false, note: `browser restart failed: ${e.message}` });
        log(`  ${P.label.padEnd(11)} ✗  browser restart failed: ${e.message}`);
        continue;
      }
    }

    let walled = -1;
    for (let i = 0; i < P.searches.length; i++) {
      const url = P.searches[i];
      if (Date.now() > deadline) { err = err || `budget exhausted after ${Math.round(budget / 1000)}s`; break; }
      // newPage() used to sit outside this try, and opening a tab is exactly what fails when the
      // browser is wedged: `Runtime.enable timed out after 30000ms` escaped the channel loop and
      // killed the entire pass. That is the 2026-08-28 08:09 abort — Naukri and Indeed had
      // already been handled correctly, and then one bad tab took every remaining channel with
      // it. A channel is allowed to fail; the pass is not.
      let page = null;
      try {
        page = await newPage();
        if (authOk === null && P.needsAuth) {
          // Probe the gated URL rather than infer auth from a public search page.
          authOk = await checkAuth(page, P).catch(() => null);
          if (!authOk) { err = 'not logged in'; await page.close(); break; }
        }
        await page.goto(url, { settle: 5000 });
        // A bot check is neither an empty page nor a dead channel. Stop asking now and put the
        // rest of this channel's searches at the back of the pass: Indeed returned 0 on 6 of 14
        // hunts to 2026-11-02, every time on a challenge page read as "no jobs".
        if (await page.evaluate(WALL_JS).catch(() => false)) { walled = i; break; }
        const rows = await P.scrape(page);
        found += rows.length;
        ingest(key, rows, counts);
      } catch (e) { err = e.message; }
      finally { if (page) await page.close().catch(() => {}); }
      if (P.paceMs) await new Promise(r => setTimeout(r, P.paceMs[0] + Math.random() * (P.paceMs[1] - P.paceMs[0])));
    }

    if (walled >= 0) {
      deferred.push({ key, P, urls: P.searches.slice(walled) });
      err = `bot check after ${walled} of ${P.searches.length} searches; ${P.searches.length - walled} retry at the end of the pass`;
    }

    // Logged-in extras: the status read is the whole point of authenticating.
    if (P.statuses && authOk) {
      let page = null;
      try {
        page = await newPage();
        await page.goto(P.applicationsUrl, { settle: 5000 });
        statuses.push(...(await P.statuses(page)).map(s => ({ ...s, channel: key })));
      } catch (e) { log(`  ${key}: status read failed — ${e.message}`); }
      finally { if (page) await page.close().catch(() => {}); }
    }

    // The counts always print. An error used to replace them, so a channel that read 200 cards
    // and then timed out on its last search reported only "navigate timeout".
    // A channel that read cards did its job even if a later search failed; the note says what
    // went wrong. Only a channel that read nothing at all is a failed channel.
    const ok = found > 0;
    const tally = `${found} scanned, ${counts.kept} kept above ₹${floor}L${counts.gated ? `, ${counts.gated} over the ${GATE_CEILING}y gate` : ''}`;
    channels.push({ channel: key, ok, note: err ? `${tally} · ${err}` : tally });
    log(`  ${P.label.padEnd(11)} ${ok ? '✓' : '✗'}  ${tally}${err ? ` · ${err}` : ''}`);
  }

  // --- the retry for channels that hit a bot check ---
  // By now every other channel has run, which is minutes of distance from the challenge. One
  // more try per deferred search, and a second wall ends it: hammering a challenge is how a
  // profile gets flagged, and the channel is recorded as walled rather than empty either way.
  for (const d of deferred) {
    const entry = channels.find(c => c.channel === d.key);
    const counts = { kept: 0, gated: 0 };
    let found = 0, walledAgain = false, err = null;
    for (const url of d.urls) {
      let page = null;
      try {
        page = await newPage();
        await page.goto(url, { settle: 5000 });
        if (await page.evaluate(WALL_JS).catch(() => false)) { walledAgain = true; break; }
        const rows = await d.P.scrape(page);
        found += rows.length;
        ingest(d.key, rows, counts);
      } catch (e) { err = e.message; }
      finally { if (page) await page.close().catch(() => {}); }
    }
    const note = `retry: ${found} scanned, ${counts.kept} kept${walledAgain ? ', walled again, stopped' : ''}${err ? ` · ${err}` : ''}`;
    if (entry) { entry.note += ` · ${note}`; entry.ok = entry.ok || (found > 0 && !walledAgain); }
    log(`  ${d.P.label.padEnd(11)} ↻  ${note}`);
  }

  await browser.shutdown();
  return { leads, statuses, channels };
}
