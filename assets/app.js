/* ACCC Acquisitions Register mirror — front-end
   Reads data.json (written by the scheduled scraper) and renders two sections:
   Phase 1 & 2 Notifications, and Waivers. No framework, no build step.

   The summary stat rows double as filters: click a status / stage / outcome to
   filter the table below. Multiple selections combine (same category = OR,
   across categories = AND), and combine with the search box too. */

(function () {
  "use strict";

  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];

  // ---- formatting helpers ------------------------------------------------
  function fmtDate(iso) {
    if (!iso || typeof iso !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }

  // e.g. "Thu, 23 July 2026, 10:54 am AEST"
  function fmtFullSydney(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "short",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d);
    } catch (e) {
      return d.toISOString();
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  const isNum = (v) => typeof v === "number" && isFinite(v);

  function statusClass(status) {
    const s = (status || "").toLowerCase();
    if (s.includes("under")) return "pill--under";
    if (s.includes("completed")) return "pill--completed";
    if (s.includes("ceased")) return "pill--ceased";
    if (s.includes("suspended")) return "pill--suspended";
    return "pill--under";
  }

  function stageBucket(stage) {
    const s = (stage || "").toLowerCase();
    if (s.includes("phase 1")) return "Phase 1";
    if (s.includes("phase 2")) return "Phase 2";
    if (s.includes("public benefit")) return "Public benefit";
    return "Other";
  }

  // ---- statistics --------------------------------------------------------
  function median(nums) {
    if (!nums.length) return null;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function computeStats(records, isNotification) {
    const stats = {
      total: records.length,
      status: {
        "Under assessment": 0,
        "Assessment completed": 0,
        "Assessment ceased": 0,
        "Assessment suspended": 0,
      },
      stage: { "Phase 1": 0, "Phase 2": 0, "Public benefit": 0 },
      outcome: {},
      durations: [],
    };
    for (const r of records) {
      if (r.status in stats.status) stats.status[r.status] += 1;
      else stats.status[r.status] = (stats.status[r.status] || 0) + 1;

      if (isNotification) {
        const b = stageBucket(r.stage);
        if (b in stats.stage) stats.stage[b] += 1;
      }
      // Outcome tally: every completed matter that has a recorded outcome.
      if (r.status === "Assessment completed" && r.determinationOutcome) {
        const o = r.determinationOutcome;
        stats.outcome[o] = (stats.outcome[o] || 0) + 1;
      }
      // Duration stats: only where a duration is actually computable.
      if (r.reviewComplete && isNum(r.durationBusinessDays)) {
        stats.durations.push(r.durationBusinessDays);
      }
    }
    const d = stats.durations;
    stats.avgDuration = d.length
      ? Math.round((d.reduce((a, b) => a + b, 0) / d.length) * 10) / 10
      : null;
    stats.medianDuration = median(d);
    return stats;
  }

  // ---- stat cards (rows are clickable filters) ---------------------------
  function plainRow(k, v) {
    return `<div class="statrow"><span class="k">${esc(k)}</span><span class="v">${esc(
      v
    )}</span></div>`;
  }

  function facetRow(facet, value, label, count) {
    return `<div class="statrow selectable" role="button" tabindex="0" aria-pressed="false" data-facet="${esc(
      facet
    )}" data-value="${esc(value)}"><span class="k">${esc(
      label
    )}</span><span class="v">${esc(count)}</span></div>`;
  }

  function renderStats(stats, isNotification, headlineLabel, stamp) {
    const groups = [];

    groups.push(`
      <div class="statgroup statgroup--headline">
        <h3>${esc(headlineLabel)}</h3>
        <div class="big">${stats.total}</div>
        <div class="sub">as at ${esc(stamp)}</div>
      </div>`);

    groups.push(`
      <div class="statgroup">
        <h3>By status</h3>
        ${facetRow("status", "Under assessment", "Under assessment", stats.status["Under assessment"] || 0)}
        ${facetRow("status", "Assessment completed", "Completed", stats.status["Assessment completed"] || 0)}
        ${facetRow("status", "Assessment ceased", "Ceased", stats.status["Assessment ceased"] || 0)}
        ${facetRow("status", "Assessment suspended", "Suspended", stats.status["Assessment suspended"] || 0)}
      </div>`);

    if (isNotification) {
      groups.push(`
        <div class="statgroup">
          <h3>By stage</h3>
          ${facetRow("stage", "Phase 1", "Phase 1", stats.stage["Phase 1"])}
          ${facetRow("stage", "Phase 2", "Phase 2", stats.stage["Phase 2"])}
          ${facetRow("stage", "Public benefit", "Public benefit", stats.stage["Public benefit"])}
        </div>`);
    }

    const outcomeKeys = Object.keys(stats.outcome).sort();
    const outcomeRows = outcomeKeys.length
      ? outcomeKeys
          .map((k) => facetRow("outcome", k, k, stats.outcome[k]))
          .join("")
      : plainRow("No completed matters yet", "—");
    groups.push(`
      <div class="statgroup">
        <h3>Completed — outcome</h3>
        ${outcomeRows}
      </div>`);

    groups.push(`
      <div class="statgroup">
        <h3>Completed — duration (business days)</h3>
        ${plainRow("Average", stats.avgDuration == null ? "—" : stats.avgDuration)}
        ${plainRow("Median", stats.medianDuration == null ? "—" : stats.medianDuration)}
      </div>`);

    return `<div class="stats">${groups.join("")}</div>`;
  }

  // ---- table columns -----------------------------------------------------
  function columns(isNotification) {
    const cols = [
      {
        key: "caseTitle",
        label: "Case Title",
        cls: "title-cell",
        sortVal: (r) => (r.caseTitle || "").toLowerCase(),
        cell: (r) => {
          const tag = r.overridden
            ? ` <span class="tag tag--manual" title="${esc(
                r.notes || "Manually adjusted"
              )}">manual</span>`
            : "";
          const link = r.permalink
            ? `<a href="${esc(r.permalink)}" rel="noopener" target="_blank">${esc(
                r.caseTitle || "(untitled)"
              )}</a>`
            : esc(r.caseTitle || "(untitled)");
          return link + tag;
        },
      },
      {
        key: "reviewComplete",
        label: "Review Completed?",
        cls: "center",
        sortVal: (r) => (r.reviewComplete ? 1 : 0),
        cell: (r) =>
          r.reviewComplete
            ? '<span class="yn yn--yes">Yes</span>'
            : '<span class="yn yn--no">No</span>',
      },
      {
        key: "determinationOutcome",
        label: "Outcome",
        cls: "outcome",
        sortVal: (r) => (r.determinationOutcome || "").toLowerCase(),
        cell: (r) =>
          r.determinationOutcome
            ? esc(r.determinationOutcome)
            : '<span class="dash">—</span>',
      },
      {
        key: "status",
        label: "Status",
        sortVal: (r) => (r.status || "").toLowerCase(),
        cell: (r) =>
          `<span class="pill ${statusClass(r.status)}">${esc(
            r.status || "—"
          )}</span>`,
      },
    ];

    if (isNotification) {
      cols.push({
        key: "stage",
        label: "Stage",
        sortVal: (r) => (r.stage || "").toLowerCase(),
        cell: (r) => esc(r.stage || "—"),
      });
    }

    cols.push(
      {
        key: "effectiveDate",
        label: "Effective Date",
        sortVal: (r) => r.effectiveDate || "",
        cell: (r) => fmtDate(r.effectiveDate) || '<span class="dash">—</span>',
      },
      {
        key: "determinationDate",
        label: "Determination Date",
        sortVal: (r) => r.determinationDate || "",
        cell: (r) =>
          fmtDate(r.determinationDate) || '<span class="dash">—</span>',
      },
      {
        key: "durationBusinessDays",
        label: "Duration (Bus. Days)",
        cls: "num",
        num: true,
        sortVal: (r) =>
          isNum(r.durationBusinessDays)
            ? r.durationBusinessDays
            : Number.NEGATIVE_INFINITY,
        cell: (r) =>
          isNum(r.durationBusinessDays)
            ? String(r.durationBusinessDays)
            : '<span class="dash">—</span>',
      }
    );

    return cols;
  }

  // ---- filtering ---------------------------------------------------------
  function recordMatches(r, filters) {
    if (filters.query) {
      const hay = [
        r.caseTitle,
        r.caseNumber,
        r.status,
        r.stage,
        r.determinationOutcome,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(filters.query)) return false;
    }
    if (filters.status.size && !filters.status.has(r.status)) return false;
    if (filters.stage.size && !filters.stage.has(stageBucket(r.stage)))
      return false;
    if (filters.outcome.size && !filters.outcome.has(r.determinationOutcome))
      return false;
    return true;
  }

  function anyActive(filters) {
    return (
      filters.query ||
      filters.status.size ||
      filters.stage.size ||
      filters.outcome.size
    );
  }

  // ---- table -------------------------------------------------------------
  function renderTable(sectionEl, host, records, isNotification, filters) {
    const cols = columns(isNotification);
    const state = { sortKey: "effectiveDate", dir: -1 };

    const thead = cols
      .map(
        (c, i) =>
          `<th data-i="${i}"${c.num ? ' class="num"' : ""} aria-sort="none">${esc(
            c.label
          )}<span class="arrow">▲▼</span></th>`
      )
      .join("");

    host.innerHTML = `
      <div class="toolbar">
        <div class="search">
          <input type="search" placeholder="Filter ${
            isNotification ? "notifications" : "waivers"
          }…" aria-label="Filter table" />
        </div>
        <button type="button" class="clear-filters" hidden>Clear filters ✕</button>
        <div class="count"></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${thead}</tr></thead>
          <tbody></tbody>
        </table>
      </div>`;

    const tbody = host.querySelector("tbody");
    const ths = host.querySelectorAll("thead th");
    const countEl = host.querySelector(".count");
    const searchEl = host.querySelector('input[type="search"]');
    const clearEl = host.querySelector(".clear-filters");

    function filtered() {
      let rows = records.filter((r) => recordMatches(r, filters));
      const col = cols.find((c) => c.key === state.sortKey) || cols[0];
      rows = rows.slice().sort((a, b) => {
        const va = col.sortVal(a);
        const vb = col.sortVal(b);
        if (va < vb) return -1 * state.dir;
        if (va > vb) return 1 * state.dir;
        return (a.caseTitle || "").localeCompare(b.caseTitle || "");
      });
      return rows;
    }

    function redraw() {
      const rows = filtered();
      countEl.textContent = `${rows.length} of ${records.length}`;
      clearEl.hidden = !anyActive(filters);
      if (!rows.length) {
        tbody.innerHTML = `<tr><td class="empty" colspan="${cols.length}">No matching records.</td></tr>`;
      } else {
        tbody.innerHTML = rows
          .map(
            (r) =>
              "<tr>" +
              cols
                .map(
                  (c) =>
                    `<td${c.cls ? ` class="${c.cls}"` : ""}>${c.cell(r)}</td>`
                )
                .join("") +
              "</tr>"
          )
          .join("");
      }
      ths.forEach((th) => {
        const c = cols[Number(th.dataset.i)];
        th.setAttribute(
          "aria-sort",
          c.key === state.sortKey
            ? state.dir === 1
              ? "ascending"
              : "descending"
            : "none"
        );
      });
    }

    ths.forEach((th) => {
      th.addEventListener("click", () => {
        const c = cols[Number(th.dataset.i)];
        if (state.sortKey === c.key) {
          state.dir *= -1;
        } else {
          state.sortKey = c.key;
          state.dir = c.num || c.key.endsWith("Date") ? -1 : 1;
        }
        redraw();
      });
    });

    let t;
    searchEl.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        filters.query = searchEl.value.trim().toLowerCase();
        redraw();
      }, 120);
    });

    clearEl.addEventListener("click", () => {
      filters.status.clear();
      filters.stage.clear();
      filters.outcome.clear();
      filters.query = "";
      searchEl.value = "";
      sectionEl.querySelectorAll(".statrow.selectable.active").forEach((el) => {
        el.classList.remove("active");
        el.setAttribute("aria-pressed", "false");
      });
      redraw();
    });

    redraw();
    return { redraw };
  }

  // ---- section assembly --------------------------------------------------
  function renderSection(el, opts) {
    const { title, headlineLabel, records, isNotification, generatedAt } = opts;
    const stamp = fmtFullSydney(generatedAt);
    const stats = computeStats(records, isNotification);
    const filters = {
      status: new Set(),
      stage: new Set(),
      outcome: new Set(),
      query: "",
    };

    const head = document.createElement("div");
    head.className = "section-head";
    head.innerHTML = `
      <h2>${esc(title)}</h2>
      <div class="headline">Total <strong>${esc(
        headlineLabel
      )}</strong> as at ${esc(stamp)}: <strong>${records.length}</strong></div>`;
    el.appendChild(head);

    const statsWrap = document.createElement("div");
    statsWrap.innerHTML = renderStats(
      stats,
      isNotification,
      "Total " + headlineLabel,
      stamp
    );
    el.appendChild(statsWrap.firstElementChild);

    const tableHost = document.createElement("div");
    el.appendChild(tableHost);
    const table = renderTable(el, tableHost, records, isNotification, filters);

    // Wire the clickable stat rows to the table's filter.
    el.querySelectorAll(".statrow.selectable").forEach((rowEl) => {
      const toggle = () => {
        const set = filters[rowEl.dataset.facet];
        const value = rowEl.dataset.value;
        if (set.has(value)) set.delete(value);
        else set.add(value);
        const on = set.has(value);
        rowEl.classList.toggle("active", on);
        rowEl.setAttribute("aria-pressed", on ? "true" : "false");
        table.redraw();
      };
      rowEl.addEventListener("click", toggle);
      rowEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });

    const asat = document.createElement("p");
    asat.className = "asat";
    asat.innerHTML = `Data as at <strong>${esc(
      stamp
    )}</strong> (Australia/Sydney).`;
    el.appendChild(asat);
  }

  // ---- staleness ---------------------------------------------------------
  function checkStaleness(generatedAt) {
    const banner = document.getElementById("staleness");
    const d = new Date(generatedAt);
    if (isNaN(d)) return;
    const ageHours = (Date.now() - d.getTime()) / 3600000;
    if (ageHours > 24) {
      banner.textContent =
        "Register data may be delayed — the ACCC sometimes publishes entries late, particularly waivers.";
      banner.hidden = false;
    }
  }

  // ---- boot --------------------------------------------------------------
  function fail(msg) {
    const err = document.getElementById("error");
    err.textContent = msg;
    err.hidden = false;
    const loading = document.getElementById("loading");
    if (loading) loading.hidden = true;
  }

  async function boot() {
    let data;
    try {
      const res = await fetch("data.json?_=" + Date.now(), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) {
      fail(
        "Could not load register data (data.json). If this site was just set up, the update workflow may not have run yet."
      );
      return;
    }

    const loading = document.getElementById("loading");
    if (loading) loading.hidden = true;

    const records = Array.isArray(data.records) ? data.records : [];
    const generatedAt = data.generatedAt || new Date().toISOString();

    const notifications = records.filter((r) => r.type === "Notification");
    const waivers = records.filter((r) => r.type === "Waiver");

    renderSection(document.getElementById("section-notifications"), {
      title: "Phase 1 & 2 Notifications",
      headlineLabel: "Phase 1 & 2 Applications",
      records: notifications,
      isNotification: true,
      generatedAt,
    });

    renderSection(document.getElementById("section-waivers"), {
      title: "Waivers",
      headlineLabel: "Waivers",
      records: waivers,
      isNotification: false,
      generatedAt,
    });

    checkStaleness(generatedAt);
  }

  document.addEventListener("DOMContentLoaded", boot);
})();

/* Table zoom control — shrinks the tables so more columns/rows fit.
   100% = current size (max); zooms out to 50%. */
(function () {
  "use strict";
  var MIN = 0.5,
    MAX = 1,
    STEP = 0.1,
    z = MAX;

  function apply() {
    document.documentElement.style.setProperty("--table-zoom", String(z));
    var lvl = document.getElementById("zoom-level");
    if (lvl) lvl.textContent = Math.round(z * 100) + "%";
    var zin = document.getElementById("zoom-in");
    var zout = document.getElementById("zoom-out");
    if (zin) zin.disabled = z >= MAX - 0.001;
    if (zout) zout.disabled = z <= MIN + 0.001;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var zin = document.getElementById("zoom-in");
    var zout = document.getElementById("zoom-out");
    if (zout)
      zout.addEventListener("click", function () {
        z = Math.max(MIN, Math.round((z - STEP) * 100) / 100);
        apply();
      });
    if (zin)
      zin.addEventListener("click", function () {
        z = Math.min(MAX, Math.round((z + STEP) * 100) / 100);
        apply();
      });
    apply();
  });
})();
