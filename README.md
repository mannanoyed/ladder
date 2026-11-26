# ladder

A local job-search command centre. It finds jobs across a dozen portals, judges each one against
your resume and your rules, tracks applications and replies, and shows the whole pipeline on a
live dashboard at `localhost:7777`. Claude plugs in on top: it reads your mail for replies, judges
new leads, drafts low-stakes answers, and works through applications with you, all through the
same CLI you use.

Everything runs on your machine. Your database, profile, browser sessions and notes never leave it.

- **Zero npm dependencies.** Node 24's built-in `node:sqlite`, `node:http` and `WebSocket`, plus
  a Chrome the tool drives over the DevTools Protocol. No `npm install`, no build step.
- **Load wide, clean after.** The scrapers keep everything that is not certainly junk; a visible,
  reversible cleaning step drops the rest with a reason per row.
- **Five-part score.** Resume↔JD alignment, money, timing, company, and route (referral beats
  cold), each with signed "why" chips you can inspect.
- **A failed channel says so.** An expired login or a bot wall is reported as a failure, never as
  "no new jobs today".
- **Nothing is sent behind your back.** Applications are sent by you (or by Claude while you
  watch). Mail replies wait in a 30-minute outbox you can cancel.

Built for the Indian market (₹ bands in lakhs, Naukri, Instahyre, foundit, AmbitionBox salary
data) and for AI / forward-deployed engineering roles, but the profile, lanes and weights are
yours to change.

---

## Requirements

| | |
|---|---|
| **macOS** | launchd scheduling and a few paths assume it. Linux works for everything except `./ladder install`. |
| **Node 24+** | for `node:sqlite`. `node -v` to check. |
| **sqlite3** | the CLI, for `./ladder backup` and `./ladder sql`. Preinstalled on macOS. |
| **Google Chrome** | the scrapers drive their own Chrome profile, separate from your daily one. |
| **Claude Code** *(optional)* | for the mail sweep and for working the board with Claude. See [Using it with Claude](#using-it-with-claude). |

## Setup

```bash
git clone https://github.com/mannanoyed/ladder.git
cd ladder/dashboard

# 1. Your profile: who you are and what your resume says. Gitignored.
cp profile.example.mjs profile.local.mjs
$EDITOR profile.local.mjs

# 2. Start the dashboard (creates ladder.db on first run)
./ladder start            # http://localhost:7777, or `./ladder install server` to keep it running

# 3. Sign the scraping Chrome in to the portals that need it (one-time, lasts months)
./ladder browser login    # a real window, one tab per portal; sign in, then close it
./ladder browser check    # which sessions are live

# 4. First hunt
./ladder portals --all    # scrape every channel into the board
./ladder reconcile        # dedupe, rescore, backfill bands
./ladder open
```

Until `profile.local.mjs` exists the tool runs on the example persona, so a fresh clone always
boots.

### The profile

`dashboard/profile.local.mjs` is the only file you have to write. Every field is optional, and a
missing one switches its feature off rather than crashing. The example is commented field by field.

| Field | What it drives |
|---|---|
| `skills`, `gaps`, `gapCap` | Resume↔JD alignment. Regexes with weights; a required gap costs points. `resumeTex` + `node profile.mjs --check` warns when your resume names a skill no regex covers. |
| `currentCtcLpa`, `yearsExperience` | The Ask column (what to type into an "expected CTC" box) and AmbitionBox experience bands. |
| `homeCity`, `homeRegion` | Truthful answers to "where are you" location gates, and a small home-region bonus. |
| `identity` | Contact fields on application forms (LinkedIn, phone, GitHub). |
| `forbiddenClaims` | Claims you must never make in writing. Any draft that matches is blocked. |
| `letter`, `answers` | Intro notes and custom-question answers for `./ladder apply`, built from your own blocks. |
| `kit` | Which files the dashboard's Kit tab shows (resume PDF, notes, prep). |

Search settings (floor, stretch, score weights, experience ceiling, picks per day) live in the
database: `./ladder set` lists them, `./ladder set floor_lpa 20` changes one.

### Portals

| Portal | Login | Notes |
|---|---|---|
| Naukri, Indeed, Glassdoor, Instahyre, foundit, hirist, HN Who's Hiring | none | logged-out results; Indeed and Glassdoor rate-limit, the pass backs off |
| Wellfound | yes | the best channel: leads and application status |
| YC Work at a Startup | yes | leads and the messages inbox |
| LinkedIn | yes | AI search + collections, guest JD pages, DMs |

Sessions live in `dashboard/sweep/chrome-profile/` (gitignored). When one lapses the channel goes
red on the dashboard with the fix: `./ladder browser login --only <portal>`.
[`sweep/PORTALS.md`](dashboard/sweep/PORTALS.md) covers what to do when a portal redesigns.

---

## Daily use

```bash
./ladder sweep --hunt     # portals, LinkedIn, expire, clean, reconcile, sort, enrich
./ladder sweep --mail     # Claude reads your mail for replies (see below)
./ladder today            # today's picks, with a one-line reason each
./ladder lead list --floor
./ladder lead promote 62  # lead → application once you have applied
./ladder app set "Acme" --status screen --why "recruiter call booked"
./ladder brief            # the morning brief as markdown
```

The dashboard has six pages: **Today** (picks, agenda, whether the machine ran), **Leads**,
**Applications**, **People** (contacts worth a message), **Stats** (conversion, routes, why leads
die), and **Roadmap**. It updates live: any CLI write appears in an open tab within a second.

The full command reference is in [`dashboard/README.md`](dashboard/README.md); the design and the
reasons behind it are in [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Using it with Claude

The tool is deterministic code: scraping, scoring and cleaning need no model. Claude adds
judgement in three places, and in each one it works through the same `./ladder` CLI you do, so
everything it does lands in the database and shows on the board.

### 1. The mail sweep (Claude Code, headless)

`./ladder sweep --mail` (or the 08:00 launchd job) runs `claude -p` with
[`sweep/SWEEP.md`](dashboard/sweep/SWEEP.md) as its instructions. Claude reads the last two days
of Gmail through the claude.ai Gmail connector, decides human-vs-automated on every thread, and
writes replies, rejections, interview requests and recruiter inbounds into the database. It
judges the new leads the portal pass found, drafts low-stakes replies into the outbox, and closes
with a brief that appears on the dashboard.

To set it up:

1. Install [Claude Code](https://claude.com/claude-code) and log in with your claude.ai account
   (`claude`, then `/login`).
2. Connect **Gmail** at claude.ai → Settings → Connectors. Claude Code picks up claude.ai
   connectors automatically.
3. Make sure no `ANTHROPIC_API_KEY` is set for the sweep. With an API key, Claude Code turns the
   claude.ai connectors off and the sweep goes blind. `run-sweep.mjs` strips auth variables and
   checks that the connector is up before starting, and it aborts with a dashboard notification
   if it is not.
4. Try it: `./ladder sweep --mail`, then check `dashboard/sweep/logs/`.
5. Optional: `./ladder install` schedules hunt + mail daily at 08:00 (`LADDER_SWEEP_HOUR` and
   `LADDER_SWEEP_MIN` change the time).

To change what the sweep does, copy `SWEEP.md` to `SWEEP.local.md` (gitignored) and edit that.
The runner prefers the local copy. The sweep gets a fixed tool allowlist: `node` and `cat` in
Bash, file reads and writes, and four Gmail tools. It sends nothing directly; outbound mail
goes through the outbox's hold.

### 2. Working the board with Claude Code (interactive)

Run `claude` inside the repo. [`CLAUDE.md`](CLAUDE.md) gives the session the map: the CLI, the
data model and the rules. Then talk to it the way you'd talk to someone helping with the search:

- *"What's worth applying to today?"* runs `./ladder today` and `lead list`, and reads the score
  breakdowns.
- *"Why is Acme ranked so low?"* runs `./ladder score explain <id>`.
- *"Here are five links, apply to them."* Claude runs `./ladder lead claim <url>` on each, so the
  board highlights what it has picked up, then promotes each lead to an application once it is
  sent.
- *"I got a call from Acme's recruiter, log it."* runs `./ladder app set` and `./ladder event add`.
- *"What should I put in the expected-CTC box?"* runs `./ladder ask "Acme"`: a figure anchored to
  what that role pays, with its source.

Keep private context (your strategy, rules for how Claude should write as you) in
`CLAUDE.local.md` at the repo root. It is gitignored and Claude Code loads it next to `CLAUDE.md`.

### 3. Filling application forms (Claude in Chrome)

With the [Claude in Chrome](https://claude.com/chrome) extension, a Claude Code session can drive
your own logged-in browser. It can open a lead's URL, fill the form from your profile and resume,
and stop for you to review before submitting. Treat every submit as yours: read the button label
and the filled fields first. Naukri and LinkedIn ban accounts for automated applications, so
`sweep/apply.mjs` only ever prepares those and leaves the final click to you.

### Ground rules for any Claude setup

- **Claims come from your fact file.** Put verified facts about your work in a file (`FACTS.md`
  in the repo root is the convention, and it is gitignored). Put claims that failed verification
  in `profile.forbiddenClaims`, where the send path blocks them.
- **The style gate blocks, it doesn't advise.** Em dashes, "passionate", "excited to", and any
  sentence that volunteers a gap are refused by `screenStyle()` before anything can be queued.
- **Salary, visa and "why us" are never auto-answered.** Write those per application.

---

## What stays on your machine

The repo ships only the tool. `.gitignore` is an allowlist: everything at the top level is ignored
except `dashboard/` and these docs, so personal files you keep next to the tool (resume, notes,
fact file, call transcripts) cannot be committed by accident. Inside `dashboard/` the ignored
files are:

```
ladder.db*  backups/  export/        your pipeline and its snapshots
profile.local.mjs                    you
sweep/SWEEP.local.md                 your sweep instructions
sweep/chrome-profile/                live portal sessions (cookies)
sweep/logs/  .sweep-tmp/             run logs and agent scratch files
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `LADDER_PROFILE` | `dashboard/profile.local.mjs` | another profile file |
| `LADDER_DB` | `dashboard/ladder.db` | another database |
| `LADDER_PORT` | `7777` | dashboard port |
| `LADDER_CHROME_PROFILE` | `dashboard/sweep/chrome-profile` | scraping Chrome profile |
| `LADDER_CDP_PORT` | `9222` | DevTools port for that Chrome |
| `LADDER_LABEL_PREFIX` | `com.ladder` | launchd label prefix |

## Tests

```bash
node --test dashboard/test/sort.test.mjs
```

## License

MIT. See [LICENSE](LICENSE).
