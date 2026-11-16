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
  // Off everywhere by default; `offer` turns it on for BasicOps tabs only.
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  adopt();
});

/**
 * Put the watcher back into tabs that are already open.
 *
 * Reloading the extension kills the content scripts in open tabs and Chrome
 * does not replace them, so the drawer went deaf until you reloaded the tab
 * yourself, which throws away whatever you were looking at. Injecting them
 * again costs nothing and means the panel picks up the task you already have
 * open instead of resetting your view.
 */
async function adopt() {
  const tabs = await chrome.tabs.query({ url: "https://*.basicops.com/*" }).catch(() => []);
  for (const tab of tabs) {
    if (tab.id == null) continue;
    offer(tab.id, tab.url);
    for (const [file, world] of [
      ["watch-main.js", "MAIN"],
      ["watch.js", "ISOLATED"],
    ]) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file], world });
      } catch {
        // The page is still loading, or it went away. Its own content script
        // will run on the next load anyway.
      }
    }
  }
}

// Also after a browser restart, where tabs are restored without us.
chrome.runtime.onStartup.addListener(adopt);

/** A BasicOps tab, the only place this drawer means anything. */
function basicops(url) {
  if (!url) return false;
  try {
    return new URL(url).hostname.endsWith(".basicops.com");
  } catch {
    return false;
  }
}

/**
 * The panel belongs to BasicOps tabs, not to the whole browser. Chrome's side
 * panel is global unless you say otherwise per tab, so every tab offered a
 * task drawer that could never have a task.
 */
async function offer(tabId, url) {
  try {
    await chrome.sidePanel.setOptions(
      basicops(url) ? { tabId, path: "sidepanel.html", enabled: true } : { tabId, enabled: false },
    );
  } catch {
    // The tab went away mid-flight.
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === "loading") offer(tabId, info.url ?? tab.url);
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
    return { id: res.id == null ? null : String(res.id), name: res.name || "", description: res.description || "", parents: res.parents ?? [], trail: res.trail ?? [] };
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
    const task = { id: msg.id == null ? null : String(msg.id), name: msg.name || "", description: msg.description || "", parents: msg.parents ?? [], trail: msg.trail ?? [] };
    remember(sender.tab.id, task);
    chrome.runtime.sendMessage({ type: "bo-task-changed", tabId: sender.tab.id, ...task }).catch(() => {});
    return;
  }

  if (msg?.type === "bo-task-get") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return reply({ tabId: null, id: null, name: "", description: "", parents: [], trail: [] });
      const answered = await askTab(tab.id);
      const fresh = answered ?? (await recall(tab.id));
      if (fresh) await remember(tab.id, fresh);
      reply({
        tabId: tab.id,
        id: fresh?.id ?? null,
        name: fresh?.name ?? "",
        description: fresh?.description ?? "",
        parents: fresh?.parents ?? [],
        trail: fresh?.trail ?? [],
        needsReload: !answered && (await stranded(tab)),
      });
    })();
    return true; // the reply comes later
  }
});

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(KEY(tabId)));

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  offer(tabId, tab?.url);
  const task = (await askTab(tabId)) ?? (await recall(tabId)) ?? { id: null, name: "", description: "", parents: [], trail: [] };
  chrome.runtime.sendMessage({ type: "bo-task-changed", tabId, ...task }).catch(() => {});
});
