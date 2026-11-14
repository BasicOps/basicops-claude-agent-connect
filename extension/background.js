/**
 * Remembers the open task per tab, and tells the side panel when it changes.
 *
 * The side panel is one panel following the active tab, so it always asks
 * "which task is in the tab in front of me" rather than keeping its own idea.
 */
const byTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "bo-task" && sender.tab?.id != null) {
    byTab.set(sender.tab.id, { id: msg.id, name: msg.name || "" });
    // Only the panel cares, and only if it is looking at this tab.
    chrome.runtime.sendMessage({ type: "bo-task-changed", tabId: sender.tab.id, ...byTab.get(sender.tab.id) }).catch(() => {});
    return;
  }
  if (msg?.type === "bo-task-get") {
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const id = tabs[0]?.id;
      reply(id != null ? { tabId: id, ...(byTab.get(id) ?? { id: null, name: "" }) } : { tabId: null, id: null, name: "" });
    });
    return true; // reply comes later
  }
});

chrome.tabs.onRemoved.addListener((tabId) => byTab.delete(tabId));
chrome.tabs.onActivated.addListener(({ tabId }) => {
  const t = byTab.get(tabId) ?? { id: null, name: "" };
  chrome.runtime.sendMessage({ type: "bo-task-changed", tabId, ...t }).catch(() => {});
});
