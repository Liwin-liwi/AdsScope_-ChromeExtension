/* ============================================================================
 * AdScope for Meta Ad Library — content script
 * ----------------------------------------------------------------------------
 * Replicates the "Ads Library Tracker" UX: a green info CARD stacked ON TOP of
 * every ad (in normal flow, so it never overlaps the Meta card), a top-right
 * summary panel, and a toolbar. Per ad it shows:
 *   • Days running   → REAL   (from Meta's "Started running on" date)
 *   • Per-day budget → MODEL  (assumed daily budget × variation factor)
 *   • Est. spend     → MODEL  (days × per-day budget)
 *   • Est. views      → MODEL  (est. spend ÷ CPM × 1000)
 * Real disclosed figures (political / EU ads, <100 "Low Impression") shown green.
 *
 * ROBUSTNESS: anchor ONLY on stable visible text ("Library ID:", "Started
 * running on") — never CSS classes (Meta rotates them) or "Sponsored" (Meta
 * poisons it). "Library ID:" and its digits are often SPLIT across nodes, so we
 * match the label and read the number from the card's concatenated textContent.
 * The grid is virtualized (cards recycle) → we dedupe by Library ID.
 * ==========================================================================*/
(() => {
  "use strict";

  const DONE_ATTR = "data-adscope-done";
  const LIB_ATTR = "data-adscope-lib";

  const DEFAULT_SETTINGS = {
    enabled: true,
    currency: "INR",
    showSpend: true,
    showViews: true,
    presets: {
      INR: { dailyBudget: 650, cpm: 150 }, // central India-edtech band (research)
      USD: { dailyBudget: 30, cpm: 12 },
    },
  };

  let SETTINGS = DEFAULT_SETTINGS;
  const adStore = new Map();      // libraryId -> ad record (deduped)
  let advCounts = new Map();      // advertiser -> # active ads scanned
  let summaryHidden = false;

  // ---- Utilities ---------------------------------------------------------
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const CURRENCY_SYMBOL = { INR: "₹", USD: "$" };

  function fmtMoney(n, currency) {
    const sym = CURRENCY_SYMBOL[currency] || "";
    if (!isFinite(n) || n <= 0) return sym + "0";
    if (currency === "INR") {
      if (n >= 1e7) return sym + (n / 1e7).toFixed(n >= 1e8 ? 0 : 1) + "Cr";
      if (n >= 1e5) return sym + (n / 1e5).toFixed(n >= 1e6 ? 0 : 1) + "L";
      if (n >= 1e3) return sym + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
      return sym + Math.round(n);
    }
    if (n >= 1e9) return sym + (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return sym + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return sym + (n / 1e3).toFixed(1) + "K";
    return sym + Math.round(n);
  }
  function fmtCount(n) {
    if (!isFinite(n) || n <= 0) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  const cur = () => SETTINGS.currency;
  const preset = () =>
    (SETTINGS.presets && SETTINGS.presets[SETTINGS.currency]) ||
    DEFAULT_SETTINGS.presets[SETTINGS.currency] || DEFAULT_SETTINGS.presets.INR;

  // ---- Card discovery ----------------------------------------------------
  function findLibraryIdNodes() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue;
        if (!v || !/Library ID:/i.test(v)) return NodeFilter.FILTER_SKIP;
        // Never re-scan our OWN injected UI (panels/summary/toolbar) — those also
        // contain "Library ID:" text and would otherwise create phantom cards.
        for (let p = node.parentElement; p; p = p.parentElement) {
          if (p.hasAttribute && (p.hasAttribute("data-adscope-badge") || (p.id && /^adscope-/.test(p.id))))
            return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function getCardRoot(libIdNode) {
    let el = libIdNode.parentElement;
    for (let i = 0; i < 22 && el; i++, el = el.parentElement) {
      const t = el.textContent || "";
      if (/Library ID:\s*\d/.test(t) && CARD_DATE_RE.test(t)) {
        // A single ad card holds exactly ONE "Library ID:". More than one means
        // we climbed into a multi-card container (grid/body) — not a card, bail.
        return (t.match(/Library ID:/gi) || []).length === 1 ? el : null;
      }
    }
    return null; // fail closed rather than grabbing the whole grid
  }

  // ---- Field parsing -----------------------------------------------------
  const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
  const CARD_DATE_RE = new RegExp(
    `(Started running on|Ran from|Started running|(?:${MONTHS})[a-z]*\\s+\\d{1,2},?\\s+\\d{4})`, "i"
  );

  function parseDate(str) {
    if (!str) return null;
    const s = str.trim();
    const t = Date.parse(s);
    if (!isNaN(t)) return new Date(t);
    const m = s.match(new RegExp(`(\\d{1,2})\\s+(${MONTHS})[a-z]*\\s+(\\d{4})`, "i"));
    if (m) { const d = Date.parse(`${m[2]} ${m[1]}, ${m[3]}`); if (!isNaN(d)) return new Date(d); }
    return null;
  }

  function extractDates(text) {
    let m = text.match(new RegExp(`Started running on\\s+([A-Za-z0-9,\\s]+?\\d{4})\\s*[-–]\\s*([A-Za-z0-9,\\s]+?\\d{4})`, "i"));
    if (m) return { start: parseDate(m[1]), end: parseDate(m[2]) };
    m = text.match(/Ran from\s+(.+?\d{4})\s+to\s+(.+?\d{4})/i);
    if (m) return { start: parseDate(m[1]), end: parseDate(m[2]) };
    m = text.match(/Started running on\s+([A-Za-z0-9,\s]+?\d{4})/i);
    if (m) return { start: parseDate(m[1]), end: null };
    m = text.match(new RegExp(`(${MONTHS})[a-z]*\\s+\\d{1,2},?\\s+\\d{4}`, "i"));
    if (m) return { start: parseDate(m[0]), end: null };
    return { start: null, end: null };
  }

  function parseRealFigures(text) {
    const real = {};
    let m = text.match(/\bImpressions\b\s*:?\s*((?:[<≤]\s?[\d.,]+\s?[KMB]?)|(?:[\d.,]+\s?[KMB]?\s?[-–]\s?[<≤]?\s?[\d.,]+\s?[KMB]?))/);
    if (m) real.impressions = m[1].replace(/\s+/g, " ").trim();
    m = text.match(/Amount spent[^0-9<≤$₹£€]{0,14}([<≤]?\s?[$₹£€]\s?[\d.,]+\s?[KMB]?(?:\s?[-–]\s?[$₹£€]?\s?[\d.,]+\s?[KMB]?)?)/i);
    if (m) real.spend = m[1].replace(/\s+/g, " ").trim();
    m = text.match(/Total reach in EU[^0-9]{0,18}([\d.,]+\s?[KMB]?(?:\s?[-–]\s?[\d.,]+\s?[KMB]?)?)/i);
    if (m) real.euReach = m[1].replace(/\s+/g, " ").trim();
    return real;
  }

  function parseCard(card) {
    const text = card.textContent || "";
    const libMatch = text.match(/Library ID:\s*(\d+)/i);
    const libraryId = libMatch ? libMatch[1] : null;

    const beforeId = text.split(/Library ID:/i)[0] || "";
    const active = !/\bInactive\b/i.test(beforeId);

    const { start, end } = extractDates(text);

    let variations = 1;
    const vMatch = text.match(/(\d+)\s+ads use this/i);
    if (vMatch) variations = clamp(parseInt(vMatch[1], 10) || 1, 1, 200);
    else if (/multiple versions/i.test(text)) variations = 2;

    const lowImpressions = /Low Impression Count/i.test(text);

    const platforms = [];
    ["Facebook", "Instagram", "Audience Network", "Messenger", "Threads", "WhatsApp"].forEach((p) => {
      if (card.querySelector(`[aria-label*="${p}"]`)) platforms.push(p);
    });

    let pageName = null;
    for (const a of card.querySelectorAll("a[href]")) {
      const t = (a.textContent || "").trim();
      if (t && t.length <= 60 && !/^Library ID/i.test(t) && !/^\d+$/.test(t) &&
        !/Learn More|Shop Now|Sign Up|See more|Send Message|Book Now|Download|Get offer|Contact us|Apply Now|Subscribe|Order Now|Get Quote/i.test(t)) {
        pageName = t; break;
      }
    }

    const real = parseRealFigures(text);
    return { libraryId, active, start, end, variations, lowImpressions, platforms, pageName, real };
  }

  // ---- Estimation --------------------------------------------------------
  function computeMetrics(parsed) {
    const now = Date.now();
    const dayF = (a, b) => Math.max(0.5, (b - a) / 86400000);
    let daysFloat = 0, durationKnown = false;
    const hasDate = !!parsed.start;

    if (parsed.start) {
      if (parsed.end) { daysFloat = dayF(parsed.start.getTime(), parsed.end.getTime()); durationKnown = true; }
      else if (parsed.active) { daysFloat = dayF(parsed.start.getTime(), now); durationKnown = true; }
      else { daysFloat = dayF(parsed.start.getTime(), now); durationKnown = false; }
    }

    const p = preset();
    const varBoost = clamp(1 + 0.35 * Math.max(0, (parsed.variations || 1) - 1), 1, 4);
    const perDay = p.dailyBudget * varBoost;       // effective per-day budget
    const spend = daysFloat * perDay;
    const views = p.cpm > 0 ? (spend / p.cpm) * 1000 : 0;

    return {
      hasDate, daysFloat, durationKnown, varBoost, perDay, spend, views,
      spendLow: spend * 0.4, spendHigh: spend * 3,
    };
  }

  // ---- Per-ad panel ------------------------------------------------------
  function longevityClass(days) {
    if (days >= 30) return "adscope-win";
    if (days >= 7) return "adscope-mid";
    return "adscope-new";
  }

  function tile(val, label, kind) {
    return `<div class="adscope-tile ${kind || ""}">
      <div class="adscope-tv">${escapeHtml(val)}</div>
      <div class="adscope-tl">${escapeHtml(label)}</div></div>`;
  }

  function buildPanel(parsed, metrics) {
    const c = cur();
    const panel = document.createElement("div");
    panel.className = "adscope-panel " + (metrics.hasDate ? longevityClass(metrics.daysFloat) : "adscope-new");
    panel.setAttribute("data-adscope-badge", "1");
    if (parsed.pageName) panel.setAttribute("data-adscope-adv", parsed.pageName);

    const daysStr = metrics.hasDate ? metrics.daysFloat.toFixed(1) : "—";
    const runBadge = !metrics.hasDate
      ? `<span class="adscope-run adscope-run-off">No date</span>`
      : parsed.active
        ? `<span class="adscope-run">▶ Running ${daysStr} days</span>`
        : `<span class="adscope-run adscope-run-off">⏸ Inactive · ${daysStr}d</span>`;

    const startStr = parsed.start
      ? parsed.start.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
      : "unknown";

    const advCount = parsed.pageName ? (advCounts.get(parsed.pageName) || 1) : 1;

    // Per-day / spend / views tiles (real disclosed values override the model).
    const perDayTile = tile(metrics.hasDate ? fmtMoney(metrics.perDay, c) + "/day" : "—", "per-day budget", "adscope-est");
    let spendTile, viewsTile;
    if (parsed.real.spend) spendTile = tile(parsed.real.spend, "spend (real)", "adscope-real");
    else spendTile = tile(metrics.hasDate ? fmtMoney(metrics.spend, c) : "—", "est. spend", "adscope-est");
    if (parsed.real.impressions) viewsTile = tile(parsed.real.impressions, "impressions (real)", "adscope-real");
    else if (parsed.real.euReach) viewsTile = tile(parsed.real.euReach, "EU reach (real)", "adscope-real");
    else if (parsed.lowImpressions) viewsTile = tile("<100", "reached (real)", "adscope-real");
    else viewsTile = tile(metrics.hasDate ? fmtCount(metrics.views) : "—", "est. views", "adscope-est");

    panel.innerHTML = `
      <div class="adscope-p-head">
        <span class="adscope-brand">AdScope</span>
        ${runBadge}
      </div>
      <div class="adscope-adv">⭐ <span class="adscope-adv-ico">👤</span>
        <b>${escapeHtml(parsed.pageName || "Advertiser")}</b>
        <span class="adscope-adv-count">— ${advCount} ad${advCount === 1 ? "" : "s"} live now</span>
      </div>
      <div class="adscope-sub">Library ID: ${escapeHtml(parsed.libraryId || "—")}</div>
      <div class="adscope-sub">Started ${escapeHtml(startStr)} · active ${daysStr} days</div>
      <div class="adscope-grid">${perDayTile}${spendTile}${viewsTile}</div>
      <div class="adscope-board">
        <select class="adscope-select"><option>Default Board</option></select>
        <button class="adscope-plus" title="New board">+</button>
        <button class="adscope-save" data-lib="${escapeHtml(parsed.libraryId || "")}">Save</button>
        <button class="adscope-info" title="Days running is real. Spend, views and per-day budget are estimates — Meta does not publish them for commercial ads. Tune assumptions in AdScope settings.">ⓘ</button>
      </div>`;

    // Save-to-board (persists a lightweight swipe file in local storage).
    const saveBtn = panel.querySelector(".adscope-save");
    saveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSaved(parsed.libraryId, saveBtn);
    });
    markSavedState(parsed.libraryId, saveBtn);
    return panel;
  }

  // ---- Save-to-board -----------------------------------------------------
  let savedSet = new Set();
  function markSavedState(libId, btn) {
    if (savedSet.has(libId)) { btn.textContent = "Saved ✓"; btn.classList.add("is-saved"); }
  }
  function toggleSaved(libId, btn) {
    if (!libId) return;
    if (savedSet.has(libId)) { savedSet.delete(libId); btn.textContent = "Save"; btn.classList.remove("is-saved"); }
    else { savedSet.add(libId); btn.textContent = "Saved ✓"; btn.classList.add("is-saved"); }
    try { chrome.storage.local.set({ adscope_saved: Array.from(savedSet) }); } catch (e) {}
  }

  function placePanel(card, panel) {
    // Prepend IN NORMAL FLOW so it stacks on top and pushes Meta content down
    // (never overlaps). Full width inside the card.
    card.insertBefore(panel, card.firstChild);
  }

  // ---- Scan cycle --------------------------------------------------------
  function clearPanels() {
    document.querySelectorAll("[data-adscope-badge]").forEach((b) => b.remove());
    document.querySelectorAll(`[${DONE_ATTR}]`).forEach((c) => {
      c.removeAttribute(DONE_ATTR); c.removeAttribute(LIB_ATTR);
    });
    adStore.clear();
  }

  function scan() {
    if (!SETTINGS.enabled) {
      clearPanels();
      const s = document.getElementById("adscope-summary"); if (s) s.style.display = "none";
      const t = document.getElementById("adscope-toolbar"); if (t) t.style.display = "none";
      return;
    }
    const nodes = findLibraryIdNodes();
    for (const node of nodes) {
      const card = getCardRoot(node);
      if (!card) continue;
      // Defensive: never treat our own injected UI as a card.
      if (card.closest && card.closest('[data-adscope-badge],#adscope-summary,#adscope-toolbar,#adscope-modal')) continue;
      try {
        const parsed = parseCard(card);
        if (!parsed.libraryId) continue;

        const already = card.getAttribute(LIB_ATTR);
        if (already === parsed.libraryId && card.querySelector("[data-adscope-badge]")) continue;
        card.querySelectorAll("[data-adscope-badge]").forEach((b) => b.remove());

        const metrics = computeMetrics(parsed);
        placePanel(card, buildPanel(parsed, metrics));
        card.setAttribute(LIB_ATTR, parsed.libraryId);
        card.setAttribute(DONE_ATTR, "1");

        adStore.set(parsed.libraryId, {
          libraryId: parsed.libraryId, pageName: parsed.pageName, active: parsed.active,
          startDate: parsed.start ? parsed.start.toISOString().slice(0, 10) : null,
          endDate: parsed.end ? parsed.end.toISOString().slice(0, 10) : null,
          daysRunning: metrics.hasDate ? +metrics.daysFloat.toFixed(1) : null,
          durationExact: metrics.durationKnown, variations: parsed.variations,
          platforms: parsed.platforms, lowImpressions: parsed.lowImpressions,
          realSpend: parsed.real.spend || null, realImpressions: parsed.real.impressions || null,
          euReach: parsed.real.euReach || null,
          perDayBudget: metrics.hasDate ? Math.round(metrics.perDay) : 0,
          estSpend: metrics.hasDate ? Math.round(metrics.spend) : 0,
          estViews: metrics.hasDate ? Math.round(metrics.views) : 0,
          currency: SETTINGS.currency,
        });
      } catch (e) { card.setAttribute(DONE_ATTR, "1"); }
    }
    recomputeAdvCounts();
    updateAdvCountLabels();
    ensureSummary();
    updateSummary();
    ensureToolbar();
    pushAggregate();
  }

  function recomputeAdvCounts() {
    advCounts = new Map();
    for (const a of adStore.values()) {
      if (!a.pageName || !a.active) continue;
      advCounts.set(a.pageName, (advCounts.get(a.pageName) || 0) + 1);
    }
  }
  function updateAdvCountLabels() {
    document.querySelectorAll(".adscope-panel[data-adscope-adv]").forEach((p) => {
      const adv = p.getAttribute("data-adscope-adv");
      const n = advCounts.get(adv) || 1;
      const el = p.querySelector(".adscope-adv-count");
      if (el) el.textContent = `— ${n} ad${n === 1 ? "" : "s"} live now`;
    });
  }

  // ---- Aggregates --------------------------------------------------------
  function pageResultCount() {
    const m = (document.body.textContent || "").match(/~\s*([\d,]{2,9})\s+results?/i);
    return m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
  }
  function aggregate() {
    const ads = Array.from(adStore.values());
    const n = ads.length;
    const dated = ads.filter((a) => a.daysRunning != null);
    const totSpend = ads.reduce((s, a) => s + (a.estSpend || 0), 0);
    const totViews = ads.reduce((s, a) => s + (a.estViews || 0), 0);
    const avgDays = dated.length ? Math.round(dated.reduce((s, a) => s + a.daysRunning, 0) / dated.length) : 0;
    const avgPerDay = dated.length ? Math.round(dated.reduce((s, a) => s + (a.perDayBudget || 0), 0) / dated.length) : 0;
    const longest = ads.reduce((m, a) => ((a.daysRunning || 0) > (m.daysRunning || 0) ? a : m), {});
    return {
      url: location.href, scannedAt: Date.now(), count: n, pageResults: pageResultCount(),
      avgDays, avgPerDay, totalEstSpend: totSpend, totalEstViews: totViews, currency: SETTINGS.currency,
      longest: longest.libraryId ? { pageName: longest.pageName, days: longest.daysRunning, libraryId: longest.libraryId } : null,
    };
  }
  function pushAggregate() {
    try {
      chrome.storage.local.set({ adscope_lastScan: aggregate(), adscope_lastAds: Array.from(adStore.values()).slice(0, 800) });
    } catch (e) {}
  }

  // ---- Top-right summary panel ------------------------------------------
  function ensureSummary() {
    if (summaryHidden) { const e = document.getElementById("adscope-summary"); if (e) e.remove(); return; }
    if (document.getElementById("adscope-summary")) return;
    const el = document.createElement("div");
    el.id = "adscope-summary";
    el.innerHTML = `
      <div class="as-head">
        <span class="as-title">🚩 AdScope Tracker</span>
        <button class="as-close" title="Hide">✕</button>
      </div>
      <div class="as-body">
        <div class="as-row">Total ads scanned: <b id="as-count">0</b></div>
        <div class="as-row">Avg. days running: <b id="as-avg">0</b></div>
        <div class="as-row">Avg. per-day budget: <b id="as-perday">—</b></div>
        <div class="as-row">Est. total spend (all ads): <b id="as-spend">—</b></div>
        <div class="as-row">Total est. views: <b id="as-views">—</b></div>
        <div class="as-note">⚠️ Spend, views &amp; per-day budget are <b>estimates</b> — Meta doesn't publish them for commercial ads. Model: days × budget × variations. Days running is real.</div>
      </div>`;
    el.querySelector(".as-close").addEventListener("click", () => {
      summaryHidden = true; el.remove();
      try { chrome.storage.local.set({ adscope_summaryHidden: true }); } catch (e) {}
    });
    document.body.appendChild(el);
  }
  function updateSummary() {
    const a = aggregate();
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set("as-count", a.count);
    set("as-avg", a.avgDays);
    set("as-perday", a.count ? fmtMoney(a.avgPerDay, a.currency) + "/day" : "—");
    const lo = a.totalEstSpend * 0.6, hi = a.totalEstSpend * 1.8;
    set("as-spend", a.count ? `${fmtMoney(lo, a.currency)} – ${fmtMoney(hi, a.currency)}` : "—");
    set("as-views", a.count ? "~" + fmtCount(a.totalEstViews) : "—");
  }

  // ---- Toolbar -----------------------------------------------------------
  function findResultsAnchor() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return /[\d,]{2,}\s+results?/i.test(node.nodeValue || "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const node = walker.nextNode();
    if (!node) return null;
    // Climb to the smallest block whose text is basically just the results line
    // (stop before it swells to include the grid), then place the bar after it.
    let el = node.parentElement, prev = el;
    while (el && (el.textContent || "").length < 140 && el.parentElement) { prev = el; el = el.parentElement; }
    return prev;
  }
  function ensureToolbar() {
    if (document.getElementById("adscope-toolbar")) { document.getElementById("adscope-toolbar").style.display = ""; return; }
    const bar = document.createElement("div");
    bar.id = "adscope-toolbar";
    bar.innerHTML = `
      <span class="as-tb-label">🚩 AdScope:</span>
      <button class="as-tb-btn primary" data-act="spend">👁 Show All Ad Spend</button>
      <button class="as-tb-btn" data-act="filters">▽ Longevity filter</button>
      <button class="as-tb-btn primary" data-act="table">▦ Table View</button>
      <button class="as-tb-btn" data-act="settings">⚙ Settings</button>`;
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]"); if (!b) return;
      const act = b.getAttribute("data-act");
      if (act === "spend") { document.documentElement.classList.toggle("adscope-hide-money"); b.classList.toggle("off"); }
      else if (act === "table") openTable();
      else if (act === "filters") cycleFilter(b);
      else if (act === "settings") alert("Open the AdScope toolbar icon (top-right of Chrome) for currency, daily-budget and CPM settings.");
    });
    const anchor = findResultsAnchor();
    if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(bar, anchor.nextSibling);
    else { bar.classList.add("as-tb-float"); document.body.appendChild(bar); }
    return bar;
  }

  // Longevity filter: cycle All → 7d+ → 30d+ (dims cards below threshold).
  const FILTERS = [{ min: 0, label: "▽ Longevity filter" }, { min: 7, label: "▽ 7+ days" }, { min: 30, label: "▽ 30+ days" }];
  let filterIdx = 0;
  function cycleFilter(btn) {
    filterIdx = (filterIdx + 1) % FILTERS.length;
    const f = FILTERS[filterIdx];
    btn.textContent = f.label;
    btn.classList.toggle("primary", f.min > 0);
    document.querySelectorAll(".adscope-panel").forEach((p) => {
      const card = p.parentElement; if (!card) return;
      const lib = card.getAttribute(LIB_ATTR);
      const rec = adStore.get(lib);
      const days = rec ? rec.daysRunning || 0 : 0;
      card.style.opacity = days >= f.min ? "" : "0.28";
    });
  }

  // ---- Table View modal --------------------------------------------------
  function openTable() {
    closeTable();
    const ads = Array.from(adStore.values()).sort((a, b) => (b.daysRunning || 0) - (a.daysRunning || 0));
    const c = SETTINGS.currency;
    const rows = ads.map((a) => `
      <tr>
        <td>${escapeHtml(a.pageName || "—")}</td>
        <td>${a.active ? "Active" : "Inactive"}</td>
        <td class="num">${a.daysRunning != null ? a.daysRunning : "—"}</td>
        <td class="num">${a.perDayBudget ? fmtMoney(a.perDayBudget, c) : "—"}</td>
        <td class="num">${a.realSpend ? escapeHtml(a.realSpend) : (a.estSpend ? fmtMoney(a.estSpend, c) : "—")}</td>
        <td class="num">${a.realImpressions || a.euReach ? escapeHtml(a.realImpressions || a.euReach) : (a.estViews ? fmtCount(a.estViews) : "—")}</td>
        <td>${escapeHtml(a.startDate || "—")}</td>
      </tr>`).join("");
    const modal = document.createElement("div");
    modal.id = "adscope-modal";
    modal.innerHTML = `
      <div class="as-modal-card">
        <div class="as-modal-head">
          <span>AdScope — ${ads.length} ads scanned</span>
          <span>
            <button class="as-dl">⤓ Download CSV</button>
            <button class="as-modal-close">✕</button>
          </span>
        </div>
        <div class="as-modal-body">
          <table class="as-table">
            <thead><tr><th>Advertiser</th><th>Status</th><th>Days</th><th>Per-day</th><th>Est. spend</th><th>Est. views</th><th>Started</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="7" style="text-align:center;padding:20px">No ads scanned yet — scroll the library.</td></tr>`}</tbody>
          </table>
        </div>
        <div class="as-modal-foot">Days running is real · spend / views / per-day are estimates (see the ⚠️ note).</div>
      </div>`;
    modal.addEventListener("click", (e) => { if (e.target === modal) closeTable(); });
    modal.querySelector(".as-modal-close").addEventListener("click", closeTable);
    modal.querySelector(".as-dl").addEventListener("click", () => downloadCsv(ads));
    document.body.appendChild(modal);
  }
  function closeTable() { const m = document.getElementById("adscope-modal"); if (m) m.remove(); }

  function downloadCsv(ads) {
    const cols = ["libraryId", "pageName", "active", "startDate", "endDate", "daysRunning", "variations", "platforms", "perDayBudget", "estSpend", "estViews", "realSpend", "realImpressions", "euReach", "currency"];
    const esc = (v) => {
      if (v == null) v = ""; if (Array.isArray(v)) v = v.join("|"); v = String(v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      v = v.replace(/"/g, '""'); return /[",\n\r]/.test(v) ? `"${v}"` : v;
    };
    const csv = [cols.join(",")].concat(ads.map((a) => cols.map((k) => esc(a[k])).join(","))).join("\r\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `adscope-ads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // ---- Messaging ---------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "ADSCOPE_RESCAN") { clearPanels(); scan(); sendResponse({ ok: true, ads: adStore.size }); }
    else if (msg.type === "ADSCOPE_SETTINGS_CHANGED") { sendResponse({ ok: true }); }
    else if (msg.type === "ADSCOPE_GET") { sendResponse({ ok: true, ads: Array.from(adStore.values()) }); }
    else if (msg.type === "ADSCOPE_TABLE") { openTable(); sendResponse({ ok: true }); }
    else if (msg.type === "ADSCOPE_SHOW_SUMMARY") {
      summaryHidden = false;
      try { chrome.storage.local.set({ adscope_summaryHidden: false }); } catch (e) {}
      ensureSummary(); updateSummary(); sendResponse({ ok: true });
    }
    else if (msg.type === "ADSCOPE_PING") { sendResponse({ ok: true, count: adStore.size }); }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes.adscope_settings) {
        SETTINGS = mergeSettings(changes.adscope_settings.newValue);
        clearPanels(); scan();
      }
    });
  } catch (e) {}

  function mergeSettings(s) {
    if (!s) return DEFAULT_SETTINGS;
    return {
      ...DEFAULT_SETTINGS, ...s,
      presets: {
        INR: { ...DEFAULT_SETTINGS.presets.INR, ...((s.presets || {}).INR || {}) },
        USD: { ...DEFAULT_SETTINGS.presets.USD, ...((s.presets || {}).USD || {}) },
      },
    };
  }
  async function loadState() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(["adscope_settings"], (r1) => {
          SETTINGS = mergeSettings(r1 && r1.adscope_settings);
          chrome.storage.local.get(["adscope_saved", "adscope_summaryHidden"], (r2) => {
            savedSet = new Set((r2 && r2.adscope_saved) || []);
            summaryHidden = !!(r2 && r2.adscope_summaryHidden);
            resolve();
          });
        });
      } catch (e) { SETTINGS = DEFAULT_SETTINGS; resolve(); }
    });
  }

  // ---- Observer + boot ---------------------------------------------------
  let debounceTimer = null;
  function scheduleScan(delay = 500) { clearTimeout(debounceTimer); debounceTimer = setTimeout(scan, delay); }
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute("data-adscope-badge")) continue;
        if (n.nodeType === 1 && n.id && /^adscope-/.test(n.id)) continue;
        scheduleScan(600); return;
      }
    }
  });

  async function init() {
    await loadState();
    scan();
    observer.observe(document.body, { childList: true, subtree: true });
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; clearPanels(); scheduleScan(900); }
    }, 1200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
