// ladder/dashboard/sweep/sort.mjs — the second step: a JD, a date and a price on every row, so
// the board's order is earned rather than guessed.
//
// Extraction loads wide (clean.mjs keeps it honest), and on 2026-11-02 that left 546 eligible rows
// ranked on almost nothing: Money unknown on 91%, Company on 77%, the JD read on 18%, and 226
// rows with no posting date aging from the night we found them — a week-old backfill row looked
// "posted today". You work the board down to about 55 and want the best of a hunt first, so
// the top of the board has to be right the moment a hunt ends.
//
// Plain HTTP, no browser, and never your account:
//   - LinkedIn's public job endpoint (jobs-guest/jobs/api/jobPosting/<id>) serves the JD, the
//     posting age, the applicant count and the company link to anyone. It rate-limits in bursts
//     (measured 2026-11-02: 15 of 16 at a 3-6s gap, the one 429 cleared on the next request), so
//     it gets a ~3.5s gap and a backed-off retry, and three refusals in a row end the LinkedIn half.
//   - Indeed and Glassdoor refuse plain HTTP (401 / 403). Their rows look for a twin: the same
//     req on LinkedIn's public search, accepted only on an exact company + roleKey match.
//   - AmbitionBox (ambitionbox.mjs) prices the company's engineers.
// The two hosts run as two workers side by side, each freshest first: a fresh lead loses value
// fastest, so today's postings are sorted in the first minute of a run.
//
// Every write goes through the same code as the browser pass (enrich.recordRead), so a JD read
// here drops, gates and dates a lead by exactly the same rules.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run, ROOT, setting, settings } from '../db.mjs';
import { normKey } from '../lib.mjs';
import { roleKey } from '../clean.mjs';
import { scoreV2, persistScore, companyMap, companyFor } from '../score.mjs';
import { recordRead } from './enrich.mjs';
import { agoToTimestamp } from './portals.mjs';
import { refreshCompanies, verifyMatches, abKey, AGENCY_NAME } from './ambitionbox.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const LI = 'https://www.linkedin.com/jobs-guest/jobs/api';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const bump = () => { try { writeFileSync(join(ROOT, '.bump'), String(Date.now())); } catch {} };
const nowISO = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// Channels whose posting pages refuse us everywhere, so a LinkedIn twin is the only way to a JD.
const TWIN_CHANNELS = ['indeed', 'glassdoor'];

// ---------- LinkedIn's public endpoints ----------

// LADDER_HTTP_FAST=1 (the tests, against a stubbed fetch) drops the pause and the backoff.
const FAST = process.env.LADDER_HTTP_FAST === '1';
let liLast = 0;
/** One paced GET against LinkedIn's guest API. 429 → wait and retry, twice, then say so. */
async function liGet(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = FAST ? 0 : liLast + 3000 + Math.random() * 1500 - Date.now();
    if (wait > 0) await sleep(wait);
    liLast = Date.now();
    let r;
    try { r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25_000) }); }
    catch (e) { return { status: 0, error: e.message }; }
    if (r.status === 429) { if (!FAST) await sleep(attempt === 0 ? 15_000 : 60_000); continue; }
    return { status: r.status, body: r.status === 200 ? await r.text() : null };
  }
  return { status: 429, refused: true };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
const decode = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const text = html => decode(String(html || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|ul|ol|h\d|div)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
  .replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const inner = (html, cls) => {
  const m = String(html).match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</`));
  return m ? text(m[1]) : null;
};

/** The LinkedIn job id in a lead URL, or null. */
export const jobIdOf = url => (String(url || '').match(/linkedin\.com\/jobs\/view\/(?:[^/?#]*?-)?(\d{8,12})/i)
  || String(url || '').match(/currentJobId=(\d{8,12})/) || [])[1] || null;

/**
 * One guest job page, in the shape JD_JS returns from the logged-in page, so judgeJD and
 * recordRead take it unchanged. The regexes for years and agency are JD_JS's, kept identical.
 */
export function parseGuest(html) {
  const H = String(html || '');
  const dm = H.match(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/section>/);
  const body = dm ? text(dm[1]).replace(/\n?Show (more|less)\s*/g, '\n').trim() : '';
  if (body.length < 200) return { scoped: false, chars: body.length };
  const title = inner(H, 'topcard__title') || '';
  const crit = [...H.matchAll(/description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*>([\s\S]*?)<\/span>/g)]
    .map(m => `${text(m[1])}: ${text(m[2])}`).join('\n');
  const t = `${title}\n${body}${crit ? `\n\n${crit}` : ''}`;
  const appl = inner(H, 'num-applicants__caption') || inner(H, 'num-applicants__figure') || '';
  const am = appl.match(/(over|be among the first)?\s*(\d[\d,]*)(\+)?\s*(?:people clicked apply|applicants)/i);
  const org = H.match(/class="[^"]*topcard__org-name-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  // The title too: KPMG's "Generative AI Engineer (3-6 Years)" states its gate nowhere else.
  const spans = [...`${title}\n${body}`.matchAll(/(\d{1,2})\s*(?:\+|-|–|to)\s*(\d{1,2})?\s*\+?\s*years?/gi)]
    .map(m => +m[1]).filter(n => n > 0 && n < 25);
  return {
    scoped: true, chars: t.length,
    closed: /no longer accepting applications/i.test(H),
    min_years: spans.length ? Math.min(...spans) : null,
    agency: /on behalf of our client|our client,|staffing|recruitment (agency|firm)|c2c|corp to corp/i.test(body),
    k8s: /kubernetes|k8s/i.test(body), remote: /remote/i.test(body),
    est_hours: /EST|PST|US (time|hours)|overlap with US/i.test(body),
    applicants: am ? +am[2].replace(/,/g, '') + ((/over/i.test(am[1] || '') || am[3]) ? 1 : 0) : null,
    applicants_raw: am ? am[0].trim() : null,
    posted_raw: inner(H, 'posted-time-ago__text'),
    promoted: false,
    company_url: org ? decode(org[1]).split('?')[0] : null,
    company_name: org ? text(org[2]) : null,
    text: t.slice(0, 6000),
  };
}

export async function readLinkedInGuest(jobId) {
  const r = await liGet(`${LI}/jobPosting/${jobId}`);
  return { status: r.status, refused: !!r.refused, d: r.body ? parseGuest(r.body) : null };
}

/** Cards from LinkedIn's public job search. [{ jobId, title, company }] */
export function parseSearch(html) {
  return String(html || '').split(/data-entity-urn="urn:li:jobPosting:/).slice(1).map(chunk => ({
    jobId: (chunk.match(/^(\d{8,12})/) || [])[1],
    title: inner(chunk, 'base-search-card__title'),
    company: (chunk.match(/base-search-card__subtitle[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1],
  })).filter(c => c.jobId && c.title).map(c => ({ ...c, company: c.company ? text(c.company) : '' }));
}

/** The card that is the same req: the company and the roleKey must both match exactly. */
export function pickTwin(lead, cards) {
  const want = roleKey(lead.role, lead.company), co = [normKey(lead.company), abKey(lead.company)];
  return cards.find(c => c.company && (co.includes(normKey(c.company)) || co.includes(abKey(c.company)))
                      && roleKey(c.title, c.company) === want) || null;
}

/** The same req on LinkedIn's public search, or { hit: null }. */
export async function findTwin(lead) {
  const q = encodeURIComponent(`${lead.role} ${lead.company}`.slice(0, 120));
  const r = await liGet(`${LI}/seeMoreJobPostings/search?keywords=${q}&location=India&start=0`);
  if (r.refused) return { refused: true };
  return { hit: pickTwin(lead, parseSearch(r.body)) };
}

// ---------- the queues ----------

// Eligible (score > 0 — a gated row's JD changes nothing), live, freshest first.
const LIVE = `status IN ('new','shortlisted') AND score > 0`;
// A row with no posting date is placed as the scorer counts it: 5 days old at the freshest.
const AT = `COALESCE(posted_at, datetime(discovered_at, '-5 days'))`;
const FRESHEST = `${AT} DESC, id DESC`;

export function jdQueue({ limit = 10_000, ids = null } = {}) {
  if (ids) return all(`SELECT * FROM leads WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  return all(`SELECT * FROM leads WHERE ${LIVE}
                AND ((channel='linkedin' AND url LIKE '%linkedin.com/jobs/view/%')
                     OR (channel IN (${TWIN_CHANNELS.map(c => `'${c}'`).join(',')})
                         AND (jd_source IS NULL OR (jd_source LIKE 'twin:none %' AND substr(jd_source, 11) < date('now','-14 days')))))
                AND (jd_checked_at IS NULL OR (jd_status='unreadable' AND jd_checked_at < datetime('now','-30 days')))
              ORDER BY ${FRESHEST} LIMIT ?`, limit);
}

export function companyQueue({ limit = 10_000, ids = null } = {}) {
  const rows = all(`SELECT company, MAX(${AT}) at FROM leads
                    WHERE ${ids ? `id IN (${ids.map(() => '?').join(',')})` : LIVE}
                    GROUP BY company ORDER BY at DESC`, ...(ids || []));
  const map = companyMap(true), seen = new Set(), out = [];
  for (const { company } of rows) {
    const k = normKey(company);
    if (!k || seen.has(k) || /^\(unknown/.test(company) || AGENCY_NAME.test(company)) continue;
    seen.add(k);
    const co = map.get(k);
    if (!ids && co?.ab_checked_at && co.ab_match !== 'blocked'
        && Date.parse(co.ab_checked_at.replace(' ', 'T') + 'Z') > Date.now() - 30 * 864e5) continue;
    out.push(company);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- the run ----------

const ageLabel = raw => raw ? raw.replace(/\s+ago$/, '') : 'no date';

/**
 * Sort the board. `only`: 'jd' (LinkedIn reads + twins), 'twins', 'ab'. `dry` reads and
 * reports, writes nothing, and prints the score each row would move to.
 */
export async function sortBoard({ dry = false, limit = 10_000, ids = null, only = null, budgetMs = 20 * 60_000, log = () => {} } = {}) {
  const t0 = Date.now(), deadline = t0 + budgetMs;
  const ceiling = +(settings().gate_ceiling_years || 3);
  const res = { dry, jd: { read: 0, unreadable: 0, twins: 0, no_twin: 0, skipped: 0, dropped: 0, closed: 0, gated_years: 0, agency: 0, rescored: 0, rows: [] },
                ab: null, stopped: [], seconds: 0 };
  let touched = 0;
  const tick = () => { if (!dry && ++touched % 25 === 0) bump(); };

  // --- worker 1: LinkedIn (the JD, the date, the applicants, the company link) ---
  const jdWorker = async () => {
    if (only === 'ab') return;
    let refused = 0;
    for (const l of jdQueue({ limit, ids })) {
      if (Date.now() > deadline) { res.stopped.push('LinkedIn: budget'); break; }
      const isLI = l.channel === 'linkedin';
      if (only === 'twins' && isLI) continue;
      let jobId = isLI ? jobIdOf(l.url) : null, source = 'linkedin-guest';
      if (!isLI) {
        const t = await findTwin(l);
        if (t.refused) { if (++refused >= 3) { res.stopped.push('LinkedIn refused 3 in a row'); break; } continue; }
        if (!t.hit) {
          res.jd.no_twin++;
          log(`  ${String(l.id).padStart(5)} ${l.channel.padEnd(10)} ${(l.company + ' · ' + l.role).slice(0, 48).padEnd(49)} no LinkedIn twin`);
          if (!dry) run(`UPDATE leads SET jd_source=? WHERE id=?`, `twin:none ${nowISO().slice(0, 10)}`, l.id);
          continue;
        }
        jobId = t.hit.jobId; source = `twin:${jobId}`; res.jd.twins++;
      }
      if (!jobId) { res.jd.skipped++; continue; }
      const r = await readLinkedInGuest(jobId);
      if (r.refused) { if (++refused >= 3) { res.stopped.push('LinkedIn refused 3 in a row'); break; } continue; }
      refused = 0;
      // A non-200 (a removed job, a hiccup) is left for the browser pass, which can tell a wall
      // from a tombstone. Only a page we actually read gets written.
      if (r.status !== 200 || !r.d) { res.jd.skipped++; log(`  ${String(l.id).padStart(5)} ${l.channel.padEnd(10)} ${(l.company + ' · ' + l.role).slice(0, 48).padEnd(49)} HTTP ${r.status}, left for the browser`); continue; }
      const before = l.score;
      const line = recordRead(l, r.d, { ceiling, dry, res: res.jd, source });
      let after;
      if (dry) {
        const merged = { ...l, jd_text: r.d.text, applicants: r.d.applicants ?? l.applicants,
                         gate_years: l.gate_years && !/^not stated/.test(l.gate_years) ? l.gate_years : r.d.min_years != null ? `${r.d.min_years}+ years (JD)` : l.gate_years,
                         posted_at: l.posted_at || (r.d.posted_raw ? agoToTimestamp(r.d.posted_raw) : null) };
        const s = scoreV2(merged);
        after = line.verdict === 'drop' ? 'dropped' : s.gated.length ? `0 (${s.gated.map(g => g.g).join(',')})` : s.potential;
      } else {
        const now = one('SELECT score, status, score_json FROM leads WHERE id=?', l.id);
        const g = JSON.parse(now?.score_json || '{}').gated || [];
        after = now?.status === 'dropped' ? 'dropped' : g.length ? `0 (${g.map(x => x.g).join(',')})` : now?.score;
      }
      log(`  ${String(l.id).padStart(5)} ${l.channel.padEnd(10)} ${(l.company + ' · ' + l.role).slice(0, 48).padEnd(49)} ` +
          `${line.verdict.padEnd(8)} ${ageLabel(line.posted_raw).padEnd(12)} ${line.applicants != null ? `${line.applicants} appl.`.padEnd(10) : ''.padEnd(10)}` +
          `${line.min_years != null ? `gate ${line.min_years}+ `.padEnd(9) : ''.padEnd(9)}${source === 'linkedin-guest' ? '' : 'via twin '}${before} → ${after}`);
      tick();
    }
  };

  // --- worker 2: AmbitionBox (the price of engineers like this one, the company's size) ---
  const abWorker = async () => {
    if (only === 'jd' || only === 'twins') return;
    const names = companyQueue({ limit, ids });
    res.ab = await refreshCompanies(names, {
      dry, budgetMs: Math.max(0, deadline - Date.now()),
      log: m => log(`  ab ${m}`),
      onEach: (name, found) => {
        const leads = all(`SELECT * FROM leads WHERE status IN ('new','shortlisted') AND company=?`, name);
        if (!dry) {
          companyMap(true);
          for (const l of leads) { persistScore(l.id, scoreV2(l)); tick(); }
          return;
        }
        // Dry: nothing was saved, so score against the company as it would be, and show the move.
        if (!found.s || found.match === 'conflict') return;
        const co = { ...(companyFor(name) || { name }), ab_match: found.match, ab_roles: JSON.stringify(found.s.roles),
                     ab_employees_india: found.s.employeesIndia, ab_rating: found.s.rating };
        for (const l of leads) {
          const s = scoreV2(l, { co }), m = s.c.money;
          log(`       ${String(l.id).padStart(5)} ${l.role.slice(0, 44).padEnd(45)} money ${m.conf === 'unknown' ? '?' : '~₹' + m.top + 'L'} ` +
              `(${m.why[0]?.t || ''})  ${l.score} → ${s.gated.length ? 0 : s.potential}`);
        }
      },
    });
    if (res.ab.stopped) res.stopped.push(`AmbitionBox: ${res.ab.stopped}`);
  };

  await Promise.all([jdWorker(), abWorker()]);

  // The two halves ran side by side, so settle any name-only match the JD reads can now check.
  // A conflict stops counting (peersFor ignores it) and its leads fall back to the model.
  res.verify = verifyMatches({ dry });
  for (const v of res.verify.changed) {
    log(`  ab ${v.company.slice(0, 32).padEnd(33)} ${v.match === 'linkedin' ? 'confirmed by LinkedIn link' : `CONFLICT: lead links ${v.lead}, AmbitionBox links ${v.ambitionbox}`}`);
    if (dry) continue;
    companyMap(true);
    for (const l of all(`SELECT * FROM leads WHERE status IN ('new','shortlisted') AND company=?`, v.company)) persistScore(l.id, scoreV2(l));
  }
  res.verify = { linkedin: res.verify.linkedin, conflict: res.verify.conflict };

  if (!dry) {
    bump();
    // The "since the last sort" mark the board's New & strong block reads. Only a whole-board
    // run moves it; a run over chosen ids or one source is a repair, not a sort.
    if (!ids && !only) {
      setting('sort_prev_at', settings().sort_last_at || '');
      setting('sort_last_at', new Date(t0).toISOString().slice(0, 19).replace('T', ' '));
    }
  }
  res.seconds = Math.round((Date.now() - t0) / 1000);
  res.jd.rows = res.jd.rows.length;
  if (res.ab) res.ab.rows = res.ab.rows.length;
  return res;
}
