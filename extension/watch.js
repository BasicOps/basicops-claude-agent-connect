/**
 * Runs in the extension's world, so it can reach `chrome.runtime`. It takes
 * what `watch-main.js` saw the app do and passes it to the background worker,
 * which hands it to the side panel.
 *
 * The app's own API call is the signal we trust. The URL is only a fallback,
 * for a tab that was already sitting on a task before this loaded, since then
 * no fetch happens for us to see.
 */
(() => {
  let current = null;
  let name = "";

  function send(id, label) {
    if (id === current && label === name) return;
    current = id;
    name = label || "";
    try {
      chrome.runtime.sendMessage({ type: "bo-task", id, name });
    } catch {
      // The extension was reloaded. The next message will reconnect.
    }
  }

  window.addEventListener("message", (ev) => {
    // Only our own page, and only our own shape.
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.__boDrawer !== true || !d.id) return;
    send(String(d.id), d.name);
  });

  /**
   * Last resort, when we never saw the app fetch anything. The three URL shapes
   * BasicOps uses, in the only order that is ever right: the overlay is what is
   * actually on screen, and the path disagrees with it.
   */
  function taskFromUrl() {
    const overlay = location.href.match(/[?&]ol-[^#]*?\/3936\.(\d+)/);
    if (overlay) return overlay[1];
    const route = location.pathname.match(/\/list\/l(\d+)\//);
    if (route) return route[1];
    const l = new URLSearchParams(location.search).get("l");
    if (l) {
      const parts = l.split("_").filter(Boolean);
      if (parts.length >= 3 && parts[1] === "31C") {
        const head = parts[2].slice(0, -6);
        if (/^[0-9A-Z]+$/i.test(head)) {
          const id = parseInt(head, 36);
          if (Number.isSafeInteger(id) && id > 0) return String(id);
        }
      }
    }
    return null;
  }

  // Give the app a moment to fetch; only guess from the URL if it didn't.
  let guessed = null;
  function fallback() {
    const id = taskFromUrl();
    if (!id || id === guessed) return;
    guessed = id;
    if (!current) send(id, "");
  }
  setInterval(fallback, 700);
  setTimeout(fallback, 1200);
})();
