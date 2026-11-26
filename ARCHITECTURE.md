# ladder — architecture

**Living document.** Updated whenever behaviour changes. If something here disagrees with the
code, the code is right and this file is a bug.

Last updated: **2026-11-26**

---

## What it is

A local job-search system: it finds jobs, judges them, tracks applications and replies, and shows
the state on a dashboard at `localhost:7777`. Zero npm dependencies — Node 24's `node:sqlite` and
`node:http`, plus a Chrome the sweep drives over the DevTools Protocol.

## The two buttons

This is the whole mental model. Everything else is detail.

| Button | Answers | Runs |
|---|---|---|
| **Run hunt** | *what is out there?* | portals → linkedin (leads) → **expire** → **clean** → reconcile → **enrich** → yc allowance |
| **Run mail sweep** | *did anyone reply?* | Gmail pass → **linkedin messages** |

**Messages live on the mail side, leads live on the hunt side — on every channel.** A reply that
arrives as a LinkedIn DM is a reply, not a lead. This was wrong until 2026-09-09: the LinkedIn DM
read sat inside the hunt, so clicking "Run mail sweep" to check for an answer silently skipped an
entire inbound channel. That is how a warm referral sat unanswered for eight days.

`./ladder` is the CLI behind both. `sweep/run-sweep.mjs --hunt | --mail | --scheduled`.
`./ladder install` sets up launchd: `--scheduled` at 08:00 (`com.ladder.sweep`) and the server,
KeepAlive on 7777. `./ladder install server` installs only the server, for on-demand hunts.

⚠️ The sweep **must** run with `env -u ANTHROPIC_API_KEY`. Any API key makes Claude Code disable
the claude.ai connectors, so Gmail disappears and the mail half goes blind. `run-sweep` strips
them and hard-aborts if Gmail did not connect. It is also a billing boundary — never use the work
key here.

## Data model

`dashboard/ladder.db` (gitignored; `./ladder export` writes a diffable JSON).

| Table | Holds | Identity |
|---|---|---|
| `leads` | supply — a job that exists. Since 09-12 also `score_json` (the five-bar breakdown), `jd_text`, `jd_status`, `jd_checked_at`, `applicants`, `company_url` — machine-owned, filled by enrichment | `(company, role)` |
| `applications` | things that were sent | `(company, role, channel, external_id)` |
| **`contacts`** | **people** — recruiters, hiring managers, warm routes | `profile_url` |
| `events`, `notifications`, `outbox` | history, alerts, held mail | |
| `companies`, `comp_points` | target list + what is known about an employer (`funding_stage`, `funding_total_usd`, `last_round_at`, `founded`, `headcount`, `yc_batch`, `enrich_source`, `enriched_at`, `enrich_checked_at`), salary datapoints | `name` |
| `rec_events`, `agenda` | the recommender's memory; hand-entered dates | |
| `kv` | settings — floors, goals, the v2 weights `w_*`, gate ceiling, enrichment budgets | `key` |
| `syllabus_items`, `study_log` | interview prep | |
| `sweeps` | one row per run, with per-channel outcome | |

**Why `contacts` exists (added 2026-09-09).** A recruiter's "I'm hiring an FDE in Bangalore" post
has no job URL — it has a *person*. `leads` is keyed on company+role+url, so such a post had
nowhere to land and was dropped by construction. That is why the HR-post channel was invisible.

**Lead status:** `new → shortlisted → applied`, or `dropped` (judged out) / `expired` (too old).
`queued` is **not a lead status** (retired 2026-09-12). A draft is a shortlisted lead with an
application row waiting; the lead's status stays judgement.

### The `queued` leak (found 2026-09-10, fixed 2026-09-12)

Outbound automation was removed on 2026-09-10 but its staging rows were not: 70 `applications`
sat at `status='queued'`, none ever sent. `reconcile()` — which runs at the end of every hunt —
read each one as "a draft exists" and re-stamped its lead `queued`. Every lead predicate that
serves Today excludes `queued`, so the ten best rows on the board, the four warm referral routes
among them (OpenAI 95, Cursor 89 ×2, MongoDB 87), were re-hidden on every hunt, and the 09-10
purge's flip of those leads to `shortlisted` was undone the next morning.

**Fix, in three parts.** `ladder drafts resolve [--dry] [--applied id:date]` classifies every
non-archived draft — sent (evidence: `applied_at`, an `applied` event, or named in `--applied`),
duplicate of a sent row (company key + role key equal-or-prefix, so a ` | India` suffix still
matches), ambiguous (a receipt or note event but no send evidence: printed, untouched), unsent
(everything else) — then archives the unsent and duplicate ones with a "draft never sent" event
and flips the leads still at `queued`: warm routes → `shortlisted`, the rest → `new`. `reconcile()`
lost its `queued` branch and now returns `queuedLeads`, warning on stderr when it is non-zero.
And `queued` is out of every **leads** predicate (`insights`, `lib`, `server`, `analytics`, `cli`,
`sweep/apply`); `apply.mjs` writes `shortlisted` where it wrote `queued`. Application-side
predicates (`SENT`, `ycAllowance`) still name `queued` — it remains a valid application status on
archived rows.

Run 2026-09-12: 0 sent, 1 duplicate (#65 Vela = sent #45), 1 ambiguous (#68 Salesforce, whose
only evidence is a Workday receipt for a role not on the board), 68 unsent → 69 archived. Leads
845 open (709 new, 136 shortlisted), 0 queued; two reconciles later, still 0. **#68 was archived
later the same day on your decision** — the receipt was for *Lead Technical Product Owner*, not
the FDE draft — with the same note event as the rest, so `scoreboard.queued` reads 0.

### Company cooldown (added 2026-09-12)

Pressing **Applied** on one req never touched the same company's other reqs, so a company came
back the next morning under a different title or portal (UnitedHealth ×3, MongoDB's Senior FDE via
Naukri the day after the ABX send) and read as "the board lost my click". `reconcile()` now
**snoozes every live lead at a company with a non-withdrawn application in the last 30 days** to
`applied_at + 30d`, appending `| cooldown: applied to <role> on <date>` to `fit_note`. Snoozed,
not dropped: if the first application dies the siblings surface again. Exempt: `focus=1` and
warm channels (referral / direct / email / inbound). Reported as `siblingsSnoozed`.

The Skip menu also gained **Expired / no apply** the same day: it records the lead as `expired`
rather than `dropped`, so a dead posting never teaches the recommender that the company or title
was unwanted.

### `leads_archive` (added 2026-09-10)

Dead leads move out of `leads` instead of accumulating in it. The purge moved 1,121 rows —
540 expired, 495 dropped, 86 cold `queued` — leaving 828 live (630 new, 158 shortlisted, 40
applied). The 13 `queued` leads on a **warm route became `shortlisted`**: a referral does not
decay, and those are the highest-scoring leads on the board (OpenAI 95, Harvey 92, MongoDB 90,
Cursor 89).

**Nothing is deleted; `dropped_reason` still says why.** The archive keeps every column plus
`archived_at` and `archived_from`.

⚠️ **`upsertLead` must check the archive before inserting.** The expired rows are the only record
that a req was already seen and judged, so without that check a purge is self-defeating: the next
hunt re-inserts stale postings as brand-new leads with today's `discovered_at`, age evidence gone
and every drop reason re-litigated. A buried lead is only resurrected when the card states a
`posted_at` newer than the archived one — the sole honest evidence of a genuinely new req.

Analytics read **both tables**: `everFound` spans them (or purging would flatter the funnel by
hiding every lead that died) and `leadDeaths()` UNIONs them.

### Lead expiry — a probability test, not a liveness test

`./ladder expire [--days 10] [--dry]`, runs inside every hunt.

By the time a req is ~10 days old the recruiter has worked through a stack of applicants, so a
late application converts badly **whether or not the posting is still up**. With ~2,500 results on
a single Wellfound search, supply is not the constraint — attention is.

- Ages from **`posted_at`** when the card stated one, `discovered_at` only as fallback. A req
  scraped today that went up three weeks ago is cold on day one and must not get a fresh window.
- **Exempt:** `focus=1` (your own picks), anything applied/queued, and **warm routes** —
  referral / direct / email / inbound / InMail. Those do not decay; a person who introduced you
  three weeks ago is still a person.
- Sets `status='expired'` with the reason. The board clears, the record survives.

## Discovery

`sweep/portals.mjs` — ten channels, run **in `PORTALS` key order**, 150s budget each, sequential.

```
wellfound → yc-waas → linkedin → hn → indeed → glassdoor → instahyre → hirist → naukri → foundit
```

**Order is run order and it matters.** Naukri sat first, burned its full budget failing every
morning, and on bad days wedged the browser for everything behind it — 08:00 was reaching three
channels of ten. Weakest two now run last, where failing costs only their own budget.
Nothing is removed except Internshala. **Standing rule: keep every platform, optimise one at a
time.**

`linkedin` is in `PORTALS` as `authOnly: true` — kept so `browser check|login` works, but it does
not scrape; `sweep/linkedin.mjs` owns it.

### Scraper invariants (each one paid for by a real bug)

- **The scraper fills blanks, it never overwrites.** `status`, `dropped_reason`, `fit_note` and
  `notes` are judgement. A nightly scrape once replaced a "BLOCKED — do not send" note with raw
  card text. Band/location/gate may refresh.
- **Scope to the card, never `document.body`.** Page-level reads bleed one row's salary and
  alumni count onto every other row.
- **"We could not look" and "there is nothing there" must never render the same.**
- Unknown comp is **kept**. An hourly rate is never an annual band. A rupee band beats a dollar
  one when a card carries both.
- One employer capped at 3 **in-lane** leads per sweep (off-lane rows do not use up the slots).

### Load wide, clean after (`lane.mjs` + `clean.mjs`, 2026-11-02)

The scrapers refuse only **certain junk** (`isJunkTitle`: intern, sales, trainer, QA, embedded…).
Everything else loads, and the `clean` step of the hunt decides, with the reason on the row:

1. **Lane** (`laneOf`): `fde` | `workflows` | `generalist` | `ml` | `off`, from the title, the
   company name, the card / JD text and the company's own description (`companies.lane`). Stored
   in `leads.lane` + `leads.lane_why`. Off-lane rows are `dropped` with `clean: off-lane — <why>`.
   Validated against your 1,100 sent applications: 88% land in a lane; the rest are generic SWE
   titles with no AI evidence, which you no longer applies to.
2. **Seen before**: a req already dropped / expired / judged, back under another spelling
   ("Weekday AI (YC W21)" vs "Weekday AI"), inherits the old verdict — `clean: seen before (#id…)`.
   `upsertLead` and the archive check are byte-exact on (company, role) and missed 37 of 493 on the
   first night. An expired req with a newer `posted_at` is a repost and stays.
3. **Dedupe** across channels: same `normKey(company)` + `roleKey(role)`, best row kept
   (claimed → pinned → warm → JD read → score → oldest). `roleKey` keeps parentheticals and req
   ids: "(3-6 Years)" vs "(6-10 Years)" and GlobalLogic's IRC-numbered FDE reqs are different jobs.

Exempt from every drop: pinned, claimed, and person routes (referral / inbound / direct) — not
LinkedIn's alumni card flag. **Undo:** `ladder clean undo --rule off-lane|duplicate|seen before`
(restored rows are never re-dropped). After editing `lane.mjs`: `ladder clean recheck`. The Leads
tab filters by lane; Stats files the drops under "Not in your lanes".

The old `LANE` regex lost every "Forward Deployment Engineer" and every backend role at an
AI-native startup. It survives in `portals.mjs` only for probes.

## Per-platform state

| Platform | State | Notes |
|---|---|---|
| **LinkedIn** | **done 2026-09-09** | 4 surfaces; see `sweep/LINKEDIN.md` + memory |
| **Wellfound** | **done 2026-09-09** | paginated + city rotation + card-gate filter |
| yc-waas | untouched | scrolls with the synthetic method that provably does nothing |
| indeed, glassdoor, instahyre, hirist, hn | untouched | not yet reviewed |
| naukri, foundit | untouched, deprioritised in run order | |
| internshala | **removed** | 41 leads, 2 above floor, 0 sent |

### LinkedIn (`sweep/linkedin.mjs`) — done

`./ladder linkedin --only collections,search,posts,messages [--pages N] [--q "one query"]`

Four surfaces: **collections** (10, depth per collection in `COLLECTIONS`: top-applicant,
hiring-in-network, recommended, top-choice, easy-apply, remote-jobs, hybrid, small-business,
career-growth, work-life-balance) · **AI job search** (17 queries in `SEARCH_LANES`, grouped
fde / workflows / generalist / ml; `--backfill` = past week × 4 pages, default = 3 days × 3) ·
**posts** → `contacts` + embedded reqs → `leads` · **messages**.

**2026-11-02 rebuild** (audit in `sweep/EXTRACTION-PLAN.md`): classic `/jobs/search/` now
redirects to AI search, whose cards carry the job id in
`componentkey="job-card-component-ref-<id>"` and no `/jobs/view/` link, so the old reader got 1
card per query. **Promoted is kept and flagged** (fit note, scorer −10), never dropped: dropping
it lost 40 of 44 in-lane "Top job picks". Cards are harvested in 500px wheel steps (1200px skipped
5–6 of every 25). An unparsed company is stored as `(unknown #<jobId>)`, never bare `(unknown)`,
because UNIQUE(company, role) merged different employers into one row; enrichment names it.

Three defects, each A/B tested — **check all three on every new platform, but assume none of
them**:
1. **Synthetic scroll does nothing.** Same query: 9 cards under `window.scrollBy`, **106** under a
   real wheel. Fixed with `page.wheelUntilStable()` (CDP `Input.dispatchMouseEvent mouseWheel`).
   Terminate on a **stable count**, never on an end-of-results marker — LinkedIn renders that from
   first paint.
2. **Job search served ads first** (classic search, retired). Without `sortBy=DD`: **19 of 21
   cards `Promoted`**, none matching the query. AI search showed 0 Promoted in 500 cards.
3. **Two-pane geometry.** Job views scroll the list at x≈149–652, detail at x≈653+. Wheeling at
   the default x=700 scrolled the detail pane, so collections stopped at 7 cards and reported
   "stable". Job surfaces need `x: 400`.

**Content search throttles by lying** — after ~6 heavy queries it returns a clean "No results
found", identical to a genuinely empty query. Guarded by a canary; never record a zero as supply.

### Wellfound (`sweep/portals.mjs`, the `wellfound` entry) — done

**None of the LinkedIn defects apply.** No lazy loading (cold = after-scrollBy = after-wheel,
every time) and no ads on the public role pages (0 of 49), though `PROMOTED` exists on the
logged-in `/jobs` view we do not scrape. **Assume nothing across platforms; measure each one.**

**Its defect was pagination.** `2495 results total · Page 1 of 53`, and we read page 1 — ~2% of
the platform, on the channel with the best strong-lead ratio on the board. `?page=N` returns
disjoint sets of ~47. Now 35 URLs at a `budgetMs: 480_000` per-portal budget (the flat 150s cut it
off mid-first-search and reported "budget exhausted" as though the platform were empty).

**City slugs are their own corpora, not a re-listing of `/india`.** Overlap against india page 1:
gurgaon **0/29**, bangalore 14/42, pune 12/39, hyderabad 8/39. Rotating cities is real supply.
*(Rotating deeper page ranges instead was worse: page 1 runs to a
14-day median and pages 6+ to ~30, which the 10-day expiry kills on arrival.)*

⚠️ **Only slugs Wellfound recognises.** `delhi`, `ncr` and `remote` are NOT recognised: the site
does not 404, it **redirects to the bare `/role/<role>` page** and serves an unfiltered worldwide
board — 14,206 rows whose first cards are Dubai, Riyadh, New York, San Francisco. The guard tests
the **landed path**: valid pages stay on `/role/l/…` or `/role/r/…`; a rejected slug lands on
`/role/<role>`. Two earlier guards failed and let 26 global rows onto the board — whole-page
"Jobs in" text (the fallback matches it via footer links) and an h1 check gated on `/role/l/`
(the redirect means the path no longer contains it, so the gate never ran). Never add a slug
without running the guard test.

**The experience gate is on the card 73% of the time** ("4 years of exp"), so out-of-range roles
are dropped at scrape time by `gateMinYears()` against `GATE_CEILING = 4` — measured: 1,067
scanned → 273 in lane, **135 dropped on a stated gate**. On LinkedIn the same fact only existed in
the JD body and cost 317 page-opens to recover. An unstated gate is never dropped; it is a
question, not a pass.

**The apply form's location gate is answerable, not a wall (2026-09-25).** *"This job does not
support the locations on your profile"* renders the whole form with every field **disabled** until
a two-part qualification is answered: a radio (`qualification.location.action` = `living_in` /
`relocate_to`) plus a react-select city. The old liveness check looked only at `[name="userNote"]`,
saw it disabled, and reported the listing as closed — which is how a role in the user's own city was
refused as out of reach. `resolveLocation()` answers it: `living_in` + `profile.homeCity` first because
it is true, `relocate_to` + the job's city only when staying put cannot clear it, and the result
says which was used. The option commits on **mousedown**, not `click()`. Two adjacent traps: the
react-select search box has `name=""` and reads as an empty question if it reaches the planner, and
plenty of companies ship **no cover-letter box at all** — their "What interests you about working
for this company?" *is* the application, so the whole argument has to go in `applications.answers`.

**Posting age is on the card and is now captured** (`agoToTimestamp` → `posted_at`). Without it
every Wellfound lead aged from `discovered_at`, so a listing that went up two months ago got a
full fresh expiry window — on the channel where that matters most. Bands stay sparse (14%) and
dirty (`₹10,000 – ₹35,000` and USD both appear).

## Judging — score model v2 (`score.mjs`, 2026-09-12)

Every live lead gets **five components, each 0–100 with a confidence** (`measured` / `inferred`
/ `unknown`) and its own signed "why" chips. `potential = Σ wᵢ·cᵢ / Σ wᵢ`, then small title and
location adjustments, then — only in the recommender — shown-decay and memory. The weights are
your (kv-tunable, and `WEIGHTS_DEFAULT` in code): **Timing 30 · Money 25 · Alignment 25 · Company 10 ·
Route 10** since 2026-11-02 (was 20/25/25/20/10). Date went up because "date of job posting is v
imp"; Company came down because AmbitionBox now prices Money, which carries most of that signal. The full breakdown is stored as `leads.score_json` so the UI can draw the five bars;
`leads.score` stays the integer the board sorts on.

| Component | Measured from | Inferred from | Unknown |
|---|---|---|---|
| **Alignment** | `jd_text` term coverage against `profile.mjs` (the resume's skill rows + lane vocabulary), minus named gaps (K8s −10, Java −8, Go, Scala, Spark, .NET, Rust; cap −25) | title (FDE / solutions 80, AI / agent 65, generic 45, non-engineering 20) + card text hits | — |
| **Money** | the stated band (India-adjusted USD as before) against floor ₹25L / stretch ₹40L | AmbitionBox **peers** — `peersFor()` in `ask.mjs`: the same title, else the same family (fde / ai / swe), ≥ 5 salaries, rows whose experience range covers 3 years preferred, typical max (since 2026-11-02; it used to be the median of every role on the page) → kv `ab:<slug>` only for a company the resolver has not looked at → `estimateBand()`. A stored `(est)` band is re-estimated live; an `unknown`-employer estimate is no information | 50 (your call, 2026-11-02: neutral, not a penalty) |
| **Timing** | `posted_at` age curve (0d = 100 → 10d = 0) + `top-applicant` +15, actively reviewing +10, `applicants` ≤25 +15 / >100 −15, early applicant +10, Promoted −10. **Warm routes fixed 80** — a person does not decay | — | no `posted_at`: **50, as if 5 days old**, and lower once the days since `discovered_at` pass that (since 2026-11-02; before, a backfill row found tonight scored "posted today") |
| **Company** | a `companies` row: services 10 · target +20 (tier 1 +25) · funded-startup profile (10–500 heads AND seed–C / YC / round ≤ 24 mo) +25 · YC batch +15 · >5000 heads −10 · AmbitionBox ±5 | `classifyEmployer()` (global 70, scale-up 65, startup tells 60), `channel = yc-waas` +15, `Series X` in the card +10 | 50, chip `unverified` |
| **Route** | referral 100 · inbound / InMail 95 · direct / email 85 · hiring-in-network 70 · recruiter (incl. Naukri `gmail-inbound-*` invites) 65 · LinkedIn cold 40 · Wellfound / YC / HN form 35 · aggregators 30 · alumni / connections +15 | — | — |

**Hard gates exclude rather than score.** A gated lead scores **0** and keeps its breakdown, so the
Leads tab can show what it would have been and why it is out: stated minimum years > 3, i.e. 4+ is out (kv
`gate_ceiling_years`) · services / staffing / agency (by name, `companies.kind`, or the staffing
regex) · intern title · **Staff / Principal / Head / Director / VP title — unless the company is a
startup or the title says "founding"** (startups hand those titles to 3-year people) · abroad with
no remote · past the expiry window on a cold route · a stated band under the ₹18L discovery floor
· `jd_status = closed`. "Senior" is a **−10 penalty**, "Lead" a soft −5; they are stretches, not
different jobs.

`isStartup()`: a `companies` row with headcount ≤ 500 (kv `startup_headcount_max`) or a seed–C
stage or a YC batch; else `channel` yc / yc-waas, a founding title, startup tells in the card, or a
Wellfound card with equity.

**The v1 spread and the v2 spread.** v1 put 1 lead at 80+ and 684 under 50; v2 on the same 845
live leads: 651 eligible, 194 gated (80 expired, 71 services, 57 years, 28 senior-family, 3 floor,
1 intern), max 84, p99 79, p95 68, median 57. Every threshold that means "a strong lead" reads
`CUTS` in `lib.mjs` — **prime ≥ 76 (12 rows), strong ≥ 70 (26 rows)** — the hunt's `good` count,
the new-lead notification, `tierOf`, and the agenda's expiring rule. Re-derive them from
`./ladder score --dry` whenever the scorer changes.

**Confidence is honest, not decorative.** On 2026-09-12, 0 leads scored `measured` overall, 127
`inferred`, 718 `unknown`, and only 34 of 845 had a `companies` row. The Company bar reads
`unverified` for most rows until enrichment fills it. That is the state of knowledge, not a bug.

**Standing gates unchanged:** experience ceiling **3 years, 4 absolute max**. **Product companies
only.** Floor ₹18L to discover, ₹25L to apply, ₹40L stretch.

### Enrichment (`sweep/enrich.mjs`, 2026-09-12)

Alignment is `unknown` until the JD has been read and Company is `unverified` until someone looks
the employer up; both are one page-open away, so every hunt opens them — after reconcile, before
the YC check, in the sweep's own Chrome, under a 12-minute hard timeout and its own budgets (40
leads / 6 min, 15 companies / 3 min, kv `enrich_per_hunt`, `enrich_companies_per_hunt`). It may
fail; the hunt may not: one try/catch per page.

**Leads.** Candidates are live, never read (or `unreadable` > 30 days ago), with a real URL — which
since 2026-09-13 includes foundit `/job/<slug>-<id>` permalinks (the card's `.cardContainer` id is the
job id; before that every foundit URL was a title+employer *search* that returned no results, and
43 live leads were hand-marked expired for it) — ordered by potential so a Staff title at an unknown company gets
its startup check first. LinkedIn pages go through `JD_JS` (detail pane only — see LINKEDIN.md
finding 11 for the applicant wording and the rail trap); everything else through a generic
smallest-block-holding-half-the-text extractor, ≤ 6000 chars, with one extra 4s wait for
client-rendered ATS pages. Writes **machine-owned columns only**: `jd_text`, `jd_status` (`read` ·
`unreadable` · `closed` · `agency`), `jd_checked_at`, `applicants`, and `COALESCE` fills on
`company_url`, `gate_years` (a "not stated" placeholder counts as blank), `posted_at`. Then
`persistScore(scoreV2(row))`.

`judgeJD()` (pure, shared with `gateCheck`) decides: **closed** or **stated years > ceiling →
`dropped`** with a reason phrased for the Stats page's death rules — **on cold routes only**. On a
warm route (referral / direct / inbound) the same facts become a *gate*: the row scores 0 with
its reason and stays visible and reversible, because the person who opened the door can name the
live req — OpenAI #41 says "8+ years of technical consulting" and was a referral. **agency** is a
gate too, never a drop. An unreadable page is `jd_status='unreadable'` ("we could not look"),
scored exactly as before, retried after 30 days. "Over 100 people clicked apply" is stored as 101.

**Companies.** By `company_url` host, for companies with a live lead and no `enrich_checked_at`:
Wellfound `/company/<slug>` (size, stage, founded, raised), YC `/companies/<slug>` (batch, team
size), LinkedIn `/company/<slug>/about/` (size range → upper bound, founded). A stage word only
counts next to a funding label or as "Series X" — Google's page says "acquired" about other
companies. `setCompanyFacts()` **fills blanks**; a `manual:` source overwrites. **No general web search in
the hunt** (AmbitionBox's own search, in the sort step, is the one exception). The manual hook is `./ladder company set "<name>" --stage --raised --round --headcount
--yc --founded --kind --source`, which rescores that company's leads; verified: a stage on a
200-person row moved its lead's Company bar 50 → 75.

**Scrape-time captures (free):** YC cards now keep `yc_batch` (routed to `companies`) and the
company link; Wellfound cards keep the company link; foundit's "Early Applicant" flag lands in the
fit note where Timing reads it.

First run 2026-09-12: 40 candidates, 39 read, 1 unreadable, 3 dropped on a stated gate (2 after
the warm rule restored OpenAI), 0 agency; 7 companies filled from LinkedIn. 292 s.

`./ladder score [--dry] [--limit N] [--id N]` prints the histogram by decile, gated counts per gate,
and the top 15 with A M T C R columns; `./ladder score explain <id>` is the full breakdown.
`node profile.mjs --check` greps `resume/resume.tex` for skill tokens `SKILLS` has no regex for.

## Sorting — the second step (`sweep/sort.mjs`, 2026-11-02)

Extraction loads wide and stays as it is; **sort** runs after it and makes the order earned. On
2026-11-02 the 546 eligible rows were ranked on almost nothing: Money unknown on 91%, Company on
77%, the JD read on 18%, and 226 rows with no posting date aging from the night we found them.
You work the board down to about 55 and wants the best of a hunt first, so the top has to be
right the moment a hunt ends.

**Plain HTTP, no browser, never your account.** Two workers run side by side, each freshest first
(a dateless row is placed as 5 days old, as the scorer counts it), because a fresh lead loses
value fastest:

| Worker | Source | What it writes |
|---|---|---|
| LinkedIn | `linkedin.com/jobs-guest/jobs/api/jobPosting/<id>`, public. `parseGuest()` returns `JD_JS`'s shape, so `enrich.recordRead()` (shared with the browser pass) judges and writes it: same drops, gates, `COALESCE` rules | `jd_text`, `jd_status`, `jd_source=linkedin-guest`, `posted_at` (card date never overwritten), `applicants`, `company_url`, `gate_years` — the title counts (KPMG's "(3-6 Years)") |
| — twins | Indeed (401) and Glassdoor (403) refuse plain HTTP. LinkedIn's public search for "<role> <company>"; `pickTwin()` accepts only an exact company key and `roleKey` | the same, `jd_source=twin:<job id>`; no match → `twin:none <date>`, searched again after 14 days |
| AmbitionBox | `sweep/ambitionbox.mjs`: slug guess → `/api/v2/search` (exact `abKey` only) → `/salaries/<slug>-salaries`, whose `__NEXT_DATA__` JSON holds the role table (typical and full range, experience range, n), ratings, India headcount, industry, product/services and the company's LinkedIn link | `companies.ab_*`, `ab_match` = `linkedin` (link agrees) · `name` · `conflict` (name twin, someone else's link — stored, never scored) · `none` · `blocked` |

At the end `verifyMatches()` settles `name` matches against links the JD reads found in the same
run (local, no request): the two workers race, so a company is often priced before its link is
known. LinkedIn slugs may differ only by a country or corporate suffix (`lenovo` / `lenovoin`).

**Pacing and refusal.** LinkedIn: one request at a time, 3–4.5s apart, a 429 waits 15s then 60s
(measured 2026-11-02: 15 of 16 at a 3–6s gap, the one 429 cleared on the next request); three
refusals in a row end that worker and leave the rows for the browser pass. AmbitionBox: 1–2.5s
apart, three refusals end it. A refusal is never written as "nothing there". Every 25 rows the
board is rescored and `.bump` touched, so the open dashboard re-sorts during the run.

**Where it runs.** In the hunt after reconcile and before enrich (`--- sort ---`, kv
`sort_budget_min` 20, a 30-minute cap), so the browser pass only gets what plain HTTP cannot
reach. By hand: `./ladder sort [--dry] [--limit N] [--ids 1,2] [--only jd|twins|ab] [--budget M]`;
`--dry` prints each row's `old → new` score and writes nothing. A whole-board run moves kv
`sort_prev_at` / `sort_last_at`, the mark the board's "new since the last sort" reads.

**AmbitionBox search is the one web lookup the hunt makes** (2026-11-02). It is a
named site's own search box, cached 30 days per company; the "no general web search" rule for
company facts stands.

Tests: `node --test dashboard/test/sort.test.mjs` — 27 cases against a throwaway DB and a stubbed
fetch (parsers on a real guest page and a trimmed AmbitionBox page, the matching rules, the score
changes, the writes, a whole run, refusals). They found `posted_at` and `last_seen_at` were never
declared in `db.mjs`: a fresh database had neither.

## Applying — by hand, on every channel (changed 2026-09-10)

**Nothing in this system sends an application.** Outbound automation is retired: the Queue tab,
`POST /api/queue/check`, `POST /api/queue/send-ready` and `POST /api/apply` are all gone from the
server. Real supply was never the bottleneck and per-portal ban risk always was, so the machine's
job is now discovery, ranking and inbound tracking — the send is a browser tab and a human.

`sweep/apply.mjs` still exists and still drives `./ladder apply` from the CLI, gates included: a
**fact gate** (blocks `profile.forbiddenClaims`) and a **style gate** (`BANNED_STYLE`: em dashes,
filler, volunteered gaps). It is no longer reachable from the dashboard.

The board's whole outbound path is one button: **Applied** on a lead row posts
`/api/lead/:id {promote:1}`, which creates the application row, dates it today and moves the lead
to stage `applied`. From there a `<select>` moves it through the funnel by hand.

### The Ask column — expected CTC per row (`ask.mjs`, 2026-09-29)

Every lead and application row carries `ask`: the figure to type into an expected-CTC field, where
it came from, and whether the role can reach the floor. It is a suggestion; `apply.mjs` still
escalates every salary question. **It is anchored to the role, not to `floor_lpa`:** the field is
a filter before it is a negotiation, so an ask above the band gets screened out unread. A role
that cannot reach the floor is flagged (gold ↓). That flag is a decision about whether to apply,
not a reason to inflate the number.

Sources in order, and the first one with data wins: the **posted** band (75% of the way up, never
above the top) → **peers**, the AmbitionBox per-role table (`companies.ab_roles`): the same title
first, then the same family (fde / ai / swe), then any engineering role, at least 5 salaries, senior
titles at half weight → **company**, the AmbitionBox company-wide median (`kv ab:*`) → **model**,
`estimateBand()` at 60% up. Otherwise it returns null, and the column says so.

`./ladder ask <app|lead>` prints the long form: the peer roles used, the AmbitionBox URL (names
collide: a logistics "Teleport" is not the SSH one) and what you have typed before (`comp_points`).
`./ladder ask refresh [--limit N]` pulls role tables for the companies in play: replied or screened
threads first, then the newest sends, then leads scoring 50+. It skips anything checked in the last
30 days and anything that looks like an agency.

**The pipeline never sends a connection request, InMail, or DM.** It ends at putting a named
person and a drafted reason in front of you. The account is what the referral route depends on.

## The dashboard — six pages

Rebuilt 2026-09-10, down from eight tabs and then back out to five; **split to six on 2026-09-12**.
The old board modelled a machine that applied for you; it does not, so the surface that implied it
is gone. What replaced it is a page you can finish: **Today** is one session's work, already
chosen. Leads and Applications were one `funnel` table until 09-12 — a lead is supply the hunt
found and an application is a thing you sent, and a `scraped` stage pill was the only tell between
the two kinds of row.

| Page | Answers | Holds |
|---|---|---|
| **Today** | *what do I do in the next hour?* | session meter, the agenda, 8 picks with reasons and `A M T C R` mini chips, 3 people |
| **Leads** | *what is out there, and how good is it?* | every live lead ranked by potential: employer badge, money (`~` inferred), timing (`3d · <25 appl.`), alignment %; click a score for the five-bar drawer; filters channel / min / verified-only / show-gated |
| **Applications** | *what did I send, and where is it?* | threads waiting on a reply, the stage strip, search, per-row notes and next actions |
| **People** | *who can I talk to?* | the 196 ranked contacts, filterable, status editable |
| **Stats** | *what is the inbound telling me?* | four headline numbers, forecast, conversion, routes — the rest collapsed |
| **Roadmap** | *am I on track for the runway?* | a checklist against the notice period |

Default tab is `today`; the hash routes (`#leads`, `#apps`, …) and `1`–`6` switch tabs; `/`
focuses the lead search; `#board` redirects to `#leads`. The payload keeps the `apps` key for
application *insights* (read in three places); the two page blocks are `leads` and `applications`.

**Leads** (`insights.leadRows()`) reads stored `score_json` only — it is served on every SSE tick
and must never write or rank; `picks()` is the one thing that stamps `shown`. Eligible rows first
by potential, gated rows last with their reason, snoozed rows shown (this is where a snoozed lead
is unsnoozed). Wire rows are lean (~900 KB for 845 leads); the drawer fetches
`GET /api/row/lead/:id` for the breakdown, the fit note and the JD status. **Applied** on a lead
posts `/api/rec {applied}`, which promotes it to an application, records the answer for the
recommender's memory, and moves the row across on the next tick. Skip, Snooze and ☆ are the
Today page's own controls.

**Applications** (`insights.appRows()`) — stages 2–5 plus the `closed` pile that is never
deleted; `fit_score` is your own judgement and the only potential shown. `closed` sorts *below*
every live stage — ranking it by depth put three dead Wellfound rows at the head of the board.

`insights.mjs` builds both row sets, the Stats recommendations and the roadmap. Its
recommendations are **derived, never hardcoded** — each rule reads the DB and only fires with a
figure attached. `recommend.mjs` and `today.mjs` build the Today and People pages.

### The recommender (`recommend.mjs`, added 2026-09-10)

The board holds ~630 open leads and you send about three a day, and **52% of every lead that ever
died, died of age rather than judgement**. Ranking everything was never the problem; choosing
eight was. Two layers sit on top of the stored v2 potential:

1. **Shown.** A card shown for days without an answer sinks (4 points a day, 8 for a warm route,
   which decays at half speed because it is still the best thing on the board when ignored). A
   lead already **past** the window is excluded outright — otherwise a 14-day-old row computes
   `expiresIn: 0` and advertises itself as "expires today", a deadline four days in the past.
   *(Time, title, gate and location moved into score v2 on 2026-09-12; the recommender used to
   re-add its own versions on top of the v1 score and would have double-counted them.)*
2. **Memory.** `rec_events` is the memory. Every answer records a **feature snapshot**, so the
   lesson survives the lead being dropped and later archived. Two skips of a feature is the
   minimum before it counts — one skip is a mood — and the total adjustment is capped at −20/+10
   so memory can reorder the board but never bury a 90-point lead under a 40.

**Everything it does is visible.** A pick carries its `why` chips — the six strongest component
reasons from the scorer (`+50 referral`, `+35 ~₹55L est. global — above stretch`), then
`−4 shown 1 day, untouched`, `you skipped 3 senior-titled roles` — with the sign as the only
coloured glyph. A recommender that moves for reasons nobody can see is a recommender nobody
should trust.

**A skip is a drop with a reason** (`dropped_reason` starts `skipped from Today:`); a snooze is a
date on the row, not a deletion. Each target is stamped `shown` **once per day** no matter how
many times the page is served, so opening the dashboard ten times is one day of being ignored.
Picks are **diversified**: one per company, no channel above 40% of the set — eight different
doors, not the top eight rows of one Wellfound search.

`today.mjs` is the agenda. Almost everything dated is already in the database and just needed
collecting — a thread that replied, a follow-up with a due date, a strong lead about to expire, a
YC slot coming back — so those are **derived on every read and can never go stale**. The `agenda`
table holds only what no query can know: an interview at 4pm, an assessment window, a call. Those
are the only rows that get ticked by hand. The expiring rule is capped at **five leads at fit ≥ 66
inside two days**; at ≥ 60 and three days it fired on 46 rows and buried the interviews under it,
and an agenda you scroll is an agenda you stop reading.

Dropped from the UI but **kept on disk and in the CLI**: study log and syllabus, comp datapoints
(now read only to generate recommendations), calls, the kit file browser, the outbox.

## Files

```
ladder/
├── README.md            <- what it is, setup, using it with Claude
├── ARCHITECTURE.md      <- this file
├── CLAUDE.md            <- orientation for a Claude Code session in this repo
└── dashboard/
    ├── ladder           <- CLI wrapper
    ├── profile.mjs      <- profile loader + termHits; --check vs the resume
    ├── profile.example.mjs  <- the profile template (yours: profile.local.mjs, gitignored)
    ├── cli.mjs          <- commands: portals, linkedin, expire, ingest, reconcile, brief…
    ├── db.mjs           <- schema, kv settings, ladder.db (gitignored)
    ├── lib.mjs          <- scoreLead (→ score.mjs), CUTS, expireLeads, scoreboard, reconcile
    ├── score.mjs        <- score model v2: components, gates, scoreV2, persistScore, summary
    ├── lane.mjs clean.mjs  <- load wide, clean after: lanes and drop reasons
    ├── insights.mjs     <- leadRows(), appRows(), recommendations(), roadmap()
    ├── ask.mjs          <- suggestAsk(): the expected-CTC figure per row, and its source
    ├── analytics.mjs    <- conversion, routes, calibration, latency, forecast — the Stats page
    ├── recommend.mjs    <- rankLeads/picks, rankContacts/outreach, record() — the recommender
    ├── today.mjs        <- agenda(), machine() — everything with a date on it
    ├── server.mjs       <- :7777 + SSE (CLI writes touch .bump, UI updates <1s)
    ├── public/          <- the dashboard UI (plain HTML/CSS/JS)
    ├── test/            <- node --test dashboard/test/sort.test.mjs (fixtures/ beside it)
    └── sweep/
        ├── run-sweep.mjs   <- the two halves; hands SWEEP.md to `claude -p`
        ├── SWEEP.md        <- the mail-sweep prompt (yours: SWEEP.local.md, gitignored)
        ├── PORTALS.md      <- when a portal session lapses or a selector dies
        ├── browser.mjs     <- CDP Chrome; wheel(), wheelUntilStable()
        ├── portals.mjs     <- the ten channels
        ├── linkedin.mjs    <- LinkedIn's four surfaces; JD_JS + judgeJD
        ├── enrich.mjs      <- JD + company-page reads (browser); recordRead, setCompanyFacts
        ├── sort.mjs        <- the second step: LinkedIn public JDs, twins, AmbitionBox (plain HTTP)
        ├── ambitionbox.mjs <- resolveCompany, fetchSalaries, verifyMatches
        ├── estimate.mjs liveness.mjs
        ├── install.sh      <- launchd jobs
        └── apply.mjs       <- the send path (CLI only), fact + style gates
```

## Changelog

**2026-11-02 (sort)** — `sweep/sort.mjs` and `ladder sort`, a hunt step between reconcile and
enrich. `enrich.recordRead()` split out so both passes write a read the same way. AmbitionBox
moved to plain HTTP (`resolveCompany`, `fetchSalaries`, `verifyMatches`; `ask refresh` and
`targets refresh` no longer open Chrome). Money prices the role from AmbitionBox peers; a row with
no posting date is neutral, not fresh; weights Timing 30 · Money 25 · Alignment 25 · Company 10 ·
Route 10. Schema: `leads.jd_source`, `companies.ab_match / ab_linkedin / ab_industry /
ab_business`, and the missing `posted_at` / `last_seen_at` declarations. First test suite.

**2026-11-02 (Indeed, Wellfound, Glassdoor, schedule)** — Indeed city split (33 page-1 searches,
cards de-duplicated, paced, 600s budget); every portal detects a bot-check page (`WALL_JS`), stops,
and retries the rest once at the end of the pass; a channel's counts always print and it is `ok`
if it read anything; per-card filters are `makeIngest()` / exported `filterRows()`; Glassdoor's
"(Glassdoor Est.)" guesses never trip the floor and are not stored; compact ages ("6d", "24h")
parse. Wellfound adds `full-stack-engineer`. Glassdoor is harvested in a logged-in Chrome in-session
and loaded with `ladder portals ingest --channel glassdoor --file rows.json`. Hunts and mail sweeps can
run on demand instead of at 08:00 (`./ladder install server`).

**2026-11-02 (extraction audit)** — LinkedIn rebuilt on AI search
+ 10 collections, Promoted kept (873 new leads on the first run); load wide / clean after
(`lane.mjs`, `clean.mjs`, `leads.lane`, `leads.lane_why`, hunt step `clean`, CLI `clean`,
`clean undo`, `clean recheck`); enrichment 40 → 120 a hunt, 6 → 14 min, paced on LinkedIn; Leads
tab lane chips; Stats death rule `lane`; FDE regexes accept "Forward Deployment" / "Partner
Deployed".

**2026-09-12 (six pages)** — Leads and Applications split. `insights.funnel()`, `recommended()`
and `potentialOf()` deleted; `leadRows()` / `appRows()` replace them. `state()` serves `leads`
(rows, total, gated, snoozed, channels, cuts) and `applications` (rows, stageCounts, waiting);
`funnel`, `stageCounts`, `leadsTotal` gone from the payload, `apps` kept. Front end: six tabs,
`#board` → `#leads`, keys 1–6, the breakdown drawer (`.bd-*`: five vertical bars ≤ 24px, rounded
tops, confidence as the only variation), `A M T C R` mini chips on Today's picks.

**2026-09-12 (enrichment)** — `sweep/enrich.mjs`; hunt row gains `enrich` after reconcile;
`JD_JS` exported and reads applicants / posting age / company link off the top card; `judgeJD()`
factored out of `gateCheck`; YC batch, Wellfound / YC company links and foundit's early-applicant
flag captured at scrape time; `leads.company_url` written by `upsertLead`. New CLI `ladder enrich`,
`ladder company set|show`. Score: `agency` gate; `closed` gate skips warm routes.

**2026-09-12 (later)** — Score model v2. New `score.mjs` and `profile.mjs`; `scoreLead()` delegates;
`reconcile()` writes `score` and `score_json` together; `upsertLead` writes both on insert and
re-scores the merged row; `rankLeads()` reads the stored breakdown and lost its own time / title /
gate / location arithmetic. Schema: `leads(+archive).score_json, jd_text, jd_status,
jd_checked_at, applicants, company_url`; `companies.funding_stage, funding_total_usd,
last_round_at, founded, headcount, yc_batch, enrich_source, enriched_at, enrich_checked_at`; kv
`w_*`, `gate_ceiling_years`, `startup_headcount_max`, `funding_recent_months`, `enrich_*`.
`CUTS` 76/70 replace the 66/62/70 literals. Model fixes found by the dry run: a stored `(est)` band
is re-estimated live; Cognition / Devin / Temporal added to the estimator's global-product list;
Naukri `gmail-inbound-*` invites are a recruiter route, not warm (also in `WARM_SQL`). Backup
`backups/ladder-20260912-020842.db`. New CLI: `ladder score [--dry]`, `ladder score explain <id>`.

**2026-09-12** — The `queued` leak, closed. New `ladder drafts resolve`; `reconcile()` no longer
stamps leads from drafts and reports `queuedLeads`; `queued` retired from every leads predicate;
`WARM_SQL` exported from `lib.mjs`. 69 drafts archived, 10 leads flipped (7 warm → shortlisted,
3 → new). Backup `backups/ladder-20260912-014500.db`.

**2026-09-10 (later)** — The Today page. `recommend.mjs` and `today.mjs` wired into the server and
the dashboard; five tabs, default `today`. New tables `rec_events` and `agenda`; new columns
`leads.snoozed_until`, `contacts.snoozed_until|contacted_at|notes`; new kv `picks_per_day=8
outreach_per_day=3 snooze_days=3 expiry_days=10`. New routes `/api/rec`, `/api/agenda`,
`/api/contact/:id`, `GET /api/row/{lead,app}/:id`. New CLI: `ladder today`, `ladder agenda
add|done|list`, `ladder pick skip|snooze|applied <id>`. `insights.recommended()` is retired from
the payload — Today's picks come from the recommender, which says why. Stats trimmed to four
headline numbers with the deep panels behind a collapsed `<details>`; nothing deleted. One expire
pass run on the fix: 152 leads retired.

**2026-09-09 (later)** — Wellfound: pagination, city rotation, per-portal budget, scrape-time
gate filter, `posted_at` capture, landed-path slug guard. LinkedIn DM read moved from the hunt
into the mail sweep, so "Run mail sweep" means replies on every channel.

**2026-09-09** — LinkedIn rebuilt across four surfaces (was 7 job-search URLs producing 112 leads,
2 above floor, 0 humans). Added `contacts`, `posted_at`, `last_seen_at`. Added
`page.wheel()/wheelUntilStable()`, `expireLeads()`, `gateCheck()`, `./ladder linkedin`,
`./ladder expire`. Fixed: ads (`sortBy=DD`), scroll, pane geometry, band-blind scoring, the leads
board serving only the global top 250 (so channel filters lied), LinkedIn messages sitting in the
wrong half of the sweep. Portal run order reprioritised. Internshala removed. Expiry window 10d.

## Open items

- **Enrichment coverage is the number to watch.** After one pass: 34 of 840 live leads have a
  read JD (Alignment `measured`), 805 have never been looked at; 8 of 668 live-lead companies have
  a size, stage or batch on file (Company `verified`). At 40 leads and 15 companies a hunt it is
  ~20 days to read the board once, so the order (best potential first) is what makes it useful
  before then. The manual hook for the top few: `ladder company set`.
- **The applicant wording is measured on 40 reads, not 400.** "Over 100 people clicked apply"
  dominates; "Be among the first N" and the old "N applicants" were not seen. If LinkedIn changes
  the phrase, `applicants` silently goes null — `score explain` on a fresh LinkedIn lead is the
  check.
- **A full `--hunt` has not run since enrichment was added** (2026-09-12). The first scheduled run
  is the first end-to-end test of the `--- enrich ---` block under the 12-minute timeout; check
  `sweep/logs/<stamp>.log` the next morning.
- Portal pass still dies early some mornings; naukri was the main cause and is now last.
