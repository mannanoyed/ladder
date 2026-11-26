// ladder/dashboard/db.mjs — schema + connection. Zero dependencies (node:sqlite, Node 24+).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PROFILE } from './profile.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const REPO = dirname(ROOT);
export const DB_PATH = process.env.LADDER_DB || join(ROOT, 'ladder.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  tier        INTEGER,
  city        TEXT,
  lane        TEXT,
  archetype   TEXT,
  employees   TEXT,
  kind        TEXT,               -- product | services
  hires_in_india TEXT,
  careers_url TEXT,
  ats         TEXT,
  comp_signal TEXT,
  status      TEXT,               -- not started | dead | applied | watching
  why         TEXT,
  notes       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id            INTEGER PRIMARY KEY,
  company       TEXT NOT NULL,
  role          TEXT NOT NULL,
  location      TEXT,
  channel       TEXT,                 -- naukri | wellfound | yc | linkedin | email | referral | direct | instahyre | cutshort
  url           TEXT,
  external_id   TEXT,                 -- portal job id
  band_raw      TEXT,
  band_min_lpa  REAL,
  band_max_lpa  REAL,
  gate_years    TEXT,
  status        TEXT NOT NULL DEFAULT 'applied',
                -- queued applied viewed replied screen interview offer rejected withdrawn ghosted
  fit_score     INTEGER,              -- 0-100, my judgement
  applied_at    TEXT,
  last_activity_at TEXT,
  next_action   TEXT,
  next_action_due  TEXT,
  notes         TEXT,
  notes_path    TEXT,                 -- applications/notes/*.md
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
-- distinct requisitions can share company+role+channel (e.g. a pod staffed with 3 identical reqs),
-- so the portal's job id is part of identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_identity
  ON applications(company, role, IFNULL(channel,''), IFNULL(external_id,''));

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  lead_id        INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  ts             TEXT NOT NULL DEFAULT (datetime('now')),
  kind           TEXT NOT NULL,       -- applied viewed reply outreach screen_scheduled interview offer rejection note status_change sweep
  source         TEXT,                -- gmail | naukri | wellfound | yc | linkedin | manual | sweep
  title          TEXT NOT NULL,
  body           TEXT,
  meta_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_app ON events(application_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_ts  ON events(ts DESC);

CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY,
  company       TEXT NOT NULL,
  role          TEXT NOT NULL,
  location      TEXT,
  channel       TEXT,
  url           TEXT,
  band_raw      TEXT,
  band_min_lpa  REAL,
  band_max_lpa  REAL,
  gate_years    TEXT,
  fit_note      TEXT,
  score         INTEGER,              -- 0-100 ranking
  status        TEXT NOT NULL DEFAULT 'new',  -- new shortlisted applied dropped expired
                -- (queued retired 2026-09-12: a draft is a shortlisted lead with an application row)
  dropped_reason TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  source        TEXT,
  notes         TEXT,
  UNIQUE(company, role)
);

CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY,
  ts             TEXT NOT NULL DEFAULT (datetime('now')),
  level          TEXT NOT NULL DEFAULT 'info',   -- info | signal | urgent
  title          TEXT NOT NULL,
  body           TEXT,
  source         TEXT,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  url            TEXT,
  read_at        TEXT,
  acted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts DESC);

CREATE TABLE IF NOT EXISTS syllabus_items (
  id         INTEGER PRIMARY KEY,
  section    TEXT NOT NULL,          -- 'A'
  section_title TEXT,                -- 'DSA patterns'
  title      TEXT NOT NULL,
  detail     TEXT,
  level      TEXT NOT NULL DEFAULT 'gap',  -- gap (warn) | read | solid
  done       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(section, title)
);

CREATE TABLE IF NOT EXISTS study_log (
  id         INTEGER PRIMARY KEY,
  day        TEXT NOT NULL,          -- YYYY-MM-DD
  minutes    INTEGER NOT NULL DEFAULT 0,
  section    TEXT,
  topic      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_study_day ON study_log(day DESC);

CREATE TABLE IF NOT EXISTS calls (
  id             INTEGER PRIMARY KEY,
  ts             TEXT NOT NULL,
  company        TEXT,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  kind           TEXT,               -- screen | tech | hr | manager | founder | other
  with_whom      TEXT,
  outcome        TEXT,               -- pending | advanced | rejected | no_show
  prep_done      INTEGER NOT NULL DEFAULT 0,
  summary        TEXT,
  notes_path     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comp_points (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  company        TEXT,
  kind           TEXT NOT NULL,      -- posted | asked | offered | verbal | market
  lpa_min        REAL,
  lpa_max        REAL,
  currency       TEXT DEFAULT 'INR',
  source         TEXT,
  note           TEXT,
  ts             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sweeps (
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  channels     TEXT,                 -- json array of {channel, ok, note}
  findings     INTEGER DEFAULT 0,
  ok           INTEGER DEFAULT 1,
  brief        TEXT,                 -- the morning brief, markdown
  log          TEXT
);

CREATE TABLE IF NOT EXISTS outbox (
  id             INTEGER PRIMARY KEY,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  kind           TEXT,               -- ack | availability | followup | reply
  channel        TEXT DEFAULT 'gmail',
  to_addr        TEXT,
  subject        TEXT,
  body           TEXT,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'held',  -- held | approved | sent | cancelled
  release_at     TEXT,
  sent_at        TEXT,
  result         TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every time the recommender shows something and every time you answer it. This is the
-- recommender's memory: 'shown' without an answer demotes a card, 'skipped' with a reason teaches
-- it what to stop suggesting. meta_json carries the target's feature snapshot at the time, so the
-- lesson survives the lead being dropped and later archived.
CREATE TABLE IF NOT EXISTS rec_events (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  day        TEXT NOT NULL DEFAULT (date('now')),
  target     TEXT NOT NULL,            -- lead | contact
  target_id  INTEGER NOT NULL,
  action     TEXT NOT NULL,            -- shown | opened | applied | contacted | skipped | snoozed
  reason     TEXT,                     -- skip reason: senior | services | comp | location | notinterested
  meta_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_rec_target ON rec_events(target, target_id, action);
CREATE INDEX IF NOT EXISTS idx_rec_day ON rec_events(day, action);

-- Hand-entered schedule items: calls, interviews, assessment windows, deadlines. Everything the
-- applications table can already answer (a follow-up due date, a thread waiting on a reply) is
-- derived live and never copied here.
CREATE TABLE IF NOT EXISTS agenda (
  id             INTEGER PRIMARY KEY,
  day            TEXT NOT NULL,        -- YYYY-MM-DD
  time           TEXT,                 -- HH:MM, optional
  title          TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'other',  -- call | interview | assessment | deadline | followup | other
  company        TEXT,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  contact_id     INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  notes          TEXT,
  done_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agenda_day ON agenda(day, done_at);

-- People worth a message: recruiters, hiring managers, founders, found on LinkedIn posts, people
-- search and job cards. The profile URL is the identity.
CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  profile_url   TEXT NOT NULL UNIQUE,   -- the identity; /in/<slug> is a routing contract
  headline      TEXT,
  company       TEXT,
  degree        TEXT,                   -- 1st | 2nd | 3rd+
  mutual        TEXT,                   -- named mutual connection, when LinkedIn surfaces one
  kind          TEXT,                   -- recruiter | hiring-manager | employee | founder
  source        TEXT,                   -- 'linkedin-post' | 'linkedin-people' | 'job-card'
  source_url    TEXT,                   -- the post/job it came from
  source_text   TEXT,                   -- verbatim post body; never paraphrased
  lead_id       INTEGER REFERENCES leads(id),
  role_hint     TEXT,                   -- the role they were hiring for
  gate_years    TEXT,
  fit_note      TEXT,
  status        TEXT NOT NULL DEFAULT 'new',  -- new | shortlisted | contacted | replied | dropped
  dropped_reason TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  snoozed_until TEXT, contacted_at TEXT, notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);

-- Expired and dropped leads, moved out of the live table so the board stays fast. upsertLead checks
-- it, so a req judged once is not re-filed as new when a later scrape sees it again.
CREATE TABLE IF NOT EXISTS leads_archive (
  id INT, company TEXT, role TEXT, location TEXT, channel TEXT, url TEXT,
  band_raw TEXT, band_min_lpa REAL, band_max_lpa REAL, gate_years TEXT, fit_note TEXT, score INT,
  status TEXT, dropped_reason TEXT, discovered_at TEXT, source TEXT, notes TEXT, focus INT,
  external_id TEXT, band_basis TEXT, last_seen_at TEXT, posted_at TEXT,
  archived_at TEXT, archived_from TEXT, score_json TEXT, jd_text TEXT, jd_status TEXT,
  jd_checked_at TEXT, applicants INTEGER, company_url TEXT, lane TEXT, lane_why TEXT, jd_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_archive_identity ON leads_archive(company, role);
`;

const DEFAULTS = {
  floor_lpa: '25',
  // Deliberately below floor_lpa: the scraper's job is discovery, not judgement. A posting under
  // the floor can still be a negotiation, not a rejection; filtering it out at scrape time loses it.
  discovery_floor_lpa: '18',
  stretch_lpa: '40',
  current_ctc_lpa: String(PROFILE.currentCtcLpa ?? ''),
  outbox_hold_minutes: '30',
  sprint_start: '2026-09-01',
  sprint_end: '2026-10-31',
  goal_applications: '120',
  goal_replies: '20',
  goal_screens: '10',
  goal_onsites: '4',
  goal_offers: '2',
  goal_study_minutes_per_day: '120',
  owner: PROFILE.owner || '',
  // The daily session. Eight applications and three messages is what fits in the 1-2 hours you
  // have; the recommender serves exactly this many and no more.
  picks_per_day: '8',
  outreach_per_day: '3',
  snooze_days: '3',
  // The expiry window the hunt uses; the recommender reads it to say "expires in 2 days".
  expiry_days: '10',
  // Score model v2 (score.mjs). Five components, weighted; your call, 2026-09-12. The gate ceiling
  // is the standing 3-years-4-max rule; the startup profile is what lifts a Head/Lead title out
  // of the senior-family exclusion.
  w_alignment: '25', w_money: '25', w_timing: '20', w_company: '20', w_route: '10',
  gate_ceiling_years: '3',
  startup_headcount_max: '500',
  funding_recent_months: '24',
  // Enrichment budget per hunt: JD reads and company-page reads.
  enrich_per_hunt: '120',       // was 40 until the 2026-11-02 load-wide change
  enrich_companies_per_hunt: '15',
};

// Columns added after the first tables were created. CREATE TABLE IF NOT EXISTS will not add
// them to an existing db, so they are applied here, guarded and idempotent.
const MIGRATIONS = [
  ['leads', 'focus', 'INTEGER NOT NULL DEFAULT 0'],
  ['applications', 'focus', 'INTEGER NOT NULL DEFAULT 0'],
  ['leads', 'external_id', 'TEXT'],
  // Where a band came from: stated by the employer, observed on AmbitionBox, or inferred.
  // Without this the board cannot show a guess as a guess, and a guess that reads as fact is
  // worse than a blank.
  ['leads', 'band_basis', 'TEXT'],
  ['applications', 'band_basis', 'TEXT'],
  // The curated target list. `target` marks a company you actually chose, as opposed to the 100+
  // rows the sweep has merely seen; `target_tier` is conviction, 1 = already in motion.
  ['companies', 'target', 'INTEGER NOT NULL DEFAULT 0'],
  ['companies', 'target_tier', 'INTEGER'],
  ['companies', 'target_why', 'TEXT'],
  // AmbitionBox, read once and cached on the row. Ratings are what employees say; ab_roles is the
  // part that actually changes a decision — what the company pays *by role*, which is how you
  // find out that a Solutions track pays half what the SDE track does at the same employer.
  ['companies', 'ab_rating', 'REAL'],
  ['companies', 'ab_reviews', 'INTEGER'],
  ['companies', 'ab_salary_rating', 'REAL'],
  ['companies', 'ab_wlb', 'REAL'],
  ['companies', 'ab_job_security', 'REAL'],
  ['companies', 'ab_culture', 'REAL'],
  ['companies', 'ab_promotions', 'REAL'],
  ['companies', 'ab_founded', 'TEXT'],
  ['companies', 'ab_employees_india', 'TEXT'],
  ['companies', 'ab_hq', 'TEXT'],
  ['companies', 'ab_work_policy', 'TEXT'],
  ['companies', 'ab_critical', 'TEXT'],
  ['companies', 'ab_roles', 'TEXT'],          // JSON: [{role, n, min, max}]
  ['companies', 'ab_url', 'TEXT'],
  ['companies', 'ab_checked_at', 'TEXT'],
  // How sure the AmbitionBox page is this company (sweep/ambitionbox.mjs resolveCompany):
  // linkedin | name | conflict | none | blocked. Only linkedin and name are ever scored.
  ['companies', 'ab_match', 'TEXT'],
  ['companies', 'ab_linkedin', 'TEXT'],
  ['companies', 'ab_industry', 'TEXT'],
  ['companies', 'ab_business', 'TEXT'],      // "Product, B2B, SaaS" — shown, never gated on
  // Per-application answers to portal questions that must never be auto-answered generically —
  // "what interests you about this company" above all. JSON: { "<question substring>": "<answer>" }.
  // Stored per row because the honest answer is different for every employer; a single canned
  // reply is exactly the generic note this pipeline exists to avoid.
  ['applications', 'answers', 'TEXT'],
  // Last send verification (sweep/apply.mjs): what the portal showed after a send, and when.
  ['applications', 'send_check', 'TEXT'],
  ['applications', 'send_check_at', 'TEXT'],
  // Recommender state. A snoozed row is hidden from the picks until the date passes; it stays on
  // the board. Set by the Today page, never by the scraper.
  ['leads', 'snoozed_until', 'TEXT'],
  ['contacts', 'snoozed_until', 'TEXT'],
  // Both were added to ladder.db by hand and never declared here, so a fresh database had neither
  // and every scorer and adapter that reads them failed on it (found by test/sort.test.mjs).
  ['leads', 'posted_at', 'TEXT'],
  ['leads', 'last_seen_at', 'TEXT'],
  ['leads_archive', 'posted_at', 'TEXT'],
  ['leads_archive', 'last_seen_at', 'TEXT'],
  ['contacts', 'contacted_at', 'TEXT'],
  ['contacts', 'notes', 'TEXT'],
  // Score model v2 and enrichment (2026-09-12). `score_json` is the five-component breakdown the
  // UI draws; `score` stays the integer the board sorts on. `jd_*` is what the enrichment pass
  // read off the posting itself — machine-owned, never judgement. Mirrored onto `leads_archive`
  // so the SELECT * UNIONs in analytics keep working.
  ['leads', 'score_json', 'TEXT'],
  ['leads', 'jd_text', 'TEXT'],
  ['leads', 'jd_status', 'TEXT'],        // read | unreadable | closed | NULL (never looked)
  ['leads', 'jd_checked_at', 'TEXT'],
  ['leads', 'applicants', 'INTEGER'],
  ['leads', 'company_url', 'TEXT'],
  // Where the JD came from: browser (enrich) | linkedin-guest | twin:<linkedin job id> (sort.mjs).
  ['leads', 'jd_source', 'TEXT'],
  ['leads_archive', 'score_json', 'TEXT'],
  ['leads_archive', 'jd_text', 'TEXT'],
  ['leads_archive', 'jd_status', 'TEXT'],
  ['leads_archive', 'jd_checked_at', 'TEXT'],
  ['leads_archive', 'applicants', 'INTEGER'],
  ['leads_archive', 'company_url', 'TEXT'],
  ['leads_archive', 'jd_source', 'TEXT'],
  // Company facts the Company component reads. Filled by `ladder enrich` from Wellfound / YC /
  // LinkedIn company pages, or by hand with `ladder company set`; `enrich_source` says which.
  ['companies', 'funding_stage', 'TEXT'],      // bootstrapped | seed | series-a … | public | unknown
  ['companies', 'funding_total_usd', 'REAL'],
  ['companies', 'last_round_at', 'TEXT'],      // YYYY-MM
  ['companies', 'founded', 'TEXT'],
  ['companies', 'headcount', 'INTEGER'],
  ['companies', 'yc_batch', 'TEXT'],
  ['companies', 'enrich_source', 'TEXT'],
  ['companies', 'enriched_at', 'TEXT'],
  ['companies', 'enrich_checked_at', 'TEXT'],
  // "Claude has this one." You paste links for me to apply to and then cannot tell, an hour
  // later, which rows you handed over. `claimed_at` is a transient hold, not a status: the lead
  // stays exactly where it was on the board and simply renders highlighted until the claim is
  // released or the lead is promoted to an application.
  ['leads', 'claimed_at', 'TEXT'],
  ['leads', 'claimed_note', 'TEXT'],
  // Load wide, clean after (2026-11-02). `lane` is which of your four lanes clean.mjs put the row
  // in — fde | workflows | generalist | ml | off — and `lane_why` says on what evidence. NULL means
  // not cleaned yet. Mirrored onto the archive for the same SELECT * reason as above.
  ['leads', 'lane', 'TEXT'],
  ['leads', 'lane_why', 'TEXT'],
  ['leads_archive', 'lane', 'TEXT'],
  ['leads_archive', 'lane_why', 'TEXT'],
];

let _db;
export function db() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec(SCHEMA);
  for (const [table, col, type] of MIGRATIONS) {
    // A migration against a table that does not exist yet is skipped rather than aborting boot.
    const cols = _db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.length) continue;
    if (!cols.some(c => c.name === col)) _db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  const ins = _db.prepare('INSERT OR IGNORE INTO kv(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(DEFAULTS)) ins.run(k, v);
  return _db;
}

export function all(sql, ...p) { return db().prepare(sql).all(...p); }
export function one(sql, ...p) { return db().prepare(sql).get(...p); }
export function run(sql, ...p) { return db().prepare(sql).run(...p); }
export function setting(key, val) {
  if (val === undefined) return one('SELECT value FROM kv WHERE key=?', key)?.value;
  run(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`, key, String(val));
  return String(val);
}
export function settings() {
  return Object.fromEntries(all('SELECT key,value FROM kv').map(r => [r.key, r.value]));
}
