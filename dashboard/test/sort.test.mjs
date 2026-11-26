// ladder/dashboard/test/sort.test.mjs — the sort step: parsers, matching rules, the score changes,
// and a whole run against a stubbed network. `node --test dashboard/test/`
//
// Runs against a throwaway database (LADDER_DB) and a stubbed fetch, so it never touches
// ladder.db, LinkedIn or AmbitionBox. LADDER_HTTP_FAST drops the request pacing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.LADDER_DB = join(mkdtempSync(join(tmpdir(), 'ladder-test-')), 'test.db');
process.env.LADDER_HTTP_FAST = '1';

const { all, one, run, settings, setting } = await import('../db.mjs');
const { parseGuest, parseSearch, pickTwin, jobIdOf, jdQueue, companyQueue, sortBoard } = await import('../sweep/sort.mjs');
const { parseSalaries, resolveCompany, refreshCompanies, saveSalaries, verifyMatches, abKey, liKey, liSlug } = await import('../sweep/ambitionbox.mjs');
const { recordRead } = await import('../sweep/enrich.mjs');
const { judgeJD } = await import('../sweep/linkedin.mjs');
const { peersFor } = await import('../ask.mjs');
const { scoreV2, companyMap, WEIGHTS_DEFAULT } = await import('../score.mjs');

const KPMG = readFileSync(join(HERE, 'fixtures/linkedin-guest-kpmg.html'), 'utf8');
const WHATFIX = readFileSync(join(HERE, 'fixtures/ambitionbox-whatfix.html'), 'utf8');

// A guest job page in the markup LinkedIn serves (checked against 16 real pages, 2026-11-02).
const guest = ({ title = 'AI Engineer', body = 'Build agents with Python, LLM APIs, RAG and evals. '.repeat(8),
                 posted = '3 days ago', appl = '28 applicants', org = 'Acme', href = 'https://in.linkedin.com/company/acme?trk=x',
                 closed = false } = {}) => `
<h2 class="top-card-layout__title font-sans topcard__title">${title}</h2>
<a class="topcard__org-name-link topcard__flavor--black-link" href="${href}" target="_blank">
  ${org}
</a>
<span class="posted-time-ago__text topcard__flavor--metadata">
  ${posted}
</span>
${closed ? '<figure class="closed-job"><figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption></figure>' : ''}
${appl ? `<span class="num-applicants__caption topcard__flavor--metadata">\n  ${appl}\n</span>` : ''}
<div class="description__text description__text--rich"><section class="show-more-less-html" data-max-lines="5">
<div class="show-more-less-html__markup">${body}</div><button>Show more</button></section></div>
<ul class="description__job-criteria-list"><li class="description__job-criteria-item">
<h3 class="description__job-criteria-subheader">Seniority level</h3>
<span class="description__job-criteria-text">Mid-Senior level</span></li></ul>`;

// The network, stubbed. `net(fn)` routes every fetch through fn(url) → [status, body].
const calls = [];
const net = fn => {
  calls.length = 0;
  globalThis.fetch = async url => {
    calls.push(String(url));
    const [status, body] = fn(String(url)) || [404, 'not found'];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
};
const abPage = (overrides = {}) => {
  const d = JSON.parse(WHATFIX.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const p = d.props.pageProps;
  if (overrides.name) p.companyHeaderData.companyName = overrides.name;
  if ('linkedin' in overrides) p.companyInfo.overview.sectionsList.find(s => s.sectionTitle === 'social links').sectionData.linkedin = overrides.linkedin;
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(d)}</script>`;
};
const lead = (o = {}) => {
  const r = run(`INSERT INTO leads (company, role, channel, url, status, posted_at, discovered_at, score, source, gate_years)
                 VALUES (?,?,?,?,?,?,COALESCE(?, datetime('now')),?,?,?)`,
    o.company ?? 'Acme', o.role ?? `AI Engineer ${Math.random().toString(36).slice(2, 7)}`, o.channel ?? 'linkedin',
    o.url ?? 'https://www.linkedin.com/jobs/view/4485334391/', o.status ?? 'new', o.posted_at ?? null,
    o.discovered_at ?? null, o.score ?? 60, o.source ?? null, o.gate_years ?? null);
  return one('SELECT * FROM leads WHERE id=?', Number(r.lastInsertRowid));
};
const res = () => ({ read: 0, unreadable: 0, dropped: 0, closed: 0, gated_years: 0, agency: 0, rescored: 0, rows: [] });
const ago = ts => (Date.now() - Date.parse(ts.replace(' ', 'T') + 'Z')) / 864e5;

// ---------- LinkedIn guest pages ----------

test('parseGuest reads a real guest page', () => {
  const d = parseGuest(KPMG);
  assert.equal(d.scoped, true);
  assert.equal(d.posted_raw, '3 days ago');
  assert.equal(d.applicants, 201, '"Over 200" is a floor, stored as 201');
  assert.equal(d.company_name, 'KPMG India');
  assert.equal(d.company_url, 'https://in.linkedin.com/company/kpmgindia', 'tracking query stripped');
  assert.equal(d.min_years, 3, 'the gate sits in the title: "(3-6 Years)"');
  assert.match(d.text, /Seniority level: Associate/);
  assert.doesNotMatch(d.text, /Show (more|less)/);
  assert.equal(d.closed, false);
});

test('parseGuest: applicant wordings', () => {
  assert.equal(parseGuest(guest({ appl: 'Over 200 applicants' })).applicants, 201);
  assert.equal(parseGuest(guest({ appl: 'Be among the first 25 applicants' })).applicants, 25);
  assert.equal(parseGuest(guest({ appl: '1,204 applicants' })).applicants, 1204);
  assert.equal(parseGuest(guest({ appl: '' })).applicants, null);
});

test('parseGuest: closed, short, walled and agency pages', () => {
  const closed = parseGuest(guest({ closed: true }));
  assert.equal(closed.closed, true);
  assert.equal(judgeJD(closed).verdict, 'drop');
  assert.equal(parseGuest(guest({ body: 'Too short.' })).scoped, false, 'a body under 200 chars is "could not look"');
  assert.equal(parseGuest('<html><body>Too many requests</body></html>').scoped, false, 'a 429 page has no markup');
  assert.equal(parseGuest('').scoped, false);
  assert.equal(parseGuest(guest({ body: 'We are hiring on behalf of our client, a fintech. '.repeat(6) })).agency, true);
});

test('parseGuest: entities, lists and years', () => {
  const d = parseGuest(guest({ title: 'Engineer, R&amp;D', body: `<p>We&#39;re building &quot;agents&quot;.</p><ul><li>2-4 years of Python</li><li>Ship RAG</li></ul>${'x '.repeat(120)}` }));
  assert.match(d.text, /Engineer, R&D/);
  assert.match(d.text, /We're building "agents"\./);
  assert.match(d.text, /• 2-4 years of Python/);
  assert.equal(d.min_years, 2);
  assert.equal(parseGuest(guest({ body: 'Lead teams. 5+ years required; 8+ years preferred. '.repeat(6) })).min_years, 5, 'the most lenient stated minimum');
});

test('jobIdOf: the URL shapes leads carry', () => {
  assert.equal(jobIdOf('https://www.linkedin.com/jobs/view/4466843331/'), '4466843331');
  assert.equal(jobIdOf('https://in.linkedin.com/jobs/view/ai-engineer-at-acme-4466843331?trk=x'), '4466843331');
  assert.equal(jobIdOf('https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4466843331'), '4466843331');
  assert.equal(jobIdOf('https://in.indeed.com/viewjob?jk=b913ee9c0ed2a7f7'), null);
  assert.equal(jobIdOf(null), null);
});

// ---------- twins ----------

const SEARCH = ['4430457082|Lead AI Engineer - Generative AI &amp; Agentic AI|Fractal', '4430457083|Generative AI Engineer (6-10 Years)|KPMG',
  '4430457084|Generative AI Engineer (3-6 Years)|KPMG', '4430457085|Data Scientist|']
  .map(s => s.split('|')).map(([id, t, c]) => `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
    <h3 class="base-search-card__title">\n ${t}\n </h3><h4 class="base-search-card__subtitle"><a href="#">\n ${c}\n </a></h4></div></li>`).join('');

test('parseSearch reads the public search cards', () => {
  const cards = parseSearch(SEARCH);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards[0], { jobId: '4430457082', title: 'Lead AI Engineer - Generative AI & Agentic AI', company: 'Fractal' });
  assert.equal(cards[3].company, '');
});

test('pickTwin: exact company and roleKey only', () => {
  const cards = parseSearch(SEARCH);
  assert.equal(pickTwin({ company: 'Fractal', role: 'Lead AI Engineer - Generative AI & Agentic AI' }, cards)?.jobId, '4430457082');
  assert.equal(pickTwin({ company: 'Fractal Analytics', role: 'Lead AI Engineer - Generative AI & Agentic AI' }, cards), null,
               'a different company key is a different employer until proven otherwise');
  assert.equal(pickTwin({ company: 'KPMG India', role: 'Generative AI Engineer (3-6 Years)' }, cards)?.jobId, '4430457084',
               '"KPMG India" is "KPMG", and the parenthetical picks the right req');
  assert.equal(pickTwin({ company: 'Infosys', role: 'Lead AI Engineer - Generative AI & Agentic AI' }, cards), null);
  assert.equal(pickTwin({ company: '', role: 'Data Scientist' }, cards), null, 'a card with no company never matches');
});

// ---------- AmbitionBox ----------

test('abKey and liKey: what counts as the same company', () => {
  assert.equal(abKey('KPMG India'), abKey('KPMG'));
  assert.equal(abKey('Whatfix Pvt Ltd'), abKey('Whatfix'));
  assert.notEqual(abKey('Sarvam AI'), abKey('Sarvam Safety Equipment'));
  assert.notEqual(abKey('Deccan AI'), abKey('Air Deccan'));
  assert.equal(liSlug('https://in.linkedin.com/company/kpmgindia/life/'), 'kpmgindia');
  assert.equal(liSlug('https://example.com'), null);
  assert.equal(liKey('lenovoin'), liKey('lenovo'), 'a global page and an India page');
  assert.equal(liKey('kpmg-india'), liKey('kpmg'));
  assert.notEqual(liKey('goteleport'), liKey('teleport-logistics'), 'the Teleport collision still conflicts');
});

test('parseSalaries reads the embedded dataset', () => {
  const s = parseSalaries(WHATFIX, 'u');
  assert.equal(s.name, 'Whatfix');
  assert.equal(s.employeesIndia, '3000');
  assert.equal(s.linkedin, 'https://linkedin.com/company/whatfix');
  assert.equal(s.business, 'Product, B2B, SaaS');
  assert.equal(s.rating, 3.2);
  assert.deepEqual(s.roles[0], { role: 'Solution Engineer', n: 67, min: 11.2, max: 12.6, lo: 9, hi: 15.8, exp_min: 0, exp_max: 4 });
  assert.equal(parseSalaries('<html>no data</html>'), null);
  assert.equal(parseSalaries('<script id="__NEXT_DATA__">{not json</script>'), null);
  assert.equal(parseSalaries('<script id="__NEXT_DATA__">{"props":{"pageProps":{}}}</script>'), null, 'a page without a company');
});

test('resolveCompany: slug, search, LinkedIn check, conflict, none, blocked', async () => {
  net(u => /whatfix-salaries/.test(u) ? [200, abPage()] : null);
  assert.equal((await resolveCompany('Whatfix')).match, 'name');
  assert.equal((await resolveCompany('Whatfix', { linkedinSlug: 'whatfix' })).match, 'linkedin');
  assert.equal((await resolveCompany('Whatfix', { linkedinSlug: 'whatfixindia' })).match, 'linkedin', 'suffix only');
  assert.equal((await resolveCompany('Whatfix', { linkedinSlug: 'whatfix-logistics' })).match, 'conflict');

  // The slug guess misses, the search finds the exact name under another slug.
  net(u => /api\/v2\/search/.test(u) ? [200, { data: [{ type: 'company', name: 'Whitix', url: 'whitix', reviewCount: 1 },
                                                     { type: 'company', name: 'Whatfix', url: 'whatfix-dap', reviewCount: 109 }] }]
         : /whatfix-dap-salaries/.test(u) ? [200, abPage()] : null);
  const r = await resolveCompany('Whatfix');
  assert.equal(r.match, 'name');
  assert.ok(calls.some(c => /whatfix-dap-salaries/.test(c)));
  assert.ok(!calls.some(c => /whitix-salaries/.test(c)), 'a fuzzy hit is never even fetched');

  net(u => /api\/v2\/search/.test(u) ? [200, { data: [{ type: 'company', name: 'Whitix', url: 'whitix' }] }] : null);
  assert.equal((await resolveCompany('Whatfix')).match, 'none');

  net(() => [429, 'slow down']);
  assert.equal((await resolveCompany('Whatfix')).match, 'blocked', 'a refusal is "could not look", never "none"');
  assert.equal((await resolveCompany('X')).match, 'none', 'a one-letter name is not matched at all');
});

test('refreshCompanies stops after three refusals in a row', async () => {
  net(() => [429, 'slow down']);
  const r = await refreshCompanies(['A1 Co', 'B2 Co', 'C3 Co', 'D4 Co']);
  assert.equal(r.blocked, 3);
  assert.match(r.stopped, /refused 3 in a row/);
});

test('verifyMatches settles a name match once a lead has the LinkedIn link', () => {
  run('DELETE FROM leads'); run('DELETE FROM companies');
  run(`INSERT INTO companies (name, ab_match, ab_linkedin) VALUES ('Lenovo', 'name', 'https://www.linkedin.com/company/lenovoin/'),
        ('Teleport', 'name', 'https://linkedin.com/company/teleport-logistics'), ('NoLink', 'name', 'https://linkedin.com/company/nolink')`);
  lead({ company: 'Lenovo' }); lead({ company: 'Teleport' }); lead({ company: 'NoLink' });
  run(`UPDATE leads SET company_url='https://www.linkedin.com/company/lenovo/life/' WHERE company='Lenovo'`);
  run(`UPDATE leads SET company_url='https://www.linkedin.com/company/goteleport/' WHERE company='Teleport'`);
  assert.deepEqual(verifyMatches({ dry: true }).changed.map(c => c.match), ['linkedin', 'conflict']);
  assert.equal(one(`SELECT ab_match FROM companies WHERE name='Lenovo'`).ab_match, 'name', 'dry writes nothing');
  verifyMatches();
  assert.deepEqual(all('SELECT name, ab_match FROM companies ORDER BY id').map(c => c.ab_match), ['linkedin', 'conflict', 'name']);
});

test('saveSalaries: a conflict is stored for a look, never scored', () => {
  run('DELETE FROM companies');
  const id = Number(run(`INSERT INTO companies (name) VALUES ('Teleport')`).lastInsertRowid);
  saveSalaries(id, { match: 'conflict', s: parseSalaries(WHATFIX, 'https://x/teleport-salaries') });
  const co = one('SELECT * FROM companies WHERE id=?', id);
  assert.equal(co.ab_match, 'conflict');
  assert.equal(co.ab_roles, null, 'no salary table written');
  assert.equal(peersFor('Software Engineer', co), null);
  saveSalaries(id, { match: 'none' });
  assert.equal(one('SELECT ab_match FROM companies WHERE id=?', id).ab_match, 'none');
});

// ---------- peers and money ----------

const WF = { name: 'Whatfix', ab_match: 'name', ab_roles: JSON.stringify(parseSalaries(WHATFIX, 'u').roles) };

test('peersFor prices the role, not the company', () => {
  const same = peersFor('Software Engineer', WF);
  assert.equal(same.family, 'same-title peers');
  const fde = peersFor('Forward Deployed Engineer', WF);
  assert.equal(fde.family, 'fde peers', 'Solution Engineer is the FDE family');
  assert.equal(fde.max, 12.6);
  assert.equal(peersFor('Software Engineer', { ...WF, ab_match: 'conflict' }), null);
  assert.equal(peersFor('Software Engineer', { ab_roles: JSON.stringify([{ role: 'Software Engineer', n: 3, min: 10, max: 12 }]) }), null,
               'under 5 salaries is no data');
  assert.equal(peersFor('Software Engineer', null), null);
});

test('peersFor prefers salary rows whose experience range covers 3 years', () => {
  const roles = [{ role: 'Software Engineer', n: 40, min: 8, max: 10, exp_min: 0, exp_max: 2 },
                 { role: 'Software Developer', n: 30, min: 20, max: 24, exp_min: 2, exp_max: 5 }];
  assert.equal(peersFor('Backend Engineer', { ab_roles: JSON.stringify(roles) }).max, 24);
  // Too few covering salaries: keep everything rather than price on three people.
  roles[1].n = 3;
  assert.ok(peersFor('Backend Engineer', { ab_roles: JSON.stringify(roles) }).max < 24);
});

test('Money reads AmbitionBox peers, and a resolved company skips the old company-wide cache', () => {
  const s = settings();
  const m = scoreV2({ company: 'Whatfix', role: 'Forward Deployed Engineer', channel: 'linkedin', discovered_at: '2026-11-02 00:00:00' }, { co: WF, s }).c.money;
  assert.equal(m.conf, 'inferred');
  assert.equal(m.top, 12.6);
  assert.match(m.why[0].t, /AmbitionBox fde peers \(n=67\)/);
  setting('ab:tinyco', JSON.stringify({ min: 30, max: 50, basis: 'ambitionbox: median' }));
  const thin = { name: 'TinyCo', ab_match: 'name', ab_roles: '[]' };
  const m2 = scoreV2({ company: 'TinyCo', role: 'AI Engineer', channel: 'linkedin' }, { co: thin, s: settings() }).c.money;
  assert.doesNotMatch(m2.why[0].t, /company-wide/);
  const m3 = scoreV2({ company: 'TinyCo', role: 'AI Engineer', channel: 'linkedin' }, { co: null, s: settings() }).c.money;
  assert.match(m3.why[0].t, /company-wide/, 'an unresolved company still uses the old cache');
});

// ---------- timing and weights ----------

test('Timing: a posting date is measured; no date is neutral, never fresh', () => {
  const s = settings(), now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const days = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const t = l => scoreV2({ company: 'Acme', role: 'AI Engineer', channel: 'linkedin', ...l }, { co: null, s }).c.timing;
  assert.equal(t({ posted_at: now }).v, 100);
  assert.equal(t({ posted_at: now }).conf, 'measured');
  assert.equal(t({ discovered_at: now }).v, 50, 'found today with no date: neutral, not "posted today"');
  assert.equal(t({ discovered_at: now }).conf, 'unknown');
  assert.equal(t({ discovered_at: days(8.2) }).v, 20, 'the days since we found it are a floor on its age');
  assert.equal(t({ channel: 'referral', discovered_at: days(8) }).v, 80, 'a warm route does not decay');
});

test('the default weights are the code default too', () => {
  assert.deepEqual(WEIGHTS_DEFAULT, { alignment: 25, money: 25, timing: 30, company: 10, route: 10 });
});

// ---------- writes ----------

test('recordRead writes a guest read like a browser read', () => {
  const l = lead({ company: 'KPMG India', role: 'Generative AI Engineer (3-6 Years)' });
  const line = recordRead(l, parseGuest(KPMG), { res: res(), source: 'linkedin-guest' });
  assert.equal(line.verdict, 'pass');
  const r = one('SELECT * FROM leads WHERE id=?', l.id);
  assert.equal(r.jd_status, 'read');
  assert.equal(r.jd_source, 'linkedin-guest');
  assert.equal(r.applicants, 201);
  assert.equal(r.gate_years, '3+ years (JD)');
  assert.equal(r.company_url, 'https://in.linkedin.com/company/kpmgindia');
  assert.ok(Math.abs(ago(r.posted_at) - 3) < 0.01, 'posted 3 days ago');
  assert.equal(JSON.parse(r.score_json).c.alignment.conf, 'measured');
});

test('recordRead: a card date is never overwritten', () => {
  const l = lead({ posted_at: '2026-10-30 10:00:00' });
  recordRead(l, parseGuest(guest({ posted: '1 month ago' })), { res: res(), source: 'linkedin-guest' });
  assert.equal(one('SELECT posted_at FROM leads WHERE id=?', l.id).posted_at, '2026-10-30 10:00:00');
});

test('recordRead: a stated gate over the ceiling drops a cold lead and gates a warm one', () => {
  const page = parseGuest(guest({ body: 'You bring 6+ years building ML systems in production. '.repeat(6) }));
  const cold = lead();
  recordRead(cold, page, { res: res(), ceiling: 4, source: 'linkedin-guest' });
  const c = one('SELECT status, dropped_reason FROM leads WHERE id=?', cold.id);
  assert.equal(c.status, 'dropped');
  assert.match(c.dropped_reason, /experience gate is 6\+ years/);

  const warm = lead({ channel: 'referral' });
  const line = recordRead(warm, page, { res: res(), ceiling: 4, source: 'linkedin-guest' });
  assert.equal(line.verdict, 'gated-warm');
  const w = one('SELECT status, score, gate_years FROM leads WHERE id=?', warm.id);
  assert.equal(w.status, 'new', 'a warm lead is never dropped by a read');
  assert.equal(w.score, 0, 'but it is gated, with its reason');
  assert.equal(w.gate_years, '6+ years (JD)');
});

test('recordRead: closed drops, an unreadable page says so', () => {
  const l = lead();
  recordRead(l, parseGuest(guest({ closed: true })), { res: res(), source: 'linkedin-guest' });
  assert.match(one('SELECT dropped_reason FROM leads WHERE id=?', l.id).dropped_reason, /posting closed/);
  const u = lead();
  recordRead(u, parseGuest(guest({ body: 'tiny' })), { res: res(), source: 'linkedin-guest' });
  const r = one('SELECT jd_status, jd_text FROM leads WHERE id=?', u.id);
  assert.equal(r.jd_status, 'unreadable');
  assert.equal(r.jd_text, null);
});

test('recordRead: dry writes nothing', () => {
  const l = lead();
  recordRead(l, parseGuest(guest({ body: 'You bring 9+ years. '.repeat(20) })), { res: res(), dry: true });
  const r = one('SELECT status, jd_status FROM leads WHERE id=?', l.id);
  assert.equal(r.status, 'new');
  assert.equal(r.jd_status, null);
});

// ---------- queues and a whole run ----------

test('jdQueue: eligible rows only, freshest first, twins retried after 14 days', () => {
  run('DELETE FROM leads');
  const fresh = lead({ posted_at: new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace('T', ' ') });
  const dateless = lead();                                   // found now, no date: placed 5 days back
  const older = lead({ posted_at: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 19).replace('T', ' ') });
  lead({ score: 0 });                                        // gated: its JD changes nothing
  lead({ url: 'https://www.linkedin.com/company/acme/' });   // not a job URL
  lead({ status: 'applied' });
  const recent = lead({ channel: 'indeed', url: 'https://in.indeed.com/x' });
  run(`UPDATE leads SET jd_source='twin:none ' || date('now','-3 days') WHERE id=?`, recent.id);
  const stale = lead({ channel: 'glassdoor', url: 'https://www.glassdoor.co.in/x' });
  run(`UPDATE leads SET jd_source='twin:none ' || date('now','-20 days') WHERE id=?`, stale.id);
  lead({ channel: 'wellfound', url: 'https://wellfound.com/x' });   // the browser's job
  const ids = jdQueue().map(r => r.id);
  assert.deepEqual(ids.slice(0, 2), [fresh.id, older.id], 'dated rows by their date');
  assert.ok(ids.indexOf(dateless.id) > 1, 'a dateless row is placed as 5 days old, after both');
  assert.ok(ids.includes(stale.id) && !ids.includes(recent.id));
  assert.equal(ids.length, 4);
});

test('companyQueue: one entry per company, no agencies or unnamed cards, skips fresh checks', () => {
  run('DELETE FROM leads');
  lead({ company: 'Acme' }); lead({ company: 'Acme' }); lead({ company: '(unknown #4485)' });
  lead({ company: 'TalentCo Staffing' }); lead({ company: 'Whatfix' }); lead({ company: 'Gated Co', score: 0 });
  run(`INSERT INTO companies (name, ab_checked_at, ab_match) VALUES ('Whatfix', datetime('now'), 'name')`);
  companyMap(true);
  assert.deepEqual(companyQueue(), ['Acme']);
});

test('sortBoard end to end: guest read, twin, AmbitionBox, and the sort mark', async () => {
  run('DELETE FROM leads'); run('DELETE FROM companies'); companyMap(true);
  setting('sort_last_at', '2026-11-01 08:00:00');
  const li = lead({ company: 'Whatfix', role: 'Solutions Engineer', url: 'https://www.linkedin.com/jobs/view/1111111111/' });
  const ind = lead({ company: 'Whatfix', role: 'Forward Deployed Engineer', channel: 'indeed', url: 'https://in.indeed.com/x' });
  const card = `<li><div data-entity-urn="urn:li:jobPosting:2222222222"><h3 class="base-search-card__title">Forward Deployed Engineer</h3>
                <h4 class="base-search-card__subtitle"><a>Whatfix</a></h4></div></li>`;
  net(u => /jobPosting\/1111111111/.test(u) ? [200, guest({ org: 'Whatfix', href: 'https://www.linkedin.com/company/whatfix', title: 'Solutions Engineer', posted: '2 hours ago' })]
         : /jobPosting\/2222222222/.test(u) ? [200, guest({ org: 'Whatfix', href: 'https://www.linkedin.com/company/whatfix', title: 'Forward Deployed Engineer' })]
         : /seeMoreJobPostings/.test(u) ? [200, card]
         : /whatfix-salaries/.test(u) ? [200, abPage()] : null);

  const dry = await sortBoard({ dry: true });
  assert.equal(dry.jd.twins, 1);
  assert.equal(one('SELECT jd_status FROM leads WHERE id=?', li.id).jd_status, null, 'dry writes nothing');
  assert.equal(all('SELECT * FROM companies').length, 0);
  assert.equal(setting('sort_last_at'), '2026-11-01 08:00:00');

  const r = await sortBoard({});
  assert.deepEqual(r.stopped, []);
  const a = one('SELECT * FROM leads WHERE id=?', li.id), b = one('SELECT * FROM leads WHERE id=?', ind.id);
  assert.equal(a.jd_source, 'linkedin-guest');
  assert.equal(b.jd_source, 'twin:2222222222');
  assert.ok(Math.abs(ago(a.posted_at) - 2 / 24) < 0.01);
  const co = one(`SELECT * FROM companies WHERE name='Whatfix'`);
  assert.equal(co.ab_match, 'linkedin', 'the JD read gave the company link and the closing check confirmed it');
  assert.match(JSON.parse(b.score_json).c.money.why[0].t, /AmbitionBox fde peers/);
  assert.equal(setting('sort_prev_at'), '2026-11-01 08:00:00');
  assert.notEqual(setting('sort_last_at'), '2026-11-01 08:00:00');

  // A second run has nothing left to do.
  const again = await sortBoard({});
  assert.equal(again.jd.rows, 0);
  assert.equal(again.ab.checked, 0);
});

test('sortBoard: a twin search with no match is remembered, and LinkedIn refusals end the half', async () => {
  run('DELETE FROM leads'); run('DELETE FROM companies'); companyMap(true);
  const g = lead({ company: 'Nowhere', role: 'AI Engineer', channel: 'glassdoor', url: 'https://www.glassdoor.co.in/x' });
  net(u => /seeMoreJobPostings/.test(u) ? [200, '<ul></ul>'] : null);
  await sortBoard({ only: 'twins' });
  assert.match(one('SELECT jd_source FROM leads WHERE id=?', g.id).jd_source, /^twin:none \d{4}-\d\d-\d\d$/);
  assert.equal(jdQueue().length, 0, 'not searched again for 14 days');

  run('DELETE FROM leads');
  for (let i = 0; i < 5; i++) lead({ url: `https://www.linkedin.com/jobs/view/33333333${i}0/` });
  net(() => [429, 'slow down']);
  const r = await sortBoard({ only: 'jd' });
  assert.ok(r.stopped.includes('LinkedIn refused 3 in a row'));
  assert.equal(all(`SELECT * FROM leads WHERE jd_checked_at IS NOT NULL`).length, 0, 'a refusal writes nothing');
});
