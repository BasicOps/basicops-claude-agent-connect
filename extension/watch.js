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

  /** Laid out, so `display: none` is out but a fixed overlay is in. */
  function shown(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  /**
   * The open task's name, straight off the page.
   *
   * There is one `.task-title` per open panel, not one per screen. Open a task
   * over a list and the list's own task-details stays behind it, in the DOM
   * and laid out, so `querySelector` returns the task you are NOT looking at.
   * That is how task 2223328 "Campaign 5 of 8" came to be recorded under the
   * name of the task on top of it, and 2223327 under the name of the list
   * underneath. A panel is appended after whatever it covers, so the last one
   * laid out is the one on top.
   */
  function titleFromDom() {
    const all = [...document.querySelectorAll(".task-title")].filter(shown);
    const el = all[all.length - 1];
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
    // One `.breadcrumb` per open panel, like the title, so take the top one's
    // alone. Running them together put the covered panel's project at the head
    // of the chain, which is both the wrong project name on the drawer and a
    // foreign name offered to the bridge to inherit a folder from.
    const bars = [...document.querySelectorAll(".breadcrumb")].filter(shown);
    const bar = bars[bars.length - 1];
    if (!bar) return [];
    return [...bar.querySelectorAll(".breadcrumb-link")]
      .map((el) => (el.textContent || "").trim())
      .filter((s) => s && s.length <= 200);
  }

  function push(id) {
    const d = { title: id ? titleFromDom() : "", description: "" };
    const parents = id ? parentsFromUrl() : [];
    const trail = id ? trailFromDom() : [];
    const project = id ? projectFromUrl() : null;
    const projectName = project ? trail[0] || "" : "";
    const text = [d.title, d.description, parents.join(","), trail.join(">"), project, projectName].join("\u0000");
    if (id === sentId && text === sentText) return;
    sentId = id;
    sentText = text;
    try {
      chrome.runtime.sendMessage({ type: "bo-task", id, name: d.title, description: d.description, parents, trail, project, projectName });
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
  /** The `ol-` parameter's text, or "" when nothing is open over the page. */
  function overlayParam() {
    const ol = location.href.match(/[?&](ol-[^#&]*)/);
    return ol ? ol[1] : "";
  }

  function overlayStack() {
    const ol = overlayParam();
    if (!ol) return [];
    const ids = [...ol.matchAll(/\/3936\.(\d+)/g)].map((m) => m[1]);
    return ids.filter((id, i) => id !== "0" && ids.indexOf(id) === i);
  }

  /**
   * Every `/list/l<id>/` in a stretch of URL, in order. `l0` is BasicOps's
   * placeholder rather than a task, and the dashboard path is full of them.
   */
  function listIds(where) {
    return [...where.matchAll(/\/list\/l(\d+)(?:\/|$)/g)].map((m) => m[1]).filter((id) => id !== "0");
  }

  /** The open task's ancestors, nearest parent first. */
  function parentsFromUrl() {
    const stack = overlayStack();
    return stack.slice(0, -1).reverse();
  }

  /**
   * The open project's id, or null when the task is not being viewed inside
   * one. A project task's path carries it twice and they agree:
   *
   *   /c/v95402-69636/project-tasks-main/list/l2214578/…/projects/a69636
   *
   * The trailing `a<id>` is the plainer of the two, so it is read first. The
   * `v<view>-<project>` segment is the fallback, for views that do not end in
   * the project.
   *
   * The overlay comes first, for the same reason the task id does: with a task
   * open over a list, the path names the project of the task underneath, not
   * the one you are looking at. An overlay names its project as `3934.<id>`,
   * or carries the same `a<id>` and `v<view>-<project>` forms itself. Anchoring
   * a folder to the wrong project is worse than anchoring to none, so when
   * something is open and names no project, this reports none.
   *
   * A task opened through My Tasks also reports no project, and that is
   * correct rather than a gap: nothing on screen says which project it belongs
   * to, and guessing one would bind a folder on a hunch.
   */
  function projectIn(where) {
    const over = [...where.matchAll(/\/3934\.(\d+)/g)].map((m) => m[1]).filter((id) => id !== "0");
    if (over.length) return over[over.length - 1];
    const tail = [...where.matchAll(/\/projects\/a(\d+)(?:\/|$)/g)].map((m) => m[1]);
    if (tail.length) return tail[tail.length - 1];
    const head = [...where.matchAll(/\/c\/v\d+-(\d+)(?:\/|$)/g)].map((m) => m[1]);
    return head.length ? head[head.length - 1] : null;
  }

  function projectFromUrl() {
    const ol = overlayParam();
    if (ol) return projectIn(ol);
    return projectIn(location.pathname);
  }

  function taskFromUrl() {
    const stack = overlayStack();
    if (stack.length) return stack[stack.length - 1];

    const ol = overlayParam();
    if (ol) {
      // An overlay does not always name its task as `3936.<id>`. Open a
      // project over a list and it carries its own `/list/l<id>/` instead:
      //
      //   /…/list/l1972055/…/projects/a64411?ol-…/3934.69167/…/list/l2200151/…
      //
      // The task on screen is 2200151. The path's l1972055 is the task the
      // overlay is covering, and reading it here is how the drawer walked off
      // to a task in the background, which has no folder and no session of
      // its own, so the task you were working on looked like it had lost one.
      const inside = listIds(ol);
      if (inside.length) return inside[inside.length - 1];
      // Something is open over the page and nothing in the URL says what.
      // Better no task than the one underneath it.
      return null;
    }

    const own = listIds(location.pathname);
    if (own.length) return own[own.length - 1];
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
    const trail = id ? trailFromDom() : [];
    const project = id ? projectFromUrl() : null;
    reply({
      id,
      name: id ? titleFromDom() : "",
      description: "",
      parents: id ? parentsFromUrl() : [],
      trail,
      project,
      projectName: project ? trail[0] || "" : "",
    });
    return true;
  });
})();
