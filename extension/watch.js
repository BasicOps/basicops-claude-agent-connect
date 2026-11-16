/**
 * Works out which task is on screen, and tells the worker when it changes.
 *
 * It only reads: the URL for the id, the DOM for the name and the breadcrumb.
 * It runs in the extension's own world and touches nothing the app owns.
 *
 * There used to be a second script in the page's own world, patching fetch,
 * XHR and the WebSocket to harvest task text. It never delivered anything
 * useful, and injecting it into a running page made BasicOps navigate away
 * from the task you had open. The task's text comes from the agent's own
 * BasicOps server now, which is live and authoritative, so nothing needs to
 * touch the app's internals.
 */
(() => {
  // Injected again after an extension reload? One watcher is enough.
  if (window.__boWatch) return;
  window.__boWatch = true;

  let sentId = null;
  let sentText = null;

  /**
   * The open task's name, straight off the page. One `.task-title` is on
   * screen at a time and it belongs to the task the URL names, so this is the
   * same thing you are looking at. Simpler and more reliable than fishing the
   * title out of a socket frame, and it is what the drawer shows you.
   */
  function titleFromDom() {
    const el = document.querySelector(".task-title");
    const text = el ? (el.textContent || "").trim() : "";
    return text.length > 200 ? text.slice(0, 200) : text;
  }

  /**
   * The ancestors shown above the task, outermost first, by name.
   *
   * The overlay stack only has a parent when you opened the child ON TOP of
   * it. Walk down the task tree instead and the URL names one task, with no
   * chain at all, which is how a subtask ended up with no folder. The
   * breadcrumb is on screen either way. It carries no ids, only names, so the
   * bridge matches them against the task names it has already been told.
   */
  function trailFromDom() {
    return [...document.querySelectorAll(".breadcrumb .breadcrumb-link")]
      .map((el) => (el.textContent || "").trim())
      .filter((s) => s && s.length <= 200);
  }

  function push(id) {
    const d = { title: id ? titleFromDom() : "", description: "" };
    const parents = id ? parentsFromUrl() : [];
    const trail = id ? trailFromDom() : [];
    const text = d.title + "\u0000" + d.description + "\u0000" + parents.join(",") + "\u0000" + trail.join(">");
    if (id === sentId && text === sentText) return;
    sentId = id;
    sentText = text;
    try {
      chrome.runtime.sendMessage({ type: "bo-task", id, name: d.title, description: d.description, parents, trail });
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
  /**
   * Every task in the open overlay stack, outermost first. Opening a subtask
   * from its parent leaves both in the `ol-` parameter, so this is the parent
   * chain, already on screen and needing no API call.
   */
  function overlayStack() {
    const ol = location.href.match(/[?&](ol-[^#&]*)/);
    if (!ol) return [];
    const ids = [...ol[1].matchAll(/\/3936\.(\d+)/g)].map((m) => m[1]);
    return ids.filter((id, i) => id !== "0" && ids.indexOf(id) === i);
  }

  /** The open task's ancestors, nearest parent first. */
  function parentsFromUrl() {
    const stack = overlayStack();
    return stack.slice(0, -1).reverse();
  }

  function taskFromUrl() {
    const stack = overlayStack();
    if (stack.length) return stack[stack.length - 1];
    // `l0` is BasicOps's placeholder, not a task: the dashboard path is full
    // of them. Without this the drawer binds to a task called 0.
    const route = location.pathname.match(/\/list\/l(\d+)\//);
    if (route && route[1] !== "0") return route[1];
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

  // The last sample, so a reading has to hold still before we act on it.
  let lastSample = null;

  /**
   * Report only what the page has settled on.
   *
   * Opening the side panel reflows the page, and a reflowing app can show the
   * list's own task for a moment before it settles on the one you had open.
   * Latching onto that moment is how the drawer ends up on a task you were not
   * looking at. Requiring two readings in a row, 400ms apart, costs nothing
   * you would notice and skips the transient.
   */
  function sync() {
    const id = openTask();
    const sample = id + "\u0000" + titleFromDom();
    if (sample !== lastSample) {
      lastSample = sample;
      return; // seen once; act on it if it is still true next tick
    }
    push(id);
  }

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
    reply({
      id,
      name: id ? titleFromDom() : "",
      description: "",
      parents: id ? parentsFromUrl() : [],
      trail: id ? trailFromDom() : [],
    });
    return true;
  });
})();
