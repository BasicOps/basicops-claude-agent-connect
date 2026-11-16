/**
 * Runs in the page's own world, before the app's bundle loads, and listens to
 * what the app fetches.
 *
 * It does NOT decide which task is open: the URL does that, in `watch.js`.
 * All this does is collect what tasks SAY, so the drawer can hand the agent a
 * brief instead of a number.
 *
 * It used to match only `/v1/task/<id>`, which turned out to be rare: open a
 * task from a feed or a list and the text has usually arrived already, inside
 * some larger reply. So it now harvests any task-shaped object out of any JSON
 * the app receives, which is where the titles were all along.
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
