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
    if (!res) return null;
    return { id: res.id == null ? null : String(res.id), name: res.name || "", description: res.description || "" };
  } catch {
    // No content script answering: not a BasicOps page, not loaded yet, or
    // orphaned. See `stranded` for why the last one needs saying out loud.
    return null;
  }
}

/**
 * Reloading the extension kills the content scripts already running in open
 * tabs, and Chrome does not put them back. The old script stays in the page
 * with a dead `chrome.runtime`, so it fails silently for ever and the panel
 * simply stops following the task with nothing to show for it. That looks
 * exactly like a bug in the drawer, so say what it is instead.
 */
async function stranded(tab) {
  if (!tab?.url) return false;
  try {
    return new URL(tab.url).hostname.endsWith(".basicops.com");
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type === "bo-task" && sender.tab?.id != null) {
    // A null id is a real answer: no task is open. Stringifying it here is
    // how the drawer ended up asking the bridge about a task called "null".
    const task = { id: msg.id == null ? null : String(msg.id), name: msg.name || "", description: msg.description || "" };
    remember(sender.tab.id, task);
    chrome.runtime.sendMessage({ type: "bo-task-changed", tabId: sender.tab.id, ...task }).catch(() => {});
    return;
  }

  if (msg?.type === "bo-task-get") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return reply({ tabId: null, id: null, name: "", description: "" });
      const answered = await askTab(tab.id);
      const fresh = answered ?? (await recall(tab.id));
      if (fresh) await remember(tab.id, fresh);
      reply({
        tabId: tab.id,
        id: fresh?.id ?? null,
        name: fresh?.name ?? "",
        description: fresh?.description ?? "",
        needsReload: !answered && (await stranded(tab)),
      });
    })();
    return true; // the reply comes later
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(KEY(tabId)));

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const task = (await askTab(tabId)) ?? (await recall(tabId)) ?? { id: null, name: "", description: "" };
  chrome.runtime.sendMessage({ type: "bo-task-changed", tabId, ...task }).catch(() => {});
});
