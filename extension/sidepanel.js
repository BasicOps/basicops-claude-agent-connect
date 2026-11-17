/**
 * The side panel is just a home for the drawer. The drawer itself is the same
 * module the app would mount: `drawer.js`, unchanged, kept in step with
 * `../drawer/drawer.js` by `npm run ext:sync`.
 *
 * An extension page is not a public origin, so it can hold an EventSource open
 * to the bridge on 127.0.0.1. That is the whole reason this lives in an
 * extension rather than being pasted into the page.
 */
import { mountDrawer } from "./drawer.js";

const BRIDGE = (await chrome.storage.local.get("bridge")).bridge || "http://127.0.0.1:4710";

const drawer = mountDrawer({ bridge: BRIDGE, mount: document.getElementById("drawer") });

const notice = document.getElementById("notice");
document.getElementById("reload").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.reload(tab.id);
};

let shownTab = null;
let shownTask = null;

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** Follow whichever BasicOps tab is in front. */
async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "bo-task-get" }).catch(() => null);
  if (!res) return;
  notice.style.display = res.needsReload ? "block" : "none";
  shownTab = res.tabId;
  shownTask = res.id;
  drawer.setTask(res.id, res.name, res.description, { parents: res.parents, trail: res.trail, project: res.project, projectName: res.projectName });
}

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type !== "bo-task-changed") return;
  // A background tab opening a task must not move the panel.
  const active = await activeTabId();
  if (msg.tabId !== active) return;
  notice.style.display = "none";
  shownTab = msg.tabId;
  shownTask = msg.id;
  drawer.setTask(msg.id, msg.name, msg.description, { parents: msg.parents, trail: msg.trail, project: msg.project, projectName: msg.projectName });
});

chrome.tabs.onActivated.addListener(refresh);
// The panel can open before the page is ready to answer, and a worker that
// was asleep answers nothing the first time. Keep asking until there is a
// task, then stop; after that the page pushes changes.
setInterval(refresh, 1500);
window.addEventListener("focus", refresh);
refresh();
