/**
 * Runs in the page's own world, before the app's bundle loads.
 *
 * The URL does not reliably say which task is open: with a task over a list the
 * path names the list's task and so does the title. So instead of reading the
 * URL, listen to what the app itself does. When BasicOps opens a task it GETs
 * `/v1/task/<id>`, and the reply carries the title. That is the app telling us
 * which task it opened, in its own words, and it is the best signal available
 * without changing the app.
 *
 * Nothing here talks to the bridge or to the extension directly: the page's
 * world has no `chrome` API. It posts to `watch.js`, which does.
 */
(() => {
  // Exactly /v1/task/<digits>, not an attachment or any other sub-resource.
  const TASK = /\/v1\/task\/(\d+)(?:[?#]|$)/;

  function report(id, name) {
    window.postMessage({ __boDrawer: true, id: String(id), name: name || "" }, "*");
  }

  /** Pull the title out of a task reply, whatever shape it comes in. */
  function titleOf(body) {
    try {
      const t = typeof body === "string" ? JSON.parse(body) : body;
      const o = t && t.data ? t.data : t;
      return (o && (o.title || o.name)) || "";
    } catch {
      return "";
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      const hit = method === "GET" && url && String(url).match(TASK);
      const out = origFetch.apply(this, arguments);
      if (hit) {
        out
          .then((res) => {
            if (!res || !res.ok) return report(hit[1], "");
            res
              .clone()
              .json()
              .then((b) => report(hit[1], titleOf(b)))
              .catch(() => report(hit[1], ""));
          })
          .catch(() => {});
      }
      return out;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const hit = String(method || "GET").toUpperCase() === "GET" && url && String(url).match(TASK);
    if (hit) {
      this.addEventListener("load", () => {
        report(hit[1], this.responseType === "" || this.responseType === "text" ? titleOf(this.responseText) : "");
      });
    }
    return origOpen.apply(this, arguments);
  };
})();
