/**
 * Run the drawer inside a real BasicOps, without touching the app's source.
 *
 * Paste this into the console on app.basicops.com, or load it as a userscript
 * or a content script. It docks the drawer on the right, works out which task
 * is open, and calls setTask as you move between tasks.
 *
 * This is a stand-in for one line in the app. BasicOps puts no plain task id in
 * the URL: a task is `/<workspace>?l=_<ws>_31C_<token>`, where the token is the
 * task id in base 36 with six more characters after it. That holds for every
 * task checked, but it is still a guess about somebody else's URL format, so
 * the drawer shows the task's real name, fetched from the API, next to the id.
 * If the guess is ever wrong the name won't match what's on your screen, and no
 * work can land in the wrong place until you bind a folder to that task anyway.
 *
 * In the app itself none of this exists: the app knows the task and says so.
 */
(async () => {
  const BRIDGE = window.__BO_DRAWER_BRIDGE__ || "http://127.0.0.1:4710";
  const WIDTH = 420;

  if (window.__boDrawer) {
    window.__boDrawer.destroy();
    document.getElementById("bo-drawer-dock")?.remove();
    document.documentElement.style.removeProperty("--bo-drawer-pad");
    delete window.__boDrawer;
    console.log("[drawer] removed");
    return;
  }

  let token = localStorage.getItem("bo-drawer-token");
  if (!token) {
    token = prompt("Bridge token (printed by `npm run bridge`)");
    if (!token) return;
    localStorage.setItem("bo-drawer-token", token.trim());
    token = token.trim();
  }

  let mountDrawer;
  try {
    ({ mountDrawer } = await import(`${BRIDGE}/drawer.js`));
  } catch (e) {
    console.error(`[drawer] couldn't load ${BRIDGE}/drawer.js. Is the bridge running?`, e);
    return;
  }

  // Dock it beside the app rather than over it, so nothing is hidden.
  const dock = document.createElement("div");
  dock.id = "bo-drawer-dock";
  Object.assign(dock.style, {
    position: "fixed",
    top: "0",
    right: "0",
    width: WIDTH + "px",
    height: "100vh",
    zIndex: "2147483000",
    borderLeft: "1px solid rgba(128,128,128,.35)",
    background: "canvas",
    boxShadow: "0 0 24px rgba(0,0,0,.12)",
  });
  document.body.append(dock);
  document.body.style.paddingRight = WIDTH + "px";

  const drawer = mountDrawer({ bridge: BRIDGE, token, mount: dock });
  window.__boDrawer = drawer;

  /**
   * The open task's id, or null. BasicOps has at least three URL shapes and
   * they disagree with each other, so the order here matters:
   *
   *  1. A task open over a list: `?ol-…/3936.2221868/…`. The path still names
   *     the list's own task (`/list/l2221477/`) and the page title still names
   *     that one too, so anything that reads the path here is simply wrong.
   *  2. A plain task route: `/list/l2221666/v95673-2221666/task-details/…`.
   *  3. A share link: `?l=_<ws>_31C_<token>`, the id in base 36 with six more
   *     characters after it. Checked against 50 real tasks.
   *
   * All three are reverse-engineered from somebody else's URLs, which is why
   * the drawer shows the task name beside the id. In the app none of this
   * exists: the app knows the task and passes it in.
   */
  function taskFromUrl() {
    const href = location.href;
    // 1. the overlay wins: it is what's actually on screen
    const overlay = href.match(/[?&]ol-[^#]*?\/3936\.(\d+)/);
    if (overlay) return overlay[1];
    // 2. the plain route
    const route = location.pathname.match(/\/list\/l(\d+)\//);
    if (route) return route[1];
    // 3. the share link
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

  /** The task's real name, read with your own session, as a check on the id. */
  const names = new Map();
  async function nameOf(id) {
    if (names.has(id)) return names.get(id);
    try {
      const res = await fetch(`https://api.basicops.com/v1/task/${id}`, { credentials: "include" });
      if (!res.ok) throw new Error(res.status);
      const t = await res.json();
      const name = t.title || t.name || "";
      names.set(id, name);
      return name;
    } catch {
      names.set(id, "");
      return "";
    }
  }

  let last = null;
  async function sync() {
    const id = taskFromUrl();
    if (id === last) return;
    last = id;
    drawer.setTask(id);
    if (id) drawer.setTask(id, (await nameOf(id)) || "(couldn't read this task's name)");
  }

  // The app routes without reloading, so watch every way the URL can change.
  for (const fn of ["pushState", "replaceState"]) {
    const orig = history[fn].bind(history);
    history[fn] = (...args) => {
      orig(...args);
      sync();
    };
  }
  addEventListener("popstate", sync);
  addEventListener("hashchange", sync);
  // Belt and braces: some navigations change the URL without any of the above.
  setInterval(sync, 700);
  sync();

  console.log("[drawer] mounted. Run this snippet again to remove it.");
})();
