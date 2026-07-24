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

  let EXPORT_DATE = ""; // filename-safe data date, set on boot

  // ---- "Update Now" (trigger the GitHub Action) --------------------------
  const GH_REPO = "aidangilling/accc-register";
  const GH_ACTION_URL = `https://github.com/${GH_REPO}/actions/workflows/update.yml`;

  function showUpdateModal() {
    // Open the workflow page (only someone signed in with repo access can run it).
    window.open(GH_ACTION_URL, "_blank", "noopener");

    let overlay = document.getElementById("update-modal");
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.id = "update-modal";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="update-modal-title">
        <h3 id="update-modal-title">Refresh the register data</h3>
        <p>A GitHub tab has just opened. To pull the latest ACCC data:</p>
        <ol>
          <li>On that GitHub page, click <strong>Run workflow</strong> (grey button, upper right), then <strong>Run workflow</strong> again (green) to confirm.</li>
          <li>Wait about <strong>1–2 minutes</strong> for the run to finish (it shows a green ✓).</li>
          <li>Come back here and click <strong>Reload this page</strong> below.</li>
        </ol>
        <p class="modal-note">You need to be signed in to GitHub with access to this repository. If the tab didn't open, use the button below.</p>
        <div class="modal-actions">
          <button type="button" class="tbl-btn" data-act="open">Open GitHub again</button>
          <button type="button" class="tbl-btn tbl-btn--primary" data-act="reload">Reload this page</button>
          <button type="button" class="tbl-btn" data-act="close">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      const act = e.target && e.target.getAttribute("data-act");
      if (e.target === overlay || act === "close") overlay.remove();
      else if (act === "reload") location.reload();
      else if (act === "open") window.open(GH_ACTION_URL, "_blank", "noopener");
    });
  }

  // Simple result modal (title + message + Reload/Close).
  function showResultModal(title, message, opts) {
    opts = opts || {};
    let overlay = document.getElementById("update-modal");
    if (overlay) overlay.remove();
    overlay = document.createElement("div");
    overlay.id = "update-modal";
    overlay.className = "modal-overlay";
    const actions = opts.busy
      ? `<button type="button" class="tbl-btn" data-act="close">Close</button>`
      : `<button type="button" class="tbl-btn tbl-btn--primary" data-act="reload">Reload this page</button><button type="button" class="tbl-btn" data-act="close">Close</button>`;
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        <div class="modal-actions">${actions}</div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      const act = e.target && e.target.getAttribute("data-act");
      if (e.target === overlay || act === "close") overlay.remove();
      else if (act === "reload") location.reload();
    });
  }

  // If a public update endpoint is configured, trigger it; otherwise fall back
  // to opening GitHub's "Run workflow" page.
  function handleUpdateNow() {
    const endpoint = (window.ACCC_UPDATE_ENDPOINT || "").trim();
    if (!endpoint || /PASTE|YOUR_|example\.com/i.test(endpoint)) {
      showUpdateModal();
      return;
    }
    showResultModal("Refreshing the register", "Starting the update…", { busy: true });
    fetch(endpoint, { method: "POST" })
      .then((r) => r.json().catch(() => ({ message: "Update requested. Reload in 1–2 minutes." })))
      .then((j) =>
        showResultModal(
          "Refreshing the register",
          j.message || "Update requested. Reload the page in 1–2 minutes.",
          {}
        )
      )
      .catch(() =>
        showResultModal(
          "Couldn't reach the updater",
          "Please try again in a moment, or reload the page.",
          {}
        )
      );
  }

  // ---- Excel (.xlsx) export (self-contained, no dependencies) ------------
  function xmlEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    }[c]));
  }
  const _crcTable = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = _crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(files) {
    const u16 = (n) => [n & 255, (n >> 8) & 255];
    const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = f.name, data = f.bytes, crc = crc32(data), size = data.length;
      const lh = [80, 75, 3, 4, ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)];
      parts.push(new Uint8Array(lh), name, data);
      const cd = [80, 75, 1, 2, ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)];
      central.push(new Uint8Array(cd), name);
      offset += lh.length + name.length + size;
    }
    let csize = 0;
    central.forEach((c) => (csize += c.length));
    const eocd = [80, 75, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(csize), ...u32(offset), ...u16(0)];
    const all = [...parts, ...central, new Uint8Array(eocd)];
    let total = 0;
    all.forEach((a) => (total += a.length));
    const out = new Uint8Array(total);
    let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }
  function colLetter(i) {
    let s = "";
    i++;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function sheetXml(headers, rows) {
    const widths = headers.map((h, ci) => {
      let w = String(h).length;
      for (const r of rows) { const v = r[ci]; const l = v == null ? 0 : String(v).length; if (l > w) w = l; }
      return Math.min(Math.max(w + 2, 8), 60);
    });
    const cols = "<cols>" + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + "</cols>";
    const cell = (ci, ri, v, s) => {
      const ref = colLetter(ci) + (ri + 1);
      if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ""}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    };
    let body = `<row r="1">` + headers.map((h, ci) => cell(ci, 0, h, 1)).join("") + `</row>`;
    rows.forEach((r, ri) => { body += `<row r="${ri + 2}">` + r.map((v, ci) => cell(ci, ri + 1, v, 0)).join("") + `</row>`; });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
  }
  function buildXlsx(sheetName, headers, rows) {
    const enc = new TextEncoder();
    const safeName = String(sheetName).replace(/[:\\/?*\[\]]/g, " ").slice(0, 31);
    const files = [
      { name: "[Content_Types].xml", str: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: "_rels/.rels", str: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", str: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", str: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/styles.xml", str: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
      { name: "xl/worksheets/sheet1.xml", str: sheetXml(headers, rows) },
    ];
    return zipStore(files.map((f) => ({ name: enc.encode(f.name), bytes: enc.encode(f.str) })));
  }
  function downloadXlsx(filename, sheetName, headers, rows) {
    const bytes = buildXlsx(sheetName, headers, rows);
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  // The exact value shown in each table cell (plain text, for export).
  function exportValue(key, r) {
    switch (key) {
      case "caseTitle": return r.caseTitle || "";
      case "reviewComplete": return r.reviewComplete ? "Yes" : "No";
      case "determinationOutcome": return r.determinationOutcome || "—";
      case "status": return r.status || "—";
      case "stage": return r.stage || "—";
      case "effectiveDate": return fmtDate(r.effectiveDate) || "—";
      case "determinationDate": return fmtDate(r.determinationDate) || "—";
      case "publicationDate": return fmtDate(r.publicationDate) || "—";
      case "durationBusinessDays":
        return isNum(r.durationBusinessDays) ? r.durationBusinessDays : "—";
      default: return "";
    }
  }

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
        cell: (r) => {
          const o = r.determinationOutcome;
          if (!o) return '<span class="dash">—</span>';
          const lo = o.toLowerCase();
          // green if approved, red if not approved, neutral otherwise
          let cls = "yn--na";
          if (lo.includes("not approved")) cls = "yn--no";
          else if (lo.includes("approved")) cls = "yn--yes";
          return `<span class="yn ${cls}">${esc(o)}</span>`;
        },
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
        key: "publicationDate",
        label: "Determination Publication Date",
        sortVal: (r) => r.publicationDate || "",
        cell: (r) =>
          fmtDate(r.publicationDate) || '<span class="dash">—</span>',
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
  function renderTable(sectionEl, host, records, isNotification, filters, label) {
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
      </div>
      <div class="table-actions">
        <button type="button" class="tbl-btn tbl-btn--update" title="Fetch the latest ACCC data">&#8635;&nbsp;Update Now</button>
        <button type="button" class="tbl-btn tbl-btn--export" title="Download this table as Excel">&#8681;&nbsp;Export to Excel</button>
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

    // Bottom-right actions: Update Now + Export to Excel.
    host.querySelector(".tbl-btn--update").addEventListener("click", handleUpdateNow);
    host.querySelector(".tbl-btn--export").addEventListener("click", () => {
      const rows = filtered(); // current view — respects filters + sort
      const headers = cols.map((c) => c.label);
      const data = rows.map((r) => cols.map((c) => exportValue(c.key, r)));
      const base = `ACCC ${label}${EXPORT_DATE ? " " + EXPORT_DATE : ""}`;
      downloadXlsx(base.replace(/\s+/g, "_") + ".xlsx", label, headers, data);
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
    const table = renderTable(el, tableHost, records, isNotification, filters, title);

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
    EXPORT_DATE = String(generatedAt).slice(0, 10); // YYYY-MM-DD for filenames

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
