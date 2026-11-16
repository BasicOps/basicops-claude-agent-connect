/**
 * Runs in the page's own world, before the app's bundle loads, and listens to
 * what the app fetches.
 *
 * It does NOT decide which task is open: the URL does that, in `watch.js`.
 * All this does is collect what tasks SAY, so the drawer can hand the agent a
 * brief instead of a number.
 *
 * It watches the WebSocket, not just fetch and XHR. BasicOps is a jQuery app
 * that talks over a socket: loading the dashboard makes seventy HTTP requests
 * and none of them carries data. Matching `/v1/task/<id>` was looking at a
 * transport the app does not use, which is why the drawer had a task number
 * and no text behind it.
 */
(() => {
  const SEEN = new Set(); // ids already reported, to keep the chatter down
  const MAX_NODES = 4000; // a feed reply is big; walking it must stay cheap

  function report(id, title, description) {
    // The field is `title`, matching what watch.js reads. It was `name` once,
    // and the mismatch quietly threw every description away.
    window.postMessage({ __boDrawer: true, id: String(id), title: title || "", description: description || "" }, "*");
  }

  /** Does this look like a task, rather than a user, project or comment? */
  function taskish(o) {
    if (!o || typeof o !== "object") return false;
    const id = o.id ?? o.taskId;
    if (typeof id !== "number" && !(typeof id === "string" && /^\d+$/.test(id))) return false;
    // A task has a title. A project has one too, so require that the object
    // is not obviously something else before trusting it.
    if (typeof o.title !== "string" || !o.title.trim()) return false;
    if (o.email || o.firstName || o.lastName) return false; // a person
    return true;
  }

  /** Walk a reply and keep every task-shaped thing in it. */
  function harvest(body) {
    let budget = MAX_NODES;
    const stack = [body];
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (const v of node) stack.push(v);
        continue;
      }
      if (taskish(node)) {
        const id = String(node.id ?? node.taskId);
        const key = id + ":" + node.title + ":" + (node.description || "").length;
        if (!SEEN.has(key)) {
          SEEN.add(key);
          report(id, node.title, typeof node.description === "string" ? node.description : "");
        }
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === "object") stack.push(v);
      }
    }
  }

  function parse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const ours = (url) => {
    try {
      return new URL(String(url), location.href).hostname.endsWith("basicops.com");
    } catch {
      return false;
    }
  };

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const out = origFetch.apply(this, arguments);
      if (ours(url)) {
        out
          .then((res) => {
            if (!res || !res.ok) return;
            const type = res.headers?.get?.("content-type") || "";
            if (!type.includes("json")) return;
            res
              .clone()
              .json()
              .then(harvest)
              .catch(() => {});
          })
          .catch(() => {});
      }
      return out;
    };
  }

  /**
   * The one that actually matters here.
   *
   * BasicOps is a jQuery app that talks over a WebSocket: loading the
   * dashboard makes seventy HTTP requests and not one of them carries data.
   * So patching fetch and XHR found nothing, and the drawer kept handing the
   * agent a task number with no text behind it. The frames are where the
   * tasks are.
   */
  const OrigWS = window.WebSocket;
  if (typeof OrigWS === "function") {
    const Patched = function (...args) {
      const sock = new OrigWS(...args);
      sock.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return; // binary frames are not ours
        const body = parse(ev.data);
        if (body) harvest(body);
      });
      return sock;
    };
    Patched.prototype = OrigWS.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Patched[k] = OrigWS[k];
    window.WebSocket = Patched;
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (_method, url) {
    if (ours(url)) {
      this.addEventListener("load", () => {
        if (this.responseType !== "" && this.responseType !== "text" && this.responseType !== "json") return;
        const body = this.responseType === "json" ? this.response : parse(this.responseText);
        if (body) harvest(body);
      });
    }
    return origOpen.apply(this, arguments);
  };
})();
