// ladder/dashboard/sweep/enrich.mjs — read the posting and the company page; write only what a
// machine is allowed to own.
//
// The score model's Alignment bar is `unknown` for every lead until the JD has been read, and the
// Company bar is `unverified` for 96% of the board until something looks the employer up. Both are
// one page-open away, so this pass opens them — in the sweep's own Chrome, after reconcile, inside
// a budget, one lead per try/catch so a bad page costs one row and never the hunt.
//
// Invariants, each paid for by a bug elsewhere in this repo:
//   - The scraper fills blanks, it never overwrites. `status`, `dropped_reason`, `fit_note` and
//     `notes` are judgement and are never touched here — except the two drops the plan allows
//     (a closed posting, a stated gate over the ceiling), which are facts read off the page.
//   - "We could not look" and "there is nothing there" must never render the same: an unreadable
//     page is `jd_status='unreadable'`, retried after 30 days, and scores exactly as before.
//   - No web search in the hunt. Company facts come from the company page a card linked to, or
//     from `ladder company set` by hand.
import { all, one, run, settings } from '../db.mjs';
import { normKey } from '../lib.mjs';
import { launch, newPage, healthy, stop } from './browser.mjs';
import { JD_JS, judgeJD } from './linkedin.mjs';
import { scoreV2, persistScore, companyMap, isWarm } from '../score.mjs';
import { agoToTimestamp } from './portals.mjs';

// A company link read off a job page is only trusted when its slug carries the company's name —
// the first read of this pass took Juniper's link off a Cisco posting from a similar-jobs rail.
function slugMatches(url, company) {
  const slug = normKey(String(url || '').split('/company/')[1]?.split('/')[0] || '');
  const co = normKey(company);
  if (!slug || co.length < 3) return false;
  return slug.includes(co.slice(0, Math.min(5, co.length))) || co.includes(slug.slice(0, Math.min(5, slug.length)));
}

const nowISO = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A generic posting page: the smallest element that still holds half the page's text is the
// body of the listing. Login walls and bot checks are short pages that say so; a 404 says so too.
const GENERIC_JS = `
  const body = document.body ? document.body.innerText : '';
  const head = body.slice(0, 1500);
  // A short page is either a wall (could not look) or a tombstone (nothing there). The two must
  // never read the same: "Page not found" on an ATS is a closed req, and is said so.
  if (!body || body.length < 300) {
    if (/page not found|not found|no longer available|no longer accepting|this job (has )?(closed|expired)|404/i.test(head))
      return JSON.stringify({ scoped: true, chars: body.length, closed: true, min_years: null, agency: false,
                              k8s: false, remote: false, est_hours: false, applicants: null, applicants_raw: null,
                              company_url: null, text: head });
    return JSON.stringify({ scoped: false, chars: body.length,
      wall: /sign in|log in|login|verify you are human|access denied|enable javascript|captcha/i.test(head) });
  }
  let best = null;
  for (const e of document.querySelectorAll('main, article, section, div')) {
    const L = (e.textContent || '').length;
    if (L < body.length * 0.5) continue;
    if (!best || L < (best.textContent || '').length) best = e;
  }
  const t = (best ? best.innerText : body).slice(0, 6000);
  const spans = [...t.matchAll(/(\\d{1,2})\\s*(?:\\+|-|–|to)\\s*(\\d{1,2})?\\s*\\+?\\s*years?/gi)]
    .map(m => +m[1]).filter(n => n > 0 && n < 25);
  return JSON.stringify({
    scoped: true, chars: t.length,
    closed: /no longer accepting|no longer available|position (has been )?(filled|closed)|job (is )?(closed|expired)|this job is no longer|this posting is closed|page not found|404/i.test(head),
    min_years: spans.length ? Math.min(...spans) : null,
    agency: /on behalf of our client|our client,|for our client|staffing|recruitment (agency|firm)|c2c|corp to corp/i.test(t),
    k8s: /kubernetes|k8s/i.test(t),
    remote: /remote/i.test(t),
    est_hours: /EST|PST|US (time|hours)|overlap with US/i.test(t),
    applicants: null, applicants_raw: null, company_url: null,
    text: t,
  });
`;

async function ensureBrowser(log) {
  if (await healthy()) return true;
  log('  browser unresponsive — restarting');
  try { stop(); await sleep(1500); await launch({ headless: true }); return await healthy(); }
  catch (e) { log(`  browser restart failed: ${e.message}`); return false; }
}

/** Candidates: live, never read (or unreadable > 30 days ago), a real URL. foundit rows qualify only once
 *  they carry a /job/ permalink (adapter fixed 2026-09-13); older rows still hold a search stand-in. */
export function leadCandidates(limit, ids = null) {
  if (ids) return all(`SELECT * FROM leads WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return all(`SELECT * FROM leads
              WHERE status IN ('new','shortlisted')
                AND url LIKE 'http%' AND (channel <> 'foundit' OR url LIKE '%foundit.in/job/%')
                AND (jd_checked_at IS NULL
                     OR (jd_status = 'unreadable' AND jd_checked_at < datetime('now','-30 days')))
              ORDER BY COALESCE(json_extract(score_json, '$.potential'), score, 0) DESC, id
              LIMIT ?`, limit);
}

/**
 * Open each candidate's posting and record what it says. Returns counts and a per-lead log.
 * `dry` reads the pages and reports, and writes nothing.
 */
// 14 min, not 6: since 2026-11-02 a hunt lands ~100+ in-lane leads, and an unread JD is an
// unknown gate and, on a dateless collection card, an unknown age.
export async function enrichLeads({ limit = 120, dry = false, budgetMs = 14 * 60_000, ids = null, log = () => {} } = {}) {
  const s = settings();
  const ceiling = +(s.gate_ceiling_years || 3);
  const rows = leadCandidates(limit, ids);
  const res = { candidates: rows.length, read: 0, unreadable: 0, closed: 0, dropped: 0, agency: 0, gated_years: 0, rescored: 0, rows: [] };
  if (!rows.length) return res;
  await launch({ headless: true });
  const deadline = Date.now() + budgetMs;
  for (const l of rows) {
    if (Date.now() > deadline) { log(`  budget exhausted after ${Math.round(budgetMs / 1000)}s — ${res.rows.length} of ${rows.length} read`); break; }
    if (!(await ensureBrowser(log))) break;
    let page = null, d = null, err = null;
    const isLI = /linkedin\.com/i.test(l.url);
    try {
      page = await newPage();
      await page.goto(l.url, { settle: isLI ? 3500 : 4000 });
      d = JSON.parse(await page.evaluate(isLI ? JD_JS : GENERIC_JS));
      // Client-rendered ATS pages (Ashby, Greenhouse embeds) can still be blank at 4s; one more wait.
      if (!d.scoped && !d.wall) { await sleep(4000); d = JSON.parse(await page.evaluate(isLI ? JD_JS : GENERIC_JS)); }
    } catch (e) { err = e.message; }
    finally { if (page) await page.close().catch(() => {}); }
    // A person opens jobs one at a time. ~120 JD views a hunt on top of ~100 list pages is the
    // heaviest LinkedIn use the account has seen, so LinkedIn reads get a human-sized gap.
    if (isLI) await sleep(1000 + Math.random() * 1500);
    recordRead(l, d, { err, ceiling, dry, res, log });
  }
  return res;
}

/**
 * Judge one read and write it onto its lead: the verdict, the machine-owned columns, a rescore.
 * Shared by enrichLeads (the sweep's Chrome) and sort.mjs (LinkedIn's public endpoint), so a JD
 * read either way drops, gates and dates a lead by the same rules. Returns the log line.
 */
export function recordRead(l, d, { err = null, ceiling = 3, dry = false, res, log = () => {}, source = 'browser' } = {}) {
  // A card that printed no employer is stored as "(unknown #<jobId>)"; the JD page names it.
  // There is nothing to slug-match against, so its company link is trusted as-is.
  const unnamed = /^\(unknown/.test(l.company);
  if (d && d.company_url && !unnamed && !slugMatches(d.company_url, l.company)) d.company_url = null;

  let j = judgeJD(d, { ceiling });
  // A dead link on a warm route is not a dead route: the person who opened the door can name
  // the live req. Recorded as closed, not dropped, and it stays off Today via the gate only
  // for cold leads (score.mjs).
  const warm = isWarm(l);
  if (j.verdict === 'drop' && d?.closed && warm) j = { verdict: 'closed-warm', reason: 'link dead, but the route is a person — ask them for the live req' };
  // Likewise a stated gate over the ceiling on a warm route: the gate is written to the row and
  // score.mjs excludes it (score 0, reason visible, reversible), but dropping it is your call.
  if (j.verdict === 'drop' && !d?.closed && warm) j = { verdict: 'gated-warm', reason: j.reason + ' — warm route, gated not dropped' };
  const line = { id: l.id, company: l.company, role: l.role, channel: l.channel,
                 verdict: err ? 'error' : j.verdict, reason: err || j.reason,
                 applicants: d?.applicants ?? null, applicants_raw: d?.applicants_raw ?? null,
                 company_url: d?.company_url ?? null, min_years: d?.min_years ?? null, chars: d?.chars ?? 0,
                 posted_raw: d?.posted_raw ?? null };
  res.rows.push(line);
  log(`  ${String(l.id).padStart(5)} ${(l.channel || '-').padEnd(10)} ${(l.company + ' · ' + l.role).slice(0, 48).padEnd(49)} ` +
      `${line.verdict.padEnd(8)} ${line.applicants != null ? `${line.applicants} appl.` : ''}${line.min_years != null ? ` gate ${line.min_years}+` : ''}` +
      `${line.verdict === 'error' || line.verdict === 'unknown' ? ` — ${line.reason}` : ''}`);

  if (dry) return line;
  if (err || !d || !d.scoped) {
    // Could not look. Say so on the row, never pretend the JD said nothing.
    run(`UPDATE leads SET jd_status='unreadable', jd_checked_at=?, jd_source=? WHERE id=?`, nowISO(), source, l.id);
    res.unreadable++;
    return line;
  }
  res.read++;
  if (unnamed && d.company_name) {
    // Same employer and title already on the board under its real name: this row is that
    // req seen through a card that hid the company, so it folds into the named one.
    const twin = one('SELECT id FROM leads WHERE company=? AND role=? AND id<>?', d.company_name, l.role, l.id);
    if (twin) run(`UPDATE leads SET status='dropped', dropped_reason=? WHERE id=? AND status IN ('new','shortlisted')`,
                  `duplicate of #${twin.id} (${d.company_name}); the card did not name the employer`, l.id);
    else run('UPDATE leads SET company=? WHERE id=?', d.company_name, l.id);
    res.named = (res.named || 0) + 1;
  }
  const status = j.verdict === 'agency' ? 'agency' : d.closed ? 'closed' : 'read';
  run(`UPDATE leads SET jd_text=?, jd_status=?, jd_checked_at=?, jd_source=?,
         applicants=COALESCE(?, applicants),
         company_url=COALESCE(company_url, ?),
         gate_years=CASE WHEN gate_years IS NULL OR gate_years LIKE 'not stated%' THEN COALESCE(?, gate_years) ELSE gate_years END,
         posted_at=COALESCE(posted_at, ?)
       WHERE id=?`,
      d.text || null, status, nowISO(), source, d.applicants ?? null, d.company_url ?? null,
      d.min_years != null ? `${d.min_years}+ years (JD)` : null,
      d.posted_raw ? agoToTimestamp(d.posted_raw) : null, l.id);
  if (j.verdict === 'agency') res.agency++;
  if (j.verdict === 'drop' && (l.status === 'new' || l.status === 'shortlisted')) {
    // Two facts read off the page are allowed to drop a lead. The reason is phrased so the
    // Stats page's death rules file it under 'closed' or 'experience'.
    run(`UPDATE leads SET status='dropped', dropped_reason=? WHERE id=?`, j.reason, l.id);
    res.dropped++;
    if (d.closed) res.closed++; else res.gated_years++;
  }
  const fresh = one('SELECT * FROM leads WHERE id=?', l.id);
  if (persistScore(fresh.id, scoreV2(fresh))) res.rescored++;
  return line;
}

// ---------- companies ----------

const FIELDS = ['funding_stage', 'funding_total_usd', 'last_round_at', 'founded', 'headcount', 'yc_batch', 'kind'];

/**
 * Write company facts. Fills blanks; a `manual:` source overwrites, because a hand-entered fact
 * beats a scraped one. Creates the row when the company is not on file. Rebuilds the score
 * model's company map so the next score sees it.
 */
export function setCompanyFacts(name, facts, { source = 'enrich' } = {}) {
  if (!name) return null;
  const co = companyMap().get(normKey(name)) || null;
  const manual = /^manual/.test(source);
  let id = co?.id;
  if (!id) {
    id = Number(run(`INSERT INTO companies (name) VALUES (?)`, name).lastInsertRowid);
  }
  const sets = [], vals = [];
  for (const k of FIELDS) {
    if (facts[k] == null || facts[k] === '') continue;
    if (!manual && co && co[k] != null && co[k] !== '') continue;        // fill blanks only
    sets.push(`${k}=?`); vals.push(facts[k]);
  }
  if (sets.length) {
    sets.push('enrich_source=?', 'enriched_at=?'); vals.push(source, nowISO());
  }
  sets.push('enrich_checked_at=?', "updated_at=datetime('now')"); vals.push(nowISO());
  run(`UPDATE companies SET ${sets.join(', ')} WHERE id=?`, ...vals, id);
  companyMap(true);
  return { id, name: co?.name || name, written: sets.length - 3, created: !co };
}

const PAGE_JS = `return document.body ? document.body.innerText.slice(0, 20000) : ''`;

/** Parse a company page's text into facts, by host. Every regex is a wording hypothesis. */
export function parseCompanyPage(url, text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const f = {};
  const range = t.match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)\s*(?:people|employees)/i);
  const single = t.match(/(?:team size|company size|employees)[:\s]*(\d[\d,]*)\b/i);
  if (range) f.headcount = +range[2].replace(/,/g, '');
  else if (single) f.headcount = +single[1].replace(/,/g, '');
  // A stage word only counts next to a funding label or as "Series X": Google's LinkedIn page
  // says "acquired" about other companies, and every big company's page says "public" somewhere.
  const stage = t.match(/(?:funding stage|stage|funding|last round)[:\s]*(pre-?seed|seed|series [a-e]|bootstrapped|public)\b/i)
             || t.match(/\b(series [a-e])\b/i) || t.match(/\b(pre-?seed)\b/i);
  if (stage) f.funding_stage = stage[1].toLowerCase().replace(/\s+/, '-');
  const founded = t.match(/founded[:\s]*(?:in\s*)?((?:19|20)\d{2})/i);
  if (founded) f.founded = founded[1];
  const raised = t.match(/(?:total raised|raised|funding)[:\s]*\$\s?([\d.]+)\s*(k|m|b)\b/i);
  if (raised) f.funding_total_usd = +raised[1] * ({ k: 1e3, m: 1e6, b: 1e9 })[raised[2].toLowerCase()];
  if (/ycombinator\.com/i.test(url)) {
    const b = t.match(/\b([WSF]\d{2})\b/);
    if (b) f.yc_batch = b[1];
  }
  return f;
}

/** Companies referenced by live leads that carry a company_url and have never been checked. */
export function companyCandidates(limit, only = null) {
  const rows = all(`SELECT company, company_url, MAX(COALESCE(json_extract(score_json,'$.potential'), score, 0)) p
                    FROM leads WHERE status IN ('new','shortlisted') AND company_url LIKE 'http%'
                    ${only ? 'AND company = ?' : ''}
                    GROUP BY company ORDER BY p DESC`, ...(only ? [only] : []));
  const map = companyMap(true);
  return rows.filter(r => { const co = map.get(normKey(r.company)); return only || !co || !co.enrich_checked_at; }).slice(0, limit);
}

export async function enrichCompanies({ limit = 15, dry = false, budgetMs = 3 * 60_000, only = null, log = () => {} } = {}) {
  const rows = companyCandidates(limit, only);
  const res = { candidates: rows.length, read: 0, written: 0, empty: 0, rows: [] };
  if (!rows.length) return res;
  await launch({ headless: true });
  const deadline = Date.now() + budgetMs;
  for (const r of rows) {
    if (Date.now() > deadline) { log(`  company budget exhausted — ${res.rows.length} of ${rows.length} read`); break; }
    if (!(await ensureBrowser(log))) break;
    let url = r.company_url;
    // LinkedIn company pages keep size and founding on /about/.
    if (/linkedin\.com\/company\//i.test(url)) url = url.replace(/(\/company\/[^/?#]+).*$/, '$1/about/');
    let page = null, facts = {}, err = null;
    try {
      page = await newPage();
      await page.goto(url, { settle: 4000 });
      facts = parseCompanyPage(url, await page.evaluate(PAGE_JS));
    } catch (e) { err = e.message; }
    finally { if (page) await page.close().catch(() => {}); }
    const line = { company: r.company, url, facts, error: err };
    res.rows.push(line);
    log(`  ${r.company.slice(0, 28).padEnd(29)} ${err ? 'ERROR ' + err : Object.keys(facts).length ? JSON.stringify(facts) : '(nothing parsed)'}`);
    if (dry || err) continue;
    res.read++;
    const w = setCompanyFacts(r.company, facts, { source: new URL(url).host });
    if (w && w.written) res.written++; else res.empty++;
  }
  // Rescore the leads whose company just gained facts.
  if (!dry) {
    for (const r of res.rows) {
      if (!Object.keys(r.facts).length) continue;
      for (const l of all(`SELECT * FROM leads WHERE status IN ('new','shortlisted') AND company=?`, r.company))
        persistScore(l.id, scoreV2(l));
    }
  }
  return res;
}
