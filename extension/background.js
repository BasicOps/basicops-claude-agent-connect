/**
 * Remembers the open task per tab, and tells the side panel when it changes.
 *
 * Nothing here is the source of truth. An MV3 service worker is killed after
 * about thirty seconds idle and comes back with its memory wiped, and the
 * content script has no reason to announce the task again, so a worker that
 * believed its own Map would simply forget which task you had open. The page
 * always knows, so the worker asks it rather than remembering for it.
 * `chrome.storage.session` is a cache in front of that, not the record.
 */
const KEY = (tabId) => `task:${tabId}`;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

async function remember(tabId, task) {
  await chrome.storage.session.set({ [KEY(tabId)]: task });
}

async function recall(tabId) {
  const got = await chrome.storage.session.get(KEY(tabId));
  return got[KEY(tabId)] ?? null;
}

/** Ask the page itself. The only answer that is actually current. */
async function askTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "bo-task-ask" });
    return res?.id ? { id: String(res.id), name: res.name || "", description: res.description || "" } : null;
  } catch {
    // No content script in that tab: not a BasicOps page, or not loaded yet.
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "bo-task" && sender.tab?.id != null) {
    const task = { id: String(msg.id), name: msg.name || "", description: msg.description || "" };
    remember(sender.tab.id, task);
    chrome.runtime.sendMessage({ type: "bo-task-changed", tabId: sender.tab.id, ...task }).catch(() => {});
    return;
  }

  if (msg?.type === "bo-task-get") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return reply({ tabId: null, id: null, name: "", description: "" });
      const fresh = (await askTab(tab.id)) ?? (await recall(tab.id));
      if (fresh) await remember(tab.id, fresh);
      reply({ tabId: tab.id, id: fresh?.id ?? null, name: fresh?.name ?? "", description: fresh?.description ?? "" });
    })();
    return true; // the reply comes later
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(KEY(tabId)));

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const task = (await askTab(tabId)) ?? (await recall(tabId)) ?? { id: null, name: "", description: "" };
  chrome.runtime.sendMessage({ type: "bo-task-changed", tabId, ...task }).catch(() => {});
});
