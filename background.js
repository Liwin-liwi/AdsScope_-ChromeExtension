/* AdScope background service worker — seeds default settings on install */
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["adscope_settings"], (res) => {
    if (!res || !res.adscope_settings) {
      chrome.storage.sync.set({ adscope_settings: DEFAULT_SETTINGS });
    }
  });
});
