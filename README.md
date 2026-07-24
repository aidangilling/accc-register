# ACCC Acquisitions Register — mirror & statistics

A self-updating static website that mirrors the ACCC's Mergers & Acquisitions
[**Acquisitions register**](https://www.accc.gov.au/public-registers/mergers-and-acquisitions-registers/acquisitions-register)
and reproduces the firm's statistics for **Phase 1 & 2 Notifications** and
**Waivers**.

- **No server, no database, no cost.** A scheduled GitHub Action scrapes the
  register, computes the stats, and commits `data.json`. GitHub Pages serves the
  static site, which just reads that JSON.
- Updates itself **four times a day** (every 6 hours), plus a manual **Run workflow** button.

## How it works

```
┌─ GitHub Action (cron 4×/day + manual) ────────────────────────┐
│  scripts/scrape.mjs                                            │
│    1. fetch listing pages (cheerio, plain HTTP)                │
│    2. fetch detail pages for determination date + outcome     │
│       (cached for already-completed matters)                  │
│    3. compute business-day durations + statistics             │
│    4. deep-merge overrides.json on top                        │
│    5. write data.json  (only if the data changed)             │
│    6. guard: abort if the scrape looks broken → keep old data │
└───────────────────────────────────────────────────────────────┘
         │ commits data.json
         ▼
┌─ GitHub Pages (static) ───────────────────────────────────────┐
│  index.html + assets/  →  fetch('data.json')  →  render        │
└───────────────────────────────────────────────────────────────┘
```

## Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The page shell (two sections). |
| `assets/styles.css`, `assets/app.js` | Styling and the render/sort/filter logic. |
| `data.json` | The data the site reads. **Written by the Action — don't hand-edit.** |
| `overrides.json` | Manual overrides you maintain (see below). |
| `scripts/scrape.mjs` | The scraper + stats + overrides pipeline. |
| `.github/workflows/update.yml` | The scheduled + manual workflow. |

## The two sections

Records are bucketed by their **Type** field:

1. **Phase 1 & 2 Notifications** — `Type = Notification`
2. **Waivers** — `Type = Waiver`

Each has its own summary stats and its own sortable, filterable table.

## Assessment duration — the firm's business-days convention

This deliberately differs from the statutory s51ABK definition. It is only shown
where a matter's review is complete (status **Assessment completed** *and* a
determination date exists); otherwise the cell shows an em dash `—`.

- Counted from the **day after** the effective notification date, up to and
  **including** the determination date. This equals Excel
  `NETWORKDAYS(effectiveDate, determinationDate) − 1`.
- Excludes Saturdays and Sundays, **plus only these four fixed-date holidays**:
  Christmas Day (25 Dec), Boxing Day (26 Dec), New Year's Day (1 Jan),
  Australia Day (26 Jan).
- **No** substitute/in-lieu days, and **no** Good Friday, Easter Monday, Anzac
  Day, Canberra Day, Reconciliation Day, or King's Birthday. This under-counts
  holidays on purpose — it is the firm's settled convention.

## Editing `overrides.json`

`overrides.json` pins hand-adjusted figures so the mechanical calculation can
never silently overwrite a known, deliberate exception.

- It is an object **keyed by ACCC case number** exactly as shown on the register
  (e.g. `"MN-65028"`).
- Any key starting with `_` (like `_readme`, `_example`) is **ignored**.
- For a case-number key you may set any of:
  - `reviewComplete` — `true` / `false`
  - `determinationDate` — `"YYYY-MM-DD"`
  - `durationBusinessDays` — a number, **or** the string `"—"` for an em dash
  - `status` — a string
  - `notes` — a string, shown as a small **manual** tag on that row
- **Pipeline order:** scrape → compute mechanically → merge overrides on top, so
  whatever you set here always wins and is never recomputed away.

The file ships with a worked `_example` and four `REPLACE-with-case-number-…`
placeholders for the known exceptions (a Saturday effective date, two matters
that should show `—`, and a non-standard determination). **To activate one,
rename its key to the real case number** and fill in the values; delete any you
don't need. An override whose key doesn't match a current record is logged as an
inactive placeholder and otherwise ignored.

After editing, commit and push. The change appears the next time the Action runs
(or immediately if you press **Run workflow**).

## The schedule

Defined in `.github/workflows/update.yml`:

- `workflow_dispatch` — the **Run workflow** button in the **Actions** tab.
- One cron entry running every 6 hours. GitHub cron is **UTC** and can't express
  a timezone:
  - `0 */6 * * *` → 00:00, 06:00, 12:00, 18:00 UTC (≈ 10:00 / 16:00 / 22:00 /
    04:00 Sydney AEST), so the data is never more than ~6 hours stale.

  To change the times, edit those two lines (remember they're UTC).

> GitHub may delay or skip scheduled runs on free accounts when the platform is
> busy, and pauses schedules on repos with no activity for 60 days. If a run is
> missed, the next one catches up, or press **Run workflow**.

## Robustness

- The Action **won't commit a broken scrape**: it aborts (keeping the last good
  `data.json`) if the scrape errors, returns zero records, or the record count
  drops more than 20% versus the previous `data.json`.
- It **commits only when the data actually changed**, so `generatedAt` reflects
  the last real change. If the register is quiet for over ~24 hours the site
  shows a subtle amber "data may be delayed" note — the ACCC is known to publish
  late, especially for waivers.

## Running the scraper locally (optional)

```bash
npm install
npm run scrape      # writes/updates data.json
```

Then open `index.html` via a small static server (needed because the page
`fetch`es `data.json`):

```bash
npx serve .         # or: python3 -m http.server
```

## Notes

- `.gitignore` excludes the local `*.xlsx` workbooks so the firm's spreadsheets
  are never pushed to the (public) repo. Remove that line if you want them
  tracked.
- The scraper uses a plain browser User-Agent. The ACCC's WAF rejects any
  User-Agent containing the word "bot", so keep it browser-like.
