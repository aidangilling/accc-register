// scripts/scrape.mjs
//
// Scrapes the ACCC "Acquisitions register", computes the firm's statistics,
// applies the overrides layer, and writes data.json.
//
// Design goals (see README):
//  - Plain HTTP fetch + cheerio (no headless browser). The listing is
//    server-rendered Drupal; the data is in the raw HTML.
//  - Polite: a real User-Agent and a small delay between requests.
//  - Fast: detail pages for matters that were already "Assessment completed"
//    in the previous data.json are cached (their determination never changes).
//  - Safe: a failed or implausible scrape does NOT overwrite the last good
//    data.json. We also only write when the data actually changed.
//
// Usage:  node scripts/scrape.mjs
// Exit codes: 0 = success (data written or unchanged), 1 = aborted (old data kept).

import { load } from "cheerio";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_PATH = join(ROOT, "data.json");
const OVERRIDES_PATH = join(ROOT, "overrides.json");
// Authoritative real determination dates (from the firm's Excel ≤ 16 Jul 2026,
// and PDF-derived thereafter), keyed by case number. See determination-date-from-pdf memory.
const DET_STORE_PATH = join(ROOT, "determination-dates.json");

const ORIGIN = "https://www.accc.gov.au";
const REGISTER_PATH =
  "/public-registers/mergers-and-acquisitions-registers/acquisitions-register";
const REGISTER_URL = ORIGIN + REGISTER_PATH;

// NOTE: the ACCC's WAF rejects any User-Agent containing the word "bot",
// so this is a plain, current browser UA. Keep it that way.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_DELAY_MS = 400; // be polite between requests
const MAX_PAGES = 100; // safety cap on pagination
const MIN_RECORDS = 1; // a sane scrape returns at least this many
const MAX_DROP_RATIO = 0.2; // abort if record count drops > 20% vs last good

// The four fixed-date public holidays the firm's convention excludes.
// (Deliberately only these four — see README / business-days house rule.)
const FIXED_HOLIDAYS = new Set(["12-25", "12-26", "01-01", "01-26"]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchHtml(url, attempt = 1) {
  const MAX_ATTEMPTS = 3;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-AU,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (err) {
    if (attempt < MAX_ATTEMPTS) {
      const backoff = 1000 * attempt;
      console.warn(
        `  fetch failed (${err.message}); retry ${attempt + 1}/${MAX_ATTEMPTS} in ${backoff}ms`
      );
      await sleep(backoff);
      return fetchHtml(url, attempt + 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/** Read a YYYY-MM-DD date from the first <time datetime="..."> under a field. */
function isoDateFromField($, card, fieldClass) {
  const t = $(card).find(`.${fieldClass} time[datetime]`).first();
  const dt = t.attr("datetime");
  if (!dt) return null;
  // e.g. "2026-07-06T12:00:00Z" -> "2026-07-06"
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(dt);
  return m ? m[1] : null;
}

function fieldText($, card, fieldClass) {
  return clean($(card).find(`.${fieldClass} .field__item`).first().text());
}

/** Parse one listing page's HTML into an array of partial records. */
function parseListing(html) {
  const $ = load(html);
  const records = [];
  $("div.views-row").each((_, row) => {
    const card = $(row).find(".accc-collapsed-card").first();
    if (!card.length) return;

    const anchor = card
      .find('a[href*="/acquisitions-register/"]')
      .first();
    const href = anchor.attr("href");
    if (!href) return;

    const caseTitle =
      clean(card.find(".field--name-node-title h3").first().text()) ||
      clean(anchor.text());

    const permalink = href.startsWith("http")
      ? href
      : ORIGIN + href;

    records.push({
      caseTitle,
      permalink,
      status: fieldText($, card, "field--name-field-acccgov-merger-status"),
      type: fieldText($, card, "field--acccgov-type"),
      caseNumber: fieldText(
        $,
        card,
        "field--name-field-acccgov-mcmsmergermatterno"
      ),
      stage: fieldText($, card, "field--name-field-acquisition-stage"),
      effectiveDate: isoDateFromField(
        $,
        card,
        "field--name-field-acccgov-pub-reg-date"
      ),
    });
  });
  return records;
}

/**
 * Fallback: some completed matters don't populate the "Determination
 * publication date" field, but the date is present in the events timeline as a
 * "Phase 1/Phase 2 determination" row. Take the latest such event's date.
 * (We exclude "…determination period" extension notices, which aren't the
 * determination itself.)
 */
function determinationDateFromEvents($) {
  const dates = [];
  $(".field--name-field-acccgov-merger-events table tbody tr").each((_, tr) => {
    const label = clean($(tr).find("td").eq(1).text()).toLowerCase();
    if (!label.includes("determination")) return;
    if (label.includes("period") || label.includes("extend")) return;
    const dt = $(tr)
      .find("td.acccgov-timeline__date time[datetime]")
      .attr("datetime");
    if (dt) dates.push(dt.slice(0, 10));
  });
  if (!dates.length) return null;
  dates.sort();
  return dates[dates.length - 1]; // latest determination-related event
}

const MONTHS_LONG = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Extract "23 March 2026" -> "2026-03-23" from arbitrary text. */
function dateFromText(text) {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(20\d\d)/.exec(text || "");
  if (!m) return null;
  const mon = MONTHS_LONG[m[2].toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

const DET_PDF_EXCLUDE = [
  "summary", "statement", "reasons", "period", "extend",
  "concerns", "notice", "undertaking", "remedy", "review",
];

/**
 * The determination PDF filename usually carries the REAL determination date
 * (e.g. "… determination - 23 March 2026.pdf"), which is the authoritative date
 * — often earlier than the website's publication field. Return it if present.
 */
function determinationFilenameDate($) {
  let best = null; // { published, date }
  $(".field--name-field-acccgov-merger-events table tbody tr").each((_, tr) => {
    const label = clean($(tr).find("td").eq(1).text()).toLowerCase();
    if (!label.includes("determination")) return;
    if (DET_PDF_EXCLUDE.some((b) => label.includes(b))) return;
    const href = $(tr).find('a[href$=".pdf"]').attr("href");
    if (!href) return;
    const published =
      $(tr).find("td.acccgov-timeline__date time[datetime]").attr("datetime") ||
      "";
    const fname = decodeURIComponent(href.split("/").pop() || "");
    const d = dateFromText(fname);
    if (d && (!best || published > best.published))
      best = { published, date: d };
  });
  return best ? best.date : null;
}

/**
 * Parse a case detail page for: the determination outcome, the website
 * publication date (the "Determination publication date" field, or the events
 * timeline as a fallback), and the real determination date from the PDF filename
 * where available.
 */
function parseDetail(html) {
  const $ = load(html);
  const outcome = clean(
    $(".field--name-field-acccgov-acquisition-deter .field__item")
      .first()
      .text()
  );
  const t = $(
    ".field--name-field-acccgov-pub-reg-end-date time[datetime]"
  ).first();
  const dt = t.attr("datetime");
  const publicationDate = dt ? dt.slice(0, 10) : determinationDateFromEvents($);
  return {
    determinationOutcome: outcome || null,
    publicationDate: publicationDate || null,
    filenameDate: determinationFilenameDate($),
  };
}

// ---------------------------------------------------------------------------
// Business-days house rule (see README — deliberately NOT the statutory rule)
// ---------------------------------------------------------------------------

function utcDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/**
 * Excel NETWORKDAYS(effectiveDate, determinationDate) - 1: count business days
 * in the inclusive range [eff, det], then subtract 1. Excludes Sat/Sun and only
 * the four fixed-date holidays above. (Counting the full range and subtracting 1
 * — rather than starting the day after eff — matters when the effective date
 * falls on a weekend/holiday, where the two differ by one day.)
 */
function businessDays(effISO, detISO) {
  const DAY = 86400000;
  let count = 0;
  let cur = utcDate(effISO);
  const end = utcDate(detISO);
  if (end < cur) return 0;
  while (cur <= end) {
    const dt = new Date(cur);
    const dow = dt.getUTCDay(); // 0 = Sun, 6 = Sat
    const mmdd =
      String(dt.getUTCMonth() + 1).padStart(2, "0") +
      "-" +
      String(dt.getUTCDate()).padStart(2, "0");
    if (dow !== 0 && dow !== 6 && !FIXED_HOLIDAYS.has(mmdd)) count++;
    cur += DAY;
  }
  return count - 1;
}

// ---------------------------------------------------------------------------
// Overrides layer
// ---------------------------------------------------------------------------

const OVERRIDE_FIELDS = [
  "reviewComplete",
  "determinationDate",
  "durationBusinessDays",
  "status",
  "notes",
];

async function loadOverrides() {
  try {
    const raw = JSON.parse(await readFile(OVERRIDES_PATH, "utf8"));
    const out = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key.startsWith("_")) continue; // _readme, _example, etc. are ignored
      if (val && typeof val === "object") out[key] = val;
    }
    return out;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.warn(`Could not read overrides.json: ${err.message}`);
    return {};
  }
}

/** Deep-merge (per-field) the override on top of a mechanical record. */
function applyOverride(record, override) {
  const applied = [];
  for (const field of OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(override, field)) {
      record[field] = override[field];
      applied.push(field);
    }
  }
  if (applied.length) {
    record.overridden = true;
    record.overriddenFields = applied;
    if (override.notes) record.notes = override.notes;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadPrevious() {
  try {
    return JSON.parse(await readFile(DATA_PATH, "utf8"));
  } catch {
    return null;
  }
}

async function loadDetStore() {
  try {
    return JSON.parse(await readFile(DET_STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const previous = await loadPrevious();
  const prevByCase = new Map();
  if (previous?.records) {
    for (const r of previous.records) {
      if (r.caseNumber) prevByCase.set(r.caseNumber, r);
    }
  }

  // 1. Scrape all listing pages until one comes back empty.
  console.log("Scraping listing pages…");
  const listing = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${REGISTER_URL}?page=${page}`;
    const html = await fetchHtml(url);
    const rows = parseListing(html);
    if (rows.length === 0) {
      console.log(`  page ${page}: 0 records — end of pagination.`);
      break;
    }
    // De-dupe defensively by permalink in case pages overlap.
    let added = 0;
    for (const r of rows) {
      const key = r.permalink;
      if (seen.has(key)) continue;
      seen.add(key);
      listing.push(r);
      added++;
    }
    console.log(`  page ${page}: ${rows.length} records (${added} new)`);
    await sleep(REQUEST_DELAY_MS);
    if (added === 0) break; // pages started repeating — stop
  }

  if (listing.length < MIN_RECORDS) {
    throw new Error(
      `Scrape returned ${listing.length} records (< ${MIN_RECORDS}). Aborting.`
    );
  }

  // 2. Enrich completed/ceased/suspended matters with the publication date, the
  //    determination outcome, and the determination-PDF filename date.
  //    Under-assessment matters have none of these → skip the detail page.
  //    Matters already completed in the last run are cached → skip the fetch.
  console.log("Fetching detail pages where needed…");
  let fetched = 0;
  let cached = 0;
  for (const r of listing) {
    const needsDetermination = r.status && r.status !== "Under assessment";
    if (!needsDetermination) {
      r.publicationDate = null;
      r.determinationOutcome = null;
      r.filenameDate = null;
      continue;
    }

    const prev = r.caseNumber ? prevByCase.get(r.caseNumber) : null;
    const prevWasComplete =
      prev &&
      prev.status === "Assessment completed" &&
      (prev.publicationDate || prev.determinationDate) &&
      !prev.overridden; // never cache an overridden value as if it were scraped
    if (prevWasComplete) {
      // prev.determinationDate covers migration from the old single-date model.
      r.publicationDate = prev.publicationDate ?? prev.determinationDate ?? null;
      r.determinationOutcome = prev.determinationOutcome || null;
      r.filenameDate = prev.filenameDate ?? null;
      cached++;
      continue;
    }

    const html = await fetchHtml(r.permalink);
    const detail = parseDetail(html);
    r.publicationDate = detail.publicationDate;
    r.determinationOutcome = detail.determinationOutcome;
    r.filenameDate = detail.filenameDate;
    fetched++;
    await sleep(REQUEST_DELAY_MS);
  }
  console.log(`  detail pages: ${fetched} fetched, ${cached} cached`);

  // 3. Resolve the REAL determination date and compute everything mechanically.
  //    Real determination date priority: the committed store (Excel-verified or
  //    previously PDF-derived) → the PDF filename date → the publication date.
  //    Newly derived filename dates are written back to the store below.
  const detStore = await loadDetStore();
  let storeAdded = 0;
  for (const r of listing) {
    let realDet = detStore[r.caseNumber]?.determinationDate || null;
    if (!realDet && r.status === "Assessment completed") {
      if (r.filenameDate) {
        realDet = r.filenameDate;
        detStore[r.caseNumber] = {
          determinationDate: realDet,
          source: "pdf-filename",
        };
        storeAdded++;
      } else {
        realDet = r.publicationDate || null; // best-effort fallback
      }
    }
    r.determinationDate = realDet;

    r.reviewComplete = Boolean(
      r.status === "Assessment completed" && r.determinationDate
    );
    if (r.reviewComplete && r.effectiveDate && r.determinationDate) {
      r.durationBusinessDays = businessDays(
        r.effectiveDate,
        r.determinationDate
      );
    } else {
      r.durationBusinessDays = "—";
    }
    r.overridden = false;
    r.overriddenFields = [];
    r.notes = "";
  }
  if (storeAdded) {
    await writeFile(
      DET_STORE_PATH,
      JSON.stringify(detStore, null, 1) + "\n",
      "utf8"
    );
    console.log(`  added ${storeAdded} PDF-filename determination date(s) to the store.`);
  }

  // 4. Deep-merge overrides on top (override values win, never recomputed away).
  const overrides = await loadOverrides();
  const byCase = new Map(listing.map((r) => [r.caseNumber, r]));
  for (const [caseNumber, override] of Object.entries(overrides)) {
    const rec = byCase.get(caseNumber);
    if (!rec) {
      console.warn(
        `  override for ${caseNumber} did not match any current record (inactive placeholder?)`
      );
      continue;
    }
    applyOverride(rec, override);
    console.log(`  applied override for ${caseNumber}`);
  }

  // 5. Robustness guard: don't let an implausible scrape clobber good data.
  if (previous?.records?.length) {
    const prevCount = previous.records.length;
    if (listing.length < prevCount * (1 - MAX_DROP_RATIO)) {
      throw new Error(
        `Record count dropped from ${prevCount} to ${listing.length} ` +
          `(> ${MAX_DROP_RATIO * 100}% drop). Keeping last good data.json.`
      );
    }
  }

  // 6. Only write when the data actually changed (ignore generatedAt churn).
  const records = listing.map((r) => ({
    caseTitle: r.caseTitle,
    caseNumber: r.caseNumber,
    permalink: r.permalink,
    type: r.type,
    status: r.status,
    stage: r.stage,
    effectiveDate: r.effectiveDate,
    determinationDate: r.determinationDate ?? null,
    publicationDate: r.publicationDate ?? null,
    determinationOutcome: r.determinationOutcome ?? null,
    reviewComplete: r.reviewComplete,
    durationBusinessDays: r.durationBusinessDays,
    overridden: r.overridden,
    overriddenFields: r.overriddenFields,
    notes: r.notes || "",
  }));

  const signature = (recs) =>
    JSON.stringify(recs.map((x) => ({ ...x })));
  if (previous?.records && signature(previous.records) === signature(records)) {
    console.log("No change vs last good data.json — nothing to write.");
    return;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sourceUrl: REGISTER_URL,
    recordCount: records.length,
    records,
  };
  await writeFile(DATA_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`Wrote data.json with ${records.length} records.`);
}

main().catch((err) => {
  console.error("SCRAPE FAILED:", err.message);
  console.error("Last good data.json has been kept unchanged.");
  process.exit(1);
});
