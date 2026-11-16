/**
 * Works out which task is on screen, and tells the worker when it changes.
 *
 * The split that matters, which I had backwards at first:
 *
 *   The URL says WHICH task is open. The API says WHAT that task contains.
 *
 * A feed or a list fetches many tasks, so "the last task the app fetched" is
 * not the task you are looking at; it is just the last row that loaded. Taking
 * the id from a fetch meant the drawer pinned whichever task happened to load
 * first and then never moved, because once it had an id it stopped listening.
 *
 * So the URL decides the id, every time it changes, and the fetches only fill
 * in the title and description for ids we have seen go past.
 */
(() => {
  /** id -> { title, description }, from whatever the app has fetched. */
  const details = new Map();
  let sentId = null;
  let sentText = null;

  function push(id) {
    const d = (id && details.get(id)) || { title: "", description: "" };
    const text = d.title + "\u0000" + d.description;
    if (id === sentId && text === sentText) return;
    sentId = id;
    sentText = text;
    try {
      chrome.runtime.sendMessage({ type: "bo-task", id, name: d.title, description: d.description });
    } catch {
      // The extension was reloaded; the next change reconnects.
    }
  }

  /**
   * The open task's id. BasicOps has three URL shapes and they disagree, so
   * the order is the whole point:
   *
   *  1. A task open over something else: `?ol-…/3936.2219964/…`. The path still
   *     names the list or feed's own task and so does the page title, so
   *     anything reading the path here is simply wrong.
   *  2. A plain task route: `/list/l2221666/…`.
   *  3. A share link: `?l=_<ws>_31C_<token>`, the id in base 36 with six more
   *     characters after it.
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

  /**
   * What is open right now. If the URL says nothing, nothing is open. Falling
   * back to "the last task the app fetched" is how the drawer ended up pinned
   * to a random row of a feed, and showing no task is safe in a way that
   * showing the wrong one is not.
   */
  const openTask = () => taskFromUrl();

  function sync() {
    push(openTask());
  }

  // Details arriving from the page's own traffic.
  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.__boDrawer !== true || !d.id) return;
    const id = String(d.id);
    if (d.title || d.description) {
      details.set(id, { title: d.title || "", description: d.description || "" });
    }
    // Only re-send if this is the task actually on screen. A feed loading
    // fifty rows must not drag the drawer along with it.
    if (id === openTask()) push(id);
  });

  // The app routes without reloading, so watch the URL rather than trust an
  // event. 400ms is below noticing and costs nothing.
  addEventListener("popstate", sync);
  addEventListener("hashchange", sync);
  setInterval(sync, 400);
  sync();

  /**
   * The worker asks this when the side panel needs to know, which is the only
   * reliable moment: an MV3 worker is killed when idle and the page has no
   * reason to announce itself again.
   */
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "bo-task-ask") return;
    const id = openTask();
    const d = (id && details.get(id)) || { title: "", description: "" };
    reply({ id, name: d.title, description: d.description });
    return true;
  });
})();
