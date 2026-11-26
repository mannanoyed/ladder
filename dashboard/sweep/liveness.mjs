// Is this posting still open?
//
// A lead is a claim about the world made at scrape time, and postings close. Three of seven
// Sarvam leads were already dead when checked on 2026-08-28 — including both Forward Deployed
// roles, the closest match on the whole board — and nothing would have said so until a click.
// That matters most exactly when reading the board by hand: time spent on a closed req is the
// most expensive kind of wasted time, because it feels like progress.
//
// HTTP status is not the test. Ashby and LinkedIn both serve a removed job as 200 with a "not
// found" body, so the page text is the only honest signal.
import { all, run } from '../db.mjs';
import * as B from './browser.mjs';

const DEAD = [
  /no longer accepting applications/i,
  /job not found|the job you requested was not found/i,
  /no longer available|position (has been )?closed|this job is closed/i,
  /this posting (has been|is) (closed|removed|filled)/i,
  /404 not found/i,
];
const LOGIN = /^(sign in|log in|join linkedin)/i;

/**
 * @param {object} opts
 * @param {string[]} opts.ids   explicit lead ids, or
 * @param {number}   opts.limit how many of the top-ranked open leads to check
 */
export async function checkLeads({ ids = null, limit = 60, drop = false, log = console.log } = {}) {
  const rows = ids?.length
    ? all(`SELECT id, company, role, url FROM leads WHERE id IN (${ids.map(() => '?').join(',')}) AND url LIKE 'http%'`, ...ids)
    : all(`SELECT id, company, role, url FROM leads
           WHERE status IN ('new','shortlisted') AND url LIKE 'http%'
           ORDER BY score DESC LIMIT ?`, limit);

  await B.launch({ headless: true });
  if (!(await B.healthy())) { B.stop(); await B.launch({ headless: true }); }

  const out = { checked: 0, dead: [], live: 0, unknown: 0 };
  for (const l of rows) {
    const page = await B.newPage().catch(() => null);
    if (!page) { out.unknown++; continue; }
    try {
      await page.goto(l.url, { settle: 3500 });
      const t = await page.evaluate(`return { txt: (document.body.innerText||'').slice(0,1200), title: document.title }`);
      const hay = `${t.title}\n${t.txt}`;
      const hit = DEAD.find(re => re.test(hay));
      if (hit) {
        out.dead.push({ id: l.id, company: l.company, role: l.role });
        log(`DEAD   #${l.id} ${l.company} — ${l.role.slice(0, 44)}`);
        if (drop) run(`UPDATE leads SET status='dropped', dropped_reason='posting closed (checked ' || date('now') || ')' WHERE id=?`, l.id);
      } else if (LOGIN.test(t.txt.trim())) {
        out.unknown++;                      // a login wall proves nothing either way
      } else { out.live++; }
      out.checked++;
    } catch { out.unknown++; }
    await page.close().catch(() => {});
  }
  return out;
}
