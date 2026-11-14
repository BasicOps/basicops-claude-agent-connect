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

let shownTab = null;

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** Follow whichever BasicOps tab is in front. */
async function refresh() {
  const res = await chrome.runtime.sendMessage({ type: "bo-task-get" }).catch(() => null);
  if (!res) return;
  shownTab = res.tabId;
  drawer.setTask(res.id, res.name);
}

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg?.type !== "bo-task-changed") return;
  // A background tab opening a task must not move the panel.
  const active = await activeTabId();
  if (msg.tabId !== active) return;
  shownTab = msg.tabId;
  drawer.setTask(msg.id, msg.name);
});

chrome.tabs.onActivated.addListener(refresh);
refresh();
