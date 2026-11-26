# Portals — how they run, and what to do when one breaks

Portals are **not** a manual job any more. `run-sweep.mjs` runs a full portal pass through
`sweep/browser.mjs` before it ever starts the Gmail sweep, using a Chrome the dashboard owns and
drives over the DevTools Protocol. No interactive session, no Claude browser tools, no npm.

This file is for the two cases where a human is still needed.

## Case 1 — a channel reports `not logged in`

Only three portals need auth: **Wellfound**, **YC WaaS**, **LinkedIn**. Their sessions last months
but do eventually lapse.

```bash
./ladder browser check                     # which sessions are live
./ladder browser login --only wellfound    # opens a real window to sign in
./ladder browser check                     # confirm
```

The scraping profile is `sweep/chrome-profile`, deliberately separate from the day-to-day Chrome
so a sweep never fights browsing for a tab, and gitignored because it holds live session cookies.

A lapsed session is reported as a **failed channel**, never as zero jobs. That distinction is the
whole point: "no new roles today" and "we could not look" must never render the same.

## Case 2 — a portal redesigns and a selector dies

The tell is a channel that reports `ok` with a suspiciously round `0 scanned`, or a sudden drop
from ~30 cards to 0 while the site loads fine in a normal browser.

```bash
./ladder portals --only glassdoor --headful      # watch it work
```

Then re-derive the card selector against the live DOM rather than guessing:

```js
// in the headful window's console
const counts = {};
for (const el of document.querySelectorAll('[class]'))
  for (const c of el.classList)
    if (/job|card|result|listing|tuple/i.test(c)) counts['.'+c] = (counts['.'+c]||0)+1;
Object.entries(counts).filter(([,n]) => n >= 5 && n <= 120).sort((a,b) => b[1]-a[1]).slice(0,10);
```

The repeated container at ~20–40 occurrences is the job card. Patch its entry in
`sweep/portals.mjs` and re-run.

Two habits keep this cheap:

- **Anchor on hrefs, not classes, where possible.** Wellfound and YC are Tailwind end to end and
  have no stable semantic class; their job-link URL shape is a routing contract and outlives every
  redesign. Glassdoor's classes carry a build hash (`JobCard_jobTitle__GLyJ1`), so match the stable
  prefix with `[class*="jobTitle"]`.
- **Read money out of the card text with a regex, not a selector.** Salary is the field portals
  move around most, and `parseMoney` handles the three formats they quote it in.

## Rules that outlive any selector

- A "resume viewed" blast to 20,000 applicants is not a signal. A named person is.
- Unknown comp is **kept**. A startup that hides its band is not a startup that pays badly.
- An hourly rate is never an annual band.
