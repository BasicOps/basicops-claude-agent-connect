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
/* Your own message, in a box like Claude's, so the turns read apart at a glance. */
.row.you {
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  padding: 8px 11px; margin: 2px 0 12px auto; max-width: 85%; width: fit-content;
}
.row.note { color: var(--muted); font-size: 12px; }
/* Claude's own replies: markdown, rendered. Blocks set their own spacing, so
   the row's pre-wrap only has to hold line breaks inside a paragraph. */
.row p, .row ul, .row ol, .row pre { margin: 0 0 10px; }
.row > :last-child { margin-bottom: 0; }
.row .md-h { font-weight: 600; margin: 15px 0 7px; }
.row > .md-h:first-child { margin-top: 0; }
.row ul, .row ol { padding-left: 20px; white-space: normal; }
.row li { margin: 3px 0; }
.row code { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--card); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
.row pre { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 9px 10px; overflow-x: auto; white-space: pre; }
.row pre code { background: none; border: 0; padding: 0; font-size: 12px; }
.row a { color: var(--accent); }
.row hr { border: 0; border-top: 1px solid var(--line); margin: 14px 0; }
.row .md-table { overflow-x: auto; margin: 0 0 10px; }
.row table { border-collapse: collapse; white-space: normal; font-size: 13px; }
.row th, .row td { border-bottom: 1px solid var(--line); padding: 5px 10px 5px 0; text-align: left; vertical-align: top; }
.row th { font-weight: 600; color: var(--muted); font-size: 12px; }
.row tr:last-child td { border-bottom: 0; }
.row.err { color: var(--err); }
.row.tool { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); border-left: 2px solid var(--line); padding-left: 8px; margin-bottom: 8px; }
.ask { border: 1px solid currentColor; color: var(--warn); background: var(--warn-bg); border-radius: 8px; padding: 9px 10px; margin: 0 0 10px; }
.ask .what { font-weight: 600; }
.ask pre { margin: 6px 0; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; max-height: 180px; overflow: auto; }
.foot { border-top: 1px solid var(--line); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.bar input { flex: 1; min-width: 0; }
.bar .empty { flex-basis: 100%; }
.bar .whole { flex-basis: 100%; display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12px; cursor: pointer; }
.bar .whole input { width: auto; flex: none; margin: 0; }
textarea, input { font: inherit; width: 100%; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 7px; padding: 8px 9px; }
textarea { resize: vertical; min-height: 60px; }
button { font: inherit; border: 1px solid var(--line); background: var(--card); color: var(--fg); border-radius: 7px; padding: 7px 11px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
button:disabled { opacity: .5; cursor: default; }
.empty { color: var(--muted); font-size: 13px; }
`;

/**
 * Enough markdown to read a Claude turn.
 *
 * The model writes markdown whether or not anything renders it, so a reply
 * full of backticks and asterisks was the alternative. Built out of DOM nodes
 * rather than innerHTML: the text comes from a model that reads tasks, files
 * and the web, and none of that should ever be able to put markup on screen.
 */
// The href allows balanced parens, because plenty of real URLs carry them and
// stopping at the first `)` turns the rest of the line into literal brackets.
const MD_INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]*\]\((?:[^()\s]|\([^()\s]*\))+\))/g;

function mdInline(text, into) {
  let at = 0;
  for (const m of text.matchAll(MD_INLINE)) {
    if (m.index > at) into.append(text.slice(at, m.index));
    const t = m[0];
    if (t.startsWith("`")) into.append(el("code", null, t.slice(1, -1)));
    else if (t.startsWith("**")) into.append(el("strong", null, t.slice(2, -2)));
    else if (t.startsWith("*")) into.append(el("em", null, t.slice(1, -1)));
    else {
      const cut = t.indexOf("](");
      const label = t.slice(1, cut);
      const href = t.slice(cut + 2, -1);
      // Anything but http(s) stays text: no javascript:, no data:.
      if (/^https?:\/\//i.test(href)) {
        const a = el("a", null, label);
        a.href = href;
        a.target = "_blank";
        a.rel = "noreferrer noopener";
        into.append(a);
      } else into.append(t);
    }
    at = m.index + t.length;
  }
  if (at < text.length) into.append(text.slice(at));
  return into;
}

function md(src) {
  const out = document.createDocumentFragment();
  const lines = String(src).split("\n");
  let para = [];
  let list = null; // the open <ul>/<ol>

  const flush = () => {
    if (para.length) out.append(mdInline(para.join("\n"), el("p")));
    para = [];
  };
  const endList = () => {
    if (list) out.append(list);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      flush();
      endList();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const pre = el("pre");
      pre.append(el("code", null, code.join("\n")));
      out.append(pre);
      continue;
    }

    // A table: a row of cells, then a row of dashes. Without the dashes it is
    // just a line that happens to have pipes in it.
    if (line.includes("|") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      flush();
      endList();
      const cells = (r) =>
        r
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const table = el("table");
      const headRow = el("tr");
      for (const c of cells(line)) headRow.append(mdInline(c, el("th")));
      table.append(headRow);
      for (i += 2; i < lines.length && lines[i].includes("|"); i++) {
        const tr = el("tr");
        for (const c of cells(lines[i])) tr.append(mdInline(c, el("td")));
        table.append(tr);
      }
      i--; // the loop's own i++ takes the line that ended the table
      const scroller = el("div", "md-table");
      scroller.append(table);
      out.append(scroller);
      continue;
    }

    const head = line.match(/^(#{1,6})\s+(.*)$/);
    if (head) {
      flush();
      endList();
      out.append(mdInline(head[2], el("div", "md-h")));
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      flush();
      endList();
      out.append(el("hr"));
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || number) {
      flush();
      const want = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== want) {
        endList();
        list = el(want);
      }
      list.append(mdInline((bullet || number)[1], el("li")));
      continue;
    }

    if (!line.trim()) {
      flush();
      endList();
      continue;
    }

    // A plain line continues the paragraph, and continues a list item it is
    // indented under rather than starting a paragraph mid-list.
    if (list && /^\s{2,}\S/.test(line) && list.lastChild) {
      list.lastChild.append("\n");
      mdInline(line.trim(), list.lastChild);
      continue;
    }
    endList();
    para.push(line);
  }
  flush();
  endList();
  return out;
}

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
  let typingRaw = ""; // its markdown source, kept because the DOM loses it
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
    // Your own words were prefixed "You:" when every turn was plain text. The
    // box says whose it is now, so the label would only be noise.
    const n = el("div", "row " + kind, kind === "you" ? String(text).replace(/^You: /, "") : kind === "" ? null : text);
    // A reply replayed from history is already whole, so it renders at once.
    // A reply still streaming arrives empty here and settles below.
    if (kind === "" && text) n.append(md(text));
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
    if (!res.ok) {
      const err = new Error(data.error || res.statusText);
      Object.assign(err, data);
      throw err;
    }
    return data;
  }

  function paint() {
    const bits = [];
    if (current) bits.push("#" + current);
    if (state.workdir) bits.push(state.workdir.split("/").slice(-2).join("/"));
    else bits.push("no folder bound");
    // The bridge names the source, because only it knows whether that key is
    // a task or a project.
    if (state.inheritedName) bits[bits.length - 1] += " (from " + state.inheritedName + ")";
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
    // Dragging a folder in, or copying a path from a terminal, brings quotes
    // with it. They are never part of the path, and left in they turn an
    // absolute path into a relative one, which fails somewhere confusing.
    const clean = () => path.value.trim().replace(/^['"]|['"]$/g, "").trim();

    const pick = el("button", null, "Choose…");
    pick.onclick = async () => {
      pick.disabled = true;
      try {
        const got = await post("/pick", {});
        if (got.workdir) path.value = got.workdir;
      } catch (e) {
        row("err", e.message);
      }
      pick.disabled = false;
      path.focus();
    };

    /**
     * Anchor it to the project instead, so every task in that project starts
     * in this folder. Only offered when a project is actually open: viewed
     * through My Tasks, a task's page says nothing about its project, and
     * anchoring on a guess is how the wrong repo gets a session.
     */
    const whole = el("label", "whole");
    const all = el("input");
    all.type = "checkbox";
    whole.append(all, document.createTextNode(" All of " + (state.projectName || "this project")));
    if (!state.project) whole.style.display = "none";

    const go = el("button", "primary", "Bind folder");
    go.onclick = async () => {
      go.disabled = true;
      try {
        const before = state.workdir;
        const after = await post("/bind", { workdir: clean(), scope: all.checked ? "project" : "task" });
        localStorage.setItem("bo-drawer-lastdir", clean());
        wrap.remove();
        if (after.anchored) {
          row("note", "Every task in " + (state.projectName || "this project") + " now starts in " + after.workdir + ".");
          // Its own folder still wins, so the header will not change. Saying
          // nothing here reads as if the anchor had not taken.
          if (after.overridden) row("note", "This task keeps its own folder, which was set directly.");
        }
        // Moving the folder means a new session: the old transcript lives under
        // the old path and can't be resumed from here.
        else if (before && after.workdir !== before) row("note", "Folder changed, so this task starts a new session.");
        refresh();
      } catch (e) {
        row("err", e.message);
        // Outside the fence is a question, not a dead end: the operator can
        // widen this drawer's folders without touching the agent's own.
        if (e.offer) offerFolder(e.offer, go);
        go.disabled = false;
      }
    };
    wrap.append(path, pick, go, whole);
    foot.prepend(wrap);
  }

  /** "That folder is outside the list. Add it?" */
  function offerFolder(dir, go) {
    const wrap = el("div", "bar");
    const add = el("button", "primary", "Add this folder");
    add.onclick = async () => {
      add.disabled = true;
      try {
        await post("/allow", { workdir: dir });
        wrap.remove();
        row("note", "Added " + dir + " to this drawer's folders.");
        go.click();
      } catch (e2) {
        row("err", e2.message);
        add.disabled = false;
      }
    };
    wrap.append(el("div", "empty", dir + " is not in this drawer's folders yet."), add);
    body.append(wrap);
    scroll();
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

  /** The streamed reply is done: render its markdown in place. */
  function settle() {
    if (typing && typingRaw.trim()) typing.replaceChildren(md(typingRaw));
    typing = null;
    typingRaw = "";
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
        if (!typing) {
          typing = row("", "");
          typingRaw = "";
        }
        // Plain text while it streams: half a fence or half a bullet renders
        // as a flicker of wrong shapes. It settles into markdown at the end.
        typingRaw += ev.text;
        typing.textContent = typingRaw;
        const entries = log();
        const last = entries[entries.length - 1];
        if (last && last.kind === "") last.text = typingRaw;
        scroll();
      } else if (ev.type === "tool") {
        settle();
        row("tool", ev.line || ev.name + " " + summarise(ev.input).split("\n")[0].slice(0, 160));
      } else if (ev.type === "ask") {
        settle();
        askCard(ev);
      } else if (ev.type === "bound") {
        state.workdir = ev.workdir;
        state.sessionId = ev.sessionId;
        paint();
      } else if (ev.type === "turn") {
        settle();
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

  /**
   * Tell the bridge what the task actually says, so a turn opens knowing it.
   * Without this the agent gets a task number and nothing else, and has to go
   * looking for the task through some connector that may not even reach the
   * right workspace. Whoever mounts the drawer already has this text on screen.
   */
  const shared = new Map(); // task id -> what we last sent
  async function shareContext(name, description, lineage) {
    if (!current || !auth) return;
    const chain = lineage?.parents ?? [];
    const trail = lineage?.trail ?? [];
    const text = [name || "", description || "", chain.join(","), trail.join(">")].join("\u0000");
    if (!name && !description && !chain.length && !trail.length) return;
    if (shared.get(current) === text) return;
    shared.set(current, text);
    try {
      await post("/context", { title: name || "", description: description || "", parents: chain, trail });
    } catch {
      // Context is a nicety. Losing it must never stop the drawer working.
    }
  }

  /** The name is the heading; the number is small print beside the folder. */
  function setHeading(id, name) {
    title.textContent = name || (id ? "Task " + id : "Claude");
    title.title = id ? "Task " + id : "";
    label.textContent = "";
  }

  function setTask(id, name, description, lineage) {
    id = id == null ? null : String(id);
    if (id === current) {
      if (name) setHeading(id, name);
      shareContext(name, description, lineage);
      return;
    }
    setHeading(id, name);
    current = id;
    typing = null;
    typingRaw = "";
    state = {};
    body.replaceChildren();
    root.querySelector(".bindrow")?.remove();
    stream?.close();
    stream = null;

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
    replay(id);
    shareContext(name, description, lineage);
    open();
    refresh();
  }

  /**
   * Put the task's conversation back on screen.
   *
   * What this page has shown is in memory. What it showed before a reload is
   * not, and the agent's session outlives the panel, so it answers "as I said
   * in my last reply" over a blank drawer. The bridge keeps the scrollback,
   * and it is only asked when this page has nothing of its own.
   */
  async function replay(id) {
    const mine = history.get(id) ?? [];
    for (const e of mine) {
      if (e.ask) askCard(e.ask, false);
      else row(e.kind, e.text, false);
    }
    if (mine.length) return;

    let said = [];
    try {
      const res = await fetch(`${bridge}/history?task=${encodeURIComponent(id)}&t=${encodeURIComponent(auth)}`);
      said = (await res.json()).said ?? [];
    } catch {
      // No history is not an error worth a red line: the drawer still works.
    }
    // The task may have been switched away from while that was in flight, and
    // a turn may have started and drawn into the body.
    if (id !== current || (history.get(id) ?? []).length) return;
    history.set(id, said.slice());
    for (const e of said) row(e.kind, e.text, false);
    if (!said.length) body.append(el("div", "empty", "Nothing yet for this task."));
  }

  send.onclick = async () => {
    const text = input.value.trim();
    if (!text || !current) return;
    body.querySelector(".empty")?.remove();
    row("you", text);
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
