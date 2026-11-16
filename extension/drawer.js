/**
 * The BasicOps drawer: a task-bound Claude session, mounted inside the app.
 *
 *   import { mountDrawer } from "./drawer.js";
 *   const drawer = mountDrawer({ bridge: "http://127.0.0.1:4710", mount: el });
 *   drawer.setTask("1234");   // call this on every task route change
 *
 * The app's only job is that one call. The drawer asks the bridge which folder
 * and session belong to that task, so "which task am I working on" is never
 * inferred from a URL or a front tab: the app already knows, and it says so.
 *
 * No framework, no build step, and everything lives in a shadow root so the
 * app's stylesheet and the drawer's can't reach each other.
 *
 * Transcripts are kept in memory per task, so switching away and back shows the
 * conversation again. A page reload loses them: the bridge streams turns, it
 * doesn't store them. The durable record belongs in the task thread.
 */

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.d {
  --bg: #fff; --fg: #16181d; --muted: #6b7280; --line: #e4e6eb; --card: #f6f7f9;
  --accent: #2f6feb; --warn: #8a5a00; --warn-bg: #fff6e0; --err: #c0392b;
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--bg); color: var(--fg);
  font: 14px/1.5 ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .d {
    --bg: #15171c; --fg: #e8eaed; --muted: #9aa1ad; --line: #2a2e36; --card: #1d2026;
    --accent: #7aa2f7; --warn: #ffd28a; --warn-bg: #3a2c0d; --err: #ff8a80;
  }
}
.head { padding: 10px 12px; border-bottom: 1px solid var(--line); }
.head .line { display: flex; gap: 8px; align-items: baseline; }
.head .label { color: var(--fg); font-size: 12px; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .label:empty { display: none; }
.head .title { font-weight: 600; }
.head .meta { color: var(--muted); font-size: 12px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.head .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: none; }
.head .dot.busy { background: var(--accent); animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .25; } }
.body { flex: 1; overflow-y: auto; padding: 12px; min-height: 0; }
.row { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; }
.row.you { color: var(--muted); }
.row.you b { color: var(--fg); font-weight: 600; }
.row.note { color: var(--muted); font-size: 12px; }
.row.err { color: var(--err); }
.row.tool { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); border-left: 2px solid var(--line); padding-left: 8px; }
.ask { border: 1px solid currentColor; color: var(--warn); background: var(--warn-bg); border-radius: 8px; padding: 9px 10px; margin: 0 0 10px; }
.ask .what { font-weight: 600; }
.ask pre { margin: 6px 0; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; }
.foot { border-top: 1px solid var(--line); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.bar input { flex: 1; min-width: 0; }
.bar .empty { flex-basis: 100%; }
textarea, input { font: inherit; width: 100%; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 8px 9px; }
textarea { resize: vertical; min-height: 60px; }
button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 7px; padding: 7px 11px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
button:disabled { opacity: .5; cursor: default; }
.empty { color: var(--muted); font-size: 13px; }
`;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export function mountDrawer({ bridge = "http://127.0.0.1:4710", token, task, mount = document.body } = {}) {
  const host = el("div");
  host.style.height = "100%";
  const root = host.attachShadow({ mode: "open" });
  root.append(el("style", null, CSS));

  const d = el("div", "d");
  const head = el("div", "head");
  const dot = el("span", "dot");
  const title = el("span", "title", "Claude");
  const meta = el("span", "meta", "No task");
  meta.title = "Click to change this task's folder";
  meta.onclick = () => current && auth && bindPrompt();
  // The task's own name, as the app knows it. If the drawer ever picked up the
  // wrong task, this is what makes that obvious instead of silent.
  const label = el("div", "label");
  const line = el("div", "line");
  line.append(dot, title, meta);
  head.append(line, label);
  const body = el("div", "body");
  const foot = el("div", "foot");
  const input = el("textarea");
  input.placeholder = "Ask about this task. Enter to send, Shift+Enter for a new line.";
  const send = el("button", "primary", "Send");
  const stop = el("button", null, "Stop");
  const bar = el("div", "bar");
  bar.append(send, stop);
  foot.append(input, bar);
  d.append(head, body, foot);
  root.append(d);
  mount.append(host);

  let current = null; // task id
  let stream = null; // EventSource
  let typing = null; // the row being streamed into
  let state = {};
  const history = new Map(); // task id -> [{ kind, text } | { ask }]
  let auth = token || localStorage.getItem("bo-drawer-token") || "";

  const log = () => {
    if (!history.has(current)) history.set(current, []);
    return history.get(current);
  };

  const scroll = () => {
    body.scrollTop = body.scrollHeight;
  };

  function row(kind, text, remember = true) {
    const n = el("div", "row " + kind, text);
    body.append(n);
    if (remember) log().push({ kind, text });
    scroll();
    return n;
  }

  function askCard(ev, remember = true) {
    const box = el("div", "ask");
    const what = el("div", "what", "Allow " + ev.name + "?");
    const pre = el("pre", null, summarise(ev.input));
    const bar2 = el("div", "bar");
    const yes = el("button", "primary", "Allow");
    const no = el("button", null, "Deny");
    // Once it's answered the buttons are noise, and a stale pair of them in the
    // transcript reads as if it were still waiting.
    const answered = (allow) => {
      what.textContent = (allow ? "Allowed " : "Denied ") + ev.name;
      bar2.remove();
    };
    const answer = (allow) => async () => {
      yes.disabled = no.disabled = true;
      try {
        await post("/approve", { id: ev.id, allow });
        // On ev itself, so replaying this task's history shows the outcome.
        ev.answered = allow;
        answered(allow);
      } catch (e) {
        row("err", e.message);
        yes.disabled = no.disabled = false;
      }
    };
    yes.onclick = answer(true);
    no.onclick = answer(false);
    bar2.append(yes, no);
    box.append(what, pre, bar2);
    if (ev.answered != null) answered(ev.answered);
    body.append(box);
    if (remember) log().push({ ask: ev });
    scroll();
  }

  /** Tool input, short enough to read at a glance. */
  function summarise(input) {
    if (!input || typeof input !== "object") return String(input ?? "");
    if (typeof input.command === "string") return input.command;
    const path = input.file_path || input.notebook_path;
    if (path && typeof input.content === "string") {
      const lines = input.content.split("\n");
      return path + "\n\n" + lines.slice(0, 12).join("\n") + (lines.length > 12 ? `\n… ${lines.length - 12} more lines` : "");
    }
    if (path) return path;
    return JSON.stringify(input, null, 1).slice(0, 1000);
  }

  async function post(path, payload) {
    const res = await fetch(bridge + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth },
      body: JSON.stringify({ task: current, ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function paint() {
    const bits = [];
    if (state.workdir) bits.push(state.workdir.split("/").slice(-2).join("/"));
    else bits.push("no folder bound");
    if (state.sessionId) bits.push("session " + state.sessionId.slice(0, 8));
    meta.textContent = bits.join(" · ");
    meta.title = state.workdir || "";
    dot.className = "dot" + (state.busy ? " busy" : "");
    send.disabled = !current || !state.workdir;
    stop.disabled = !state.busy;
  }

  async function refresh() {
    if (!current) return;
    try {
      const res = await fetch(`${bridge}/state?task=${encodeURIComponent(current)}&t=${encodeURIComponent(auth)}`);
      const s = await res.json();
      if (!res.ok) throw new Error(s.error);
      state = s;
      paint();
      // A prompt raised while the drawer was closed or on another task.
      for (const p of s.pending ?? []) {
        if (!log().some((e) => e.ask && e.ask.id === p.id)) askCard(p);
      }
      if (!s.workdir) bindPrompt();
    } catch (e) {
      meta.textContent = e.message;
    }
  }

  /**
   * Ask for the task's folder, rather than making them type a command. Also
   * reachable from the header, since a task bound to the wrong folder would
   * otherwise be stuck there.
   */
  function bindPrompt() {
    if (root.querySelector(".bindrow")) return;
    const wrap = el("div", "bar bindrow");
    const path = el("input");
    path.placeholder = "/Users/you/src/the-repo";
    path.value = state.workdir || localStorage.getItem("bo-drawer-lastdir") || "";
    const go = el("button", "primary", "Bind folder");
    go.onclick = async () => {
      go.disabled = true;
      try {
        const before = state.workdir;
        const after = await post("/bind", { workdir: path.value.trim() });
        localStorage.setItem("bo-drawer-lastdir", path.value.trim());
        wrap.remove();
        // Moving the folder means a new session: the old transcript lives under
        // the old path and can't be resumed from here.
        if (before && after.workdir !== before) row("note", "Folder changed, so this task starts a new session.");
        refresh();
      } catch (e) {
        row("err", e.message);
        go.disabled = false;
      }
    };
    wrap.append(path, go);
    foot.prepend(wrap);
  }

  function connectPrompt() {
    if (root.querySelector(".tokenrow")) return;
    const wrap = el("div", "bar tokenrow");
    const t = el("input");
    t.type = "password";
    t.placeholder = "bridge token";
    const go = el("button", "primary", "Connect");
    go.onclick = () => {
      auth = t.value.trim();
      if (!auth) return;
      localStorage.setItem("bo-drawer-token", auth);
      wrap.remove();
      // setTask does nothing when handed the task it already has, so clear it
      // first. Otherwise connecting leaves the drawer sitting on a task it
      // never opened a stream for.
      const again = current;
      current = null;
      if (again) setTask(again);
    };
    wrap.append(t, go);
    // Without this the panel just says "Not connected" and offers a box with
    // no clue what belongs in it, which reads as the drawer being broken.
    const hint = el("div", "empty", "The bridge prints this token when it starts. Paste it once; it is remembered.");
    wrap.append(hint);
    foot.prepend(wrap);
  }

  function open() {
    stream?.close();
    stream = new EventSource(`${bridge}/events?task=${encodeURIComponent(current)}&t=${encodeURIComponent(auth)}`);
    // Every (re)connect re-reads state, so a turn that finished or a prompt
    // raised while the stream was down isn't missed.
    stream.onopen = () => refresh();
    stream.onerror = () => {
      dot.className = "dot";
    };
    stream.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "text") {
        if (!typing) typing = row("", "");
        typing.textContent += ev.text;
        const entries = log();
        const last = entries[entries.length - 1];
        if (last && last.kind === "") last.text = typing.textContent;
        scroll();
      } else if (ev.type === "tool") {
        typing = null;
        row("tool", ev.name + " " + summarise(ev.input).split("\n")[0].slice(0, 160));
      } else if (ev.type === "ask") {
        typing = null;
        askCard(ev);
      } else if (ev.type === "bound") {
        state.workdir = ev.workdir;
        state.sessionId = ev.sessionId;
        paint();
      } else if (ev.type === "turn") {
        typing = null;
        if (ev.state === "start") {
          state.busy = true;
          paint();
          if (!ev.resumed) row("note", "New session in " + ev.workdir);
        } else {
          state.busy = false;
          if (ev.state === "error") row("err", ev.error || "The turn failed.");
          else if (ev.state === "stopped") row("note", "Stopped.");
          refresh();
        }
      }
    };
  }

  function setTask(id, name) {
    id = id == null ? null : String(id);
    if (id === current) {
      if (name) label.textContent = name;
      return;
    }
    label.textContent = name || "";
    current = id;
    typing = null;
    state = {};
    body.replaceChildren();
    root.querySelector(".bindrow")?.remove();
    stream?.close();
    stream = null;
    title.textContent = id ? "Task " + id : "Claude";
    if (!id) {
      meta.textContent = "No task";
      paint();
      return;
    }
    if (!auth) {
      meta.textContent = "Not connected";
      connectPrompt();
      return;
    }
    // Replay what this task said earlier in this page's life.
    for (const e of history.get(id) ?? []) {
      if (e.ask) askCard(e.ask, false);
      else row(e.kind, e.text, false);
    }
    if (!(history.get(id) ?? []).length) body.append(el("div", "empty", "Nothing yet for this task."));
    open();
    refresh();
  }

  send.onclick = async () => {
    const text = input.value.trim();
    if (!text || !current) return;
    body.querySelector(".empty")?.remove();
    const n = row("you", "");
    n.append(el("b", null, "You: "), document.createTextNode(text));
    log()[log().length - 1] = { kind: "you", text: "You: " + text };
    input.value = "";
    try {
      await post("/message", { text });
    } catch (e) {
      row("err", e.message);
    }
  };
  stop.onclick = async () => {
    try {
      await post("/stop", {});
    } catch (e) {
      row("err", e.message);
    }
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send.onclick();
    }
  };

  paint();
  if (task != null) setTask(task);

  return {
    element: host,
    setTask,
    destroy() {
      stream?.close();
      host.remove();
    },
  };
}
