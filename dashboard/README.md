# ladder dashboard — reference

Setup lives in the [root README](../README.md); the design in [ARCHITECTURE.md](../ARCHITECTURE.md).
This page is the command and behaviour reference.

Applications, leads, interviews, comp and study in a single SQLite file, a live web UI, and a
sweep that fills it in (on demand, or every morning at 08:00).

**Zero dependencies.** Node 24's built-in `node:sqlite`, `node:http` and `WebSocket`. No
`npm install`, no build step, no Docker. Nothing leaves the machine except the sweep's own
Gmail and portal reads.

## Run it

```bash
./ladder install     # launchd: 08:00 sweep + always-on server (survives reboot)
./ladder install server   # just the always-on server; run hunts by hand
./ladder open        # http://localhost:7777
```

Or without launchd: `./ladder start` in one terminal.

## What the morning sweep does

Two passes, in this order, because the second is allowed to fail without costing you the first.

**1. Portals — deterministic, no model involved.** `sweep/browser.mjs` drives a real Chrome over
the DevTools Protocol. Four portals serve full results logged out and need no credentials at all:

| portal | auth | what it yields |
|---|---|---|
| Naukri | none | the largest India pool |
| Indeed | none | volume, and bands are usually stated |
| Glassdoor | none | bands stated most often |
| Internshala | none | thin at this level, cheap to check |
| Wellfound | **login** | leads *and* application status — the best channel |
| YC WaaS | **login** | leads and the messages inbox |
| LinkedIn | **login** | InMail only; lowest yield |

**2. Gmail — Claude, via the claude.ai connector.** Reads the last two days, decides
human-vs-automated on each thread, and writes events, status changes and notifications.
It is explicitly told *not* to touch portals; that already happened in pass 1.

### The Chrome bridge, and why this is not Claude's

Claude Code's own Chrome tools only exist in an interactive session, so for a long time this
dashboard recorded every portal as unreachable at 08:00 and asked for a manual pass. That was a
wrong conclusion from a true fact. Chrome ships its own remote-control interface and Node ships a
WebSocket client, so `sweep/browser.mjs` opens a browser the sweep owns and drives it directly —
no npm install, no interactive session, no dependence on Claude having browser tools.

The scraping profile lives at `sweep/chrome-profile` and is **gitignored**: it holds live session
cookies for your logged-in portals. It is deliberately not your day-to-day Chrome profile, so a
sweep never fights your browsing for a tab and a portal that bumps one session cannot sign you out
of the other.

### Logging in the three that need it

```bash
./ladder browser login          # opens a real window, one tab per portal
./ladder browser check          # confirms which sessions are live
```

Sign in once per portal. Sessions last months. When one lapses the sweep reports that channel as
`not logged in` and the dashboard turns it red — it never reports an expired session as "no jobs".

## Commands

```
./ladder start | open | sweep | install [server|uninstall] | export | backup | sql

./ladder portals                   # the portal pass on its own
./ladder portals --all             # include the three that need a login
./ladder portals --headful         # watch it work, for debugging a selector
./ladder browser login | check | status | stop

./ladder stats                     # the scoreboard as JSON
./ladder brief                     # the morning brief as markdown
./ladder stale --days 7            # applications that have gone quiet
./ladder app set "Acme" --status replied --source gmail --why "founder replied"
./ladder lead list --floor         # unapplied, above the floor, ranked
./ladder lead drop 62 --why "services body-shop"
./ladder lead promote 62           # lead -> application
./ladder sweep list                # what the last sweeps actually reached
./ladder study log --minutes 90 --section A --topic "graphs"
./ladder outbox add --to x@y.com --subject "..." --body "..."   # 30-min hold
./ladder reconcile                 # dedupe leads vs applications, rescore, backfill bands
./ladder score --dry               # score model v2: histogram, gates, top 15 with A M T C R
./ladder score explain 29          # one lead's five bars, chips and gates
./ladder enrich --limit 40 --dry   # read JDs + company pages; --dry reports, writes nothing
./ladder enrich --company "Ema"    # one company page
./ladder company set "Cognition" --stage series-b --headcount 60 --yc W24 --source <url>
./ladder company show "Cognition"  # the row and its live leads
./ladder drafts resolve --dry      # classify leftover 'queued' drafts (see ARCHITECTURE.md)
./ladder ingest sweep.json         # bulk write — how the sweep agent reports
```

`app` arguments resolve fuzzily: `"Acme"` or `"Acme:Forward"` both work.

## What the scraper refuses to do

A scraper that quietly returns nothing is worse than no scraper, so three rules are enforced in
`sweep/portals.mjs`:

- **An hourly rate is never an annual band.** Glassdoor lists gig work as `₹50.00 - ₹100.00` with
  no unit; read as lakhs that becomes a ₹100L job at the top of the board. Unitless small figures
  parse as *unknown*, not as lakhs.
- **One employer is one lead.** A single advertiser posting twelve near-identical reqs is capped
  at three, or it owns the whole board.
- **A failed channel says so.** `ok: false` with a reason, never `ok: true` with zero rows.

Unknown comp is *kept* — a startup that hides its band is not a startup that pays badly.

## How the pieces fit

```
  CLI writes ──┐
               ├──> ladder.db ──> server.mjs ──SSE──> browser (updates instantly)
  sweep ───────┘                      ▲
  (08:00 launchd → run-sweep.mjs      │
   → portals via CDP, then Gmail      │
     via claude -p → ingest) ─────────┘
```

`server.mjs` watches `.bump`, which the CLI touches after every write — so anything Claude writes
from a terminal appears in an open dashboard within half a second, no refresh.

## The kit

The **Kit** tab serves the material you actually apply with — resume PDFs, a fact file, prep,
per-application notes — read straight off disk so it can never drift from the file you send.
Which files appear is `kit` in your profile. A fact file earns its place: every resume claim has
to be checkable against it, and a fast bulk-apply run is exactly when an unverifiable line gets
put in writing.

## Auth for the Gmail pass

It **must** run on your claude.ai login, never an `ANTHROPIC_API_KEY`. Two hard reasons: an API
key (a work one, say) should not be billed for a personal job search, and with any API key set
Claude Code disables the claude.ai connectors outright, so a sweep on the work key cannot read
mail at all. `run-sweep.mjs` strips every auth env var and verifies the connector came up,
aborting with a dashboard notification if it did not.

The portal pass has no such dependency and runs first, so a broken connector costs you mail —
not leads.

## Autonomy

Auto-act is on for **low-stakes** mail only: acknowledging first contact, confirming a slot
already offered, answering a logistics question from data already in the DB. Anything touching
comp, notice period, current CTC, a claim about experience, or a new application is drafted and
held.

Everything outbound lands in the **outbox** with a 30-minute hold, visible and cancellable in the
dashboard, and is flushed at the start of the next sweep. `./ladder set outbox_hold_minutes 0`
for immediate sends.

## Settings

`./ladder set` with no arguments prints them all. `./ladder set floor_lpa 28` changes one.
`floor_lpa` drives lead ranking, the above/below colouring and the comp funnel.
`discovery_floor_lpa` (default 18) is the looser gate the portal scraper uses — deliberately below
the real floor, because a ₹20L posting is a negotiation, not a rejection.

## Data

`ladder.db` is the source of truth and is **never** in git: it is your job search.
`./ladder export` writes `export/ladder-export.json` (also gitignored) for a readable dump, and
`./ladder backup` snapshots the db to `backups/`. Both stay on your machine.
