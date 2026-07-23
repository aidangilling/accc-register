/* ACCC Acquisitions Register mirror — front-end
   Reads data.json (written by the scheduled scraper) and renders two sections:
   Phase 1 & 2 Notifications, and Waivers. No framework, no build step. */

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

  function fmtTimestampSydney(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(d);
    } catch (e) {
      return d.toISOString();
    }
  }

  function fmtDateShortSydney(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    try {
      return new Intl.DateTimeFormat("en-AU", {
        timeZone: "Australia/Sydney",
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(d);
    } catch (e) {
      return iso;
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
      // Outcome tally: every completed matter that has a recorded outcome,
      // even the few where the ACCC page omits a determination date (those
      // still can't have a computed duration — see below).
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

  function statRow(k, v) {
    return `<div class="statrow"><span class="k">${esc(k)}</span><span class="v">${esc(
      v
    )}</span></div>`;
  }

  function renderStats(stats, isNotification, headlineLabel, asatDate) {
    const groups = [];

    groups.push(`
      <div class="statgroup statgroup--headline">
        <h3>${esc(headlineLabel)}</h3>
        <div class="big">${stats.total}</div>
        <div class="sub">as at COB ${esc(asatDate)}</div>
      </div>`);

    groups.push(`
      <div class="statgroup">
        <h3>By status</h3>
        ${statRow("Under assessment", stats.status["Under assessment"] || 0)}
        ${statRow("Completed", stats.status["Assessment completed"] || 0)}
        ${statRow("Ceased", stats.status["Assessment ceased"] || 0)}
        ${statRow("Suspended", stats.status["Assessment suspended"] || 0)}
      </div>`);

    if (isNotification) {
      groups.push(`
        <div class="statgroup">
          <h3>By stage</h3>
          ${statRow("Phase 1", stats.stage["Phase 1"])}
          ${statRow("Phase 2", stats.stage["Phase 2"])}
          ${statRow("Public benefit", stats.stage["Public benefit"])}
        </div>`);
    }

    const outcomeKeys = Object.keys(stats.outcome).sort();
    const outcomeRows = outcomeKeys.length
      ? outcomeKeys.map((k) => statRow(k, stats.outcome[k])).join("")
      : `<div class="statrow"><span class="k">No completed matters yet</span><span class="v">—</span></div>`;
    groups.push(`
      <div class="statgroup">
        <h3>Completed — outcome</h3>
        ${outcomeRows}
      </div>`);

    groups.push(`
      <div class="statgroup">
        <h3>Completed — duration (business days)</h3>
        ${statRow("Average", stats.avgDuration == null ? "—" : stats.avgDuration)}
        ${statRow("Median", stats.medianDuration == null ? "—" : stats.medianDuration)}
        ${statRow("Sample (n)", stats.durations.length)}
      </div>`);

    return `<div class="stats">${groups.join("")}</div>`;
  }

  // ---- table -------------------------------------------------------------
  // Column definitions per section. `key` drives sorting; `sortVal` extracts
  // a comparable value; `cell` renders the HTML.
  function columns(isNotification) {
    const cols = [
      {
        key: "caseTitle",
        label: "Case title",
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
        key: "caseNumber",
        label: "Case no.",
        cls: "casenum",
        sortVal: (r) => (r.caseNumber || "").toLowerCase(),
        cell: (r) => esc(r.caseNumber || "—"),
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
        label: "Effective date",
        sortVal: (r) => r.effectiveDate || "",
        cell: (r) =>
          fmtDate(r.effectiveDate) ||
          '<span class="dash">—</span>',
      },
      {
        key: "determinationDate",
        label: "Determination date",
        sortVal: (r) => r.determinationDate || "",
        cell: (r) =>
          fmtDate(r.determinationDate) ||
          '<span class="dash">—</span>',
      },
      {
        key: "durationBusinessDays",
        label: "Duration (bus. days)",
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
      }
    );

    return cols;
  }

  function renderTable(container, records, isNotification) {
    const cols = columns(isNotification);
    const state = { sortKey: "effectiveDate", dir: -1, query: "" };

    const thead = cols
      .map(
        (c, i) =>
          `<th data-i="${i}"${c.num ? ' class="num"' : ""} aria-sort="none">${esc(
            c.label
          )}<span class="arrow">▲▼</span></th>`
      )
      .join("");

    container.innerHTML = `
      <div class="toolbar">
        <div class="search">
          <input type="search" placeholder="Filter ${
            isNotification ? "notifications" : "waivers"
          }…" aria-label="Filter table" />
        </div>
        <div class="count"></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${thead}</tr></thead>
          <tbody></tbody>
        </table>
      </div>`;

    const tbody = container.querySelector("tbody");
    const ths = container.querySelectorAll("thead th");
    const countEl = container.querySelector(".count");
    const searchEl = container.querySelector('input[type="search"]');

    function filtered() {
      const q = state.query.trim().toLowerCase();
      let rows = records;
      if (q) {
        rows = records.filter((r) =>
          [
            r.caseTitle,
            r.caseNumber,
            r.status,
            r.stage,
            r.determinationOutcome,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q)
        );
      }
      const col = cols.find((c) => c.key === state.sortKey) || cols[0];
      rows = rows.slice().sort((a, b) => {
        const va = col.sortVal(a);
        const vb = col.sortVal(b);
        if (va < vb) return -1 * state.dir;
        if (va > vb) return 1 * state.dir;
        // tie-break by title for stability
        return (a.caseTitle || "").localeCompare(b.caseTitle || "");
      });
      return rows;
    }

    function draw() {
      const rows = filtered();
      countEl.textContent = `${rows.length} of ${records.length}`;
      if (!rows.length) {
        tbody.innerHTML = `<tr><td class="empty" colspan="${cols.length}">No matching records.</td></tr>`;
        return;
      }
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
      // reflect sort state on headers
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
          // dates & numbers default to descending (newest / largest first)
          state.dir = c.num || c.key.endsWith("Date") ? -1 : 1;
        }
        draw();
      });
    });

    let t;
    searchEl.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.query = searchEl.value;
        draw();
      }, 120);
    });

    draw();
  }

  // ---- section assembly --------------------------------------------------
  function renderSection(el, opts) {
    const { title, headlineLabel, records, isNotification, generatedAt } = opts;
    const asatDate = fmtDateShortSydney(generatedAt);
    const stats = computeStats(records, isNotification);

    const head = document.createElement("div");
    head.className = "section-head";
    head.innerHTML = `
      <h2>${esc(title)}</h2>
      <div class="headline">Total <strong>${esc(headlineLabel)}</strong> as at COB ${esc(
      asatDate
    )}: <strong>${records.length}</strong></div>`;
    el.appendChild(head);

    const statsWrap = document.createElement("div");
    statsWrap.innerHTML = renderStats(
      stats,
      isNotification,
      "Total " + headlineLabel,
      asatDate
    );
    el.appendChild(statsWrap.firstElementChild);

    const tableHost = document.createElement("div");
    el.appendChild(tableHost);
    renderTable(tableHost, records, isNotification);

    const asat = document.createElement("p");
    asat.className = "asat";
    asat.innerHTML = `Data as at <strong>${esc(
      fmtTimestampSydney(generatedAt)
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
