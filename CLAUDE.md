# ladder — orientation for Claude

A local job-search system. You help the user work the pipeline: find out what's worth applying
to, explain rankings, log what happened, and apply with them. Read `README.md` for setup and
`ARCHITECTURE.md` for the design. If `CLAUDE.local.md` exists it holds the user's private context
(strategy, voice, standing rules) and overrides anything general here.

## How to act on the system

Everything goes through the CLI. Run it from `dashboard/`:

```bash
cd dashboard && ./ladder <command>
```

Never write to `ladder.db` with raw SQL when a command exists. The commands keep scores, dedupe
and the dashboard's live updates consistent: every CLI write touches `.bump`, and an open dashboard
refreshes within a second. Take a backup before anything bulk: `./ladder backup`.

| Need | Command |
|---|---|
| What to work on | `./ladder today`, `./ladder lead list --floor`, `./ladder stale --days 7` |
| Why a lead scores what it does | `./ladder score explain <id>` |
| Pick up links the user hands you | `./ladder lead claim <url-or-id> --note "..."`, release with `lead unclaim` |
| Record a send | `./ladder lead promote <id>`, or `./ladder app add` for one not on the board |
| Record what happened | `./ladder app set "Company[:Role]" --status <s> --source <src> --why "..."`, `./ladder event add` |
| Drop a lead | `./ladder lead drop <id> --why "..."` (always with a reason) |
| Bulk write | `./ladder ingest file.json` (events, notifications, leads; see `sweep/SWEEP.md` §5) |
| Expected CTC for a form | `./ladder ask "Company"` |
| Company facts | `./ladder company show|set "Company"` |
| Run a hunt / mail sweep | `./ladder sweep --hunt`, `./ladder sweep --mail` |
| Settings | `./ladder set` (list), `./ladder set <key> <value>` |

Statuses on an application: `applied`, `replied`, `screen`, `interview`, `offer`, `rejected`,
`ghosted`, `withdrawn`. Use `./ladder app show "Company"` to see the current row before changing it.

## Rules

- **Check before you add.** Before promoting or adding an application, look for an existing row
  (`./ladder app show`, `./ladder lead list`). Match the role, not just the company: people often
  hold two reqs at one employer.
- **Claims come from the user's fact file only.** If `FACTS.md` exists in the repo root, nothing
  about the user's experience goes into writing unless it is there. `profile.local.mjs` →
  `forbiddenClaims` lists claims that failed verification; the send path blocks them, and so
  should you.
- **Never auto-answer** salary, notice-period negotiation, visa/work authorisation, or "why this
  company". Draft and ask.
- **No em dashes, no filler** ("passionate", "excited to", "leverage") and never volunteer a gap in
  anything written in the user's name. `screenStyle()` in `sweep/apply.mjs` enforces this.
- **One click per screenshot on application forms.** When driving a browser, read the button
  label before clicking; a "Next" in one step can be "Submit" in the next. The submit is the
  user's decision unless they've told you otherwise for that application.
- **Naukri and LinkedIn are never auto-submitted.** They ban accounts for it. Prepare and hand over.
- **Report failures as failures.** A scrape that returned zero because of a login wall is a
  failed channel, not "no jobs".

## Code map (when changing the tool)

- `dashboard/profile.mjs` loads `profile.local.mjs` (fallback `profile.example.mjs`); `termHits()`
  is the resume↔JD matcher. Personal data belongs in the profile, never in code.
- `dashboard/score.mjs` is score model v2: five components plus gates. `lane.mjs` and `clean.mjs`
  are load-wide/clean-after.
- `dashboard/sweep/` holds the scrapers (`portals.mjs`, `linkedin.mjs`, CDP Chrome in `browser.mjs`),
  `sort.mjs` / `enrich.mjs` / `ambitionbox.mjs` for reading JDs and salaries, `run-sweep.mjs` for
  the hunt + mail runner, and `apply.mjs` for the send path and its gates.
- `dashboard/server.mjs` + `public/` are the dashboard (no framework, SSE for live updates).
- Tests: `node --test dashboard/test/sort.test.mjs`. Zero npm dependencies; keep it that way.
- Keep `ARCHITECTURE.md` current when behaviour changes.
