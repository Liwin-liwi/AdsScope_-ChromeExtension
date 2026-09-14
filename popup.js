/* AdScope popup — settings, live summary, rescan, CSV export */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    currency: "INR",
    showSpend: true,
    showViews: true,
    presets: { INR: { dailyBudget: 650, cpm: 150 }, USD: { dailyBudget: 30, cpm: 12 } },
  };
  const SYM = { INR: "₹", USD: "$" };

  const $ = (id) => document.getElementById(id);
  let settings = DEFAULTS;
  let activeTabId = null;
  let onLibrary = false;
  const openedAt = Date.now(); // only trust scans produced after the popup opened

  // ---- storage helpers ----
  const getSync = (k) => new Promise((r) => chrome.storage.sync.get(k, r));
  const setSync = (o) => new Promise((r) => chrome.storage.sync.set(o, r));
  const getLocal = (k) => new Promise((r) => chrome.storage.local.get(k, r));

  function merge(s) {
    if (!s) return { ...DEFAULTS };
    return {
      ...DEFAULTS, ...s,
      presets: {
        INR: { ...DEFAULTS.presets.INR, ...((s.presets || {}).INR || {}) },
        USD: { ...DEFAULTS.presets.USD, ...((s.presets || {}).USD || {}) },
      },
    };
  }

  // ---- formatting (mirror of content.js) ----
  function fmtMoney(n, cur) {
    const s = SYM[cur] || "";
    if (!isFinite(n) || n <= 0) return s + "0";
    if (cur === "INR") {
      if (n >= 1e7) return s + (n / 1e7).toFixed(n >= 1e8 ? 0 : 1) + "Cr";
      if (n >= 1e5) return s + (n / 1e5).toFixed(n >= 1e6 ? 0 : 1) + "L";
      if (n >= 1e3) return s + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
      return s + Math.round(n);
    }
    if (n >= 1e9) return s + (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return s + (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return s + (n / 1e3).toFixed(1) + "K";
    return s + Math.round(n);
  }
  function fmtCount(n) {
    if (!isFinite(n) || n <= 0) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }

  // ---- messaging ----
  function tell(msg) {
    return new Promise((resolve) => {
      if (activeTabId == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(activeTabId, msg, (resp) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }

  // ---- UI population ----
  function paintSettings() {
    $("enabled").checked = settings.enabled;
    $("showSpend").checked = settings.showSpend;
    $("showViews").checked = settings.showViews;
    const cur = settings.currency;
    document.querySelectorAll("#currency .seg-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.cur === cur));
    $("cur-sym1").textContent = SYM[cur];
    $("cur-sym2").textContent = SYM[cur];
    $("dailyBudget").value = settings.presets[cur].dailyBudget;
    $("cpm").value = settings.presets[cur].cpm;
  }

  function paintSummary(agg) {
    if (!agg) {
      $("s-count").textContent = "0";
      $("s-avg").textContent = "0";
      $("s-spend").textContent = "—";
      $("s-views").textContent = "—";
      $("longest").classList.add("hidden");
      return;
    }
    const cur = agg.currency || settings.currency;
    $("s-count").textContent = agg.count || 0;
    $("s-avg").textContent = agg.avgDays || 0;
    $("s-spend").textContent = agg.count ? fmtMoney(agg.totalEstSpend, cur) : "—";
    $("s-views").textContent = agg.count ? fmtCount(agg.totalEstViews) : "—";

    const parts = [];
    if (agg.avgPerDay) {
      parts.push(`💸 Avg per-day budget: <b>${fmtMoney(agg.avgPerDay, cur)}</b>/ad (est.)`);
    }
    if (agg.longest && agg.longest.days) {
      parts.push(`🏆 Longest-running: <b>${escapeHtml(agg.longest.pageName || "an ad")}</b> — ${agg.longest.days} days`);
    }
    if (agg.pageResults) {
      parts.push(`📊 This advertiser is running <b>~${agg.pageResults.toLocaleString()}</b> ads (a strong budget signal).`);
    }
    const box = $("longest");
    if (parts.length) { box.innerHTML = parts.join("<br>"); box.classList.remove("hidden"); }
    else box.classList.add("hidden");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function refreshSummary() {
    const { adscope_lastScan } = await getLocal("adscope_lastScan");
    // Only paint a scan produced for THIS popup session (after it opened) on the
    // current library tab — never a previous advertiser's leftover numbers.
    if (adscope_lastScan && onLibrary && adscope_lastScan.scannedAt >= openedAt) {
      paintSummary(adscope_lastScan);
    } else {
      paintSummary(null);
    }
  }

  // ---- persistence + notify content ----
  let saveTimer = null;
  function saveAndNotify() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await setSync({ adscope_settings: settings });
      await tell({ type: "ADSCOPE_SETTINGS_CHANGED" });
      setTimeout(refreshSummary, 700);
    }, 250);
  }

  // ---- CSV export ----
  function toCsv(ads) {
    const cols = [
      "libraryId", "pageName", "active", "startDate", "endDate", "daysRunning",
      "durationExact", "variations", "platforms", "cta", "lowImpressions",
      "realSpend", "realImpressions", "euReach", "estSpend", "estViews", "currency",
    ];
    const esc = (v) => {
      if (v == null) v = "";
      if (Array.isArray(v)) v = v.join("|");
      v = String(v);
      // Neutralize spreadsheet formula injection (=, +, -, @, tab, CR leads).
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
      v = v.replace(/"/g, '""');
      return /[",\n\r]/.test(v) ? `"${v}"` : v;
    };
    const rows = [cols.join(",")];
    for (const a of ads) rows.push(cols.map((c) => esc(a[c])).join(","));
    return rows.join("\r\n");
  }

  async function exportCsv() {
    let ads = null;
    const resp = await tell({ type: "ADSCOPE_GET" });
    if (resp && resp.ads) ads = resp.ads;
    if (!ads) {
      const { adscope_lastAds } = await getLocal("adscope_lastAds");
      ads = adscope_lastAds || [];
    }
    if (!ads.length) { flash($("export"), "No ads yet"); return; }
    const csv = toCsv(ads);
    // Prepend a UTF-8 BOM so ₹ and other symbols render correctly in Excel.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `adscope-ads-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    flash($("export"), `⤓ ${ads.length} ads`);
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1400);
  }

  // ---- wire up ----
  function wire() {
    $("enabled").addEventListener("change", (e) => {
      settings.enabled = e.target.checked; saveAndNotify();
    });
    $("showSpend").addEventListener("change", (e) => {
      settings.showSpend = e.target.checked; saveAndNotify();
    });
    $("showViews").addEventListener("change", (e) => {
      settings.showViews = e.target.checked; saveAndNotify();
    });
    document.querySelectorAll("#currency .seg-btn").forEach((b) => {
      b.addEventListener("click", () => {
        settings.currency = b.dataset.cur;
        paintSettings();
        saveAndNotify();
      });
    });
    $("dailyBudget").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (isFinite(v) && v > 0) { settings.presets[settings.currency].dailyBudget = v; saveAndNotify(); }
    });
    $("cpm").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      if (isFinite(v) && v > 0) { settings.presets[settings.currency].cpm = v; saveAndNotify(); }
    });
    $("rescan").addEventListener("click", async () => {
      flash($("rescan"), "↻ Scanning…");
      await tell({ type: "ADSCOPE_RESCAN" });
      setTimeout(refreshSummary, 700);
    });
    $("export").addEventListener("click", exportCsv);
    $("openLibrary").addEventListener("click", () => {
      chrome.tabs.create({ url: "https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=IN&media_type=all" });
    });
  }

  // ---- init ----
  async function init() {
    settings = merge((await getSync("adscope_settings")).adscope_settings);
    paintSettings();
    wire();

    const [tab] = await new Promise((r) =>
      chrome.tabs.query({ active: true, currentWindow: true }, r));
    activeTabId = tab ? tab.id : null;
    onLibrary = !!(tab && tab.url && /facebook\.com\/ads\/library/i.test(tab.url));

    if (onLibrary) {
      $("offsite").classList.add("hidden");
      $("summary").classList.remove("hidden");
      // trigger a fresh scan so numbers reflect current settings
      await tell({ type: "ADSCOPE_RESCAN" });
      setTimeout(refreshSummary, 600);
    } else {
      $("offsite").classList.remove("hidden");
      $("summary").classList.add("hidden");
    }
    refreshSummary();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
