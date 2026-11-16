# Drawer bridge (prototype)

A task-bound Claude session on this Mac. One BasicOps task id = one Claude
session + one folder, remembered across restarts. Switching tasks in the app is
just a different task id on the wire, so the session that answers switches with
it, with nothing inferred from a URL or a front tab.

This is the local half of the BasicOps drawer. The drawer UI is in
[`drawer/drawer.js`](../drawer/drawer.js): one framework-free ES module the app
mounts, with everything inside a shadow root so the app's CSS and the drawer's
can't reach each other.

## Run it

```bash
npm run bridge
```

First run writes `~/.config/basicops-agent/bridge.json` with a generated token
and prints the panel URL. Open it, paste a task id and a folder, and talk.

`bridge.json`:

| Key | Meaning |
|-----|---------|
| `token` | Shared secret every request carries. Generated for you. |
| `port` | Loopback port. Default 4710. |
| `allowedDirs` | Folders a turn may touch. Empty means any folder, which is not what you want once this is real. |
| `origins` | Browser origins allowed to call the bridge, e.g. `https://app.basicops.com`. |
| `claudePath` | Claude Code binary. Default: `claude` on PATH. |
| `claudeAiConnectors` | claude.ai connectors a turn may use, by name. Empty (the default) denies every one. |
| `agent` | An agent whose capabilities the drawer takes on, e.g. `"roy-claude"`. |
| `approvals` | Ask before every write and shell call. Default: true alone, false with `agent`. |

## Running as an agent

```json
{ "agent": "roy-claude" }
```

The drawer then runs as that agent: its MCP servers, plugins, claude.ai
connector allowlist, standing rules, operator instructions, folder fence,
BasicOps read-only rule and workplace lock, all from
`~/.config/basicops-agent/<agent>.json`. Anything set in `bridge.json` wins,
so the drawer can differ deliberately.

**Based on the agent, not dependent on it.** The folder fence starts from the
agent's list and is the drawer's own from there. Bind a task to a folder
outside it and the drawer asks whether to add it, keeping it in
`bridge.allowed.json`. The agent's config is never edited, so a folder a task
needed once does not widen what the agent may touch on every run of its own.

```
[bridge] agent: roy-claude
[bridge] mcp servers: basicops-taskflow, campaign-previewer
[bridge] workplace: https://taskflow.basicops.com
[bridge] connectors: Claude Docs, Google Docs, ... (no BasicOps among them)
```

This is worth more than it looks. Without it the drawer was a parallel
universe with its own rules, reaching for a BasicOps claude.ai connector
signed into another workspace, while the agent that owns that very folder had
a `basicops-taskflow` MCP server pointed at the right one all along. An agent
you have already configured is a better starting point than a fresh set of
defaults.

### Approvals

Running as an agent means running the way that agent runs. Roy does not stop
and ask before each tool call, so neither does a drawer matching it: the fence,
the connector allowlist, the BasicOps read-only rule and the workplace lock do
the gating, and they are hooks, which run whatever the permission mode. Set
`"approvals": true` to get the per-call cards back.

With no agent configured the drawer asks, because a drawer acting unseen is
worse than one that asks.

### Subtasks

A subtask with no folder of its own works in its parent's. The session is
still the subtask's own, so it gets its own thread in the same checkout, and
the header says `(from #<parent>)`. Binding the subtask directly overrides it.

Finding the parent takes two routes, because neither covers everything:

1. **The overlay stack**, `?ol-…/3936.<parent>/…/3936.<child>/…`, when you
   opened the child on top of its parent. Ids, so exact.
2. **The breadcrumb**, `.breadcrumb .breadcrumb-link`. Walk down the task tree
   instead and the URL names one task with no chain at all, which is how a
   subtask ended up with no folder. The breadcrumb is there either way, but it
   carries only names, so the bridge matches them against task names it has
   been told. It knows a task's name once you have opened it; `bridge.names.json`
   keeps that across restarts.

The API does not help here: `get_task` returns the project, not the parent
task, so the parent can only be found from what is on screen.

### The task's name

The drawer shows the task's name, with its number as small print. The name is
read from the page's one visible `.task-title`, which belongs to the task the
URL names. Simpler than fishing it out of a socket frame, and it is the same
text you are looking at, which is the point: a wrong task is visible.

## Putting the drawer in the app

```js
import { mountDrawer } from "./drawer.js";

const drawer = mountDrawer({
  bridge: "http://127.0.0.1:4710",
  mount: document.querySelector("#drawer"),
});

// The whole contract: call this on every task route change.
drawer.setTask(task.id);
```

That one call is the app's entire job. The drawer asks the bridge which folder
and session belong to that task, so "which task is this" is never inferred from
a URL or a front tab: the app already knows, and it says so.

`mountDrawer({ bridge, token, task, mount })` returns `{ element, setTask,
destroy }`. Without a `token` the drawer asks for one and keeps it in
localStorage. Add the app's origin to `origins` in `bridge.json` or the browser
will refuse the calls.

Try it at `/demo`: a pretend BasicOps with three tasks, mounting the same
module the real app would.

Transcripts are kept in memory per task, so switching away and back shows the
conversation again. A page reload loses them: the bridge streams turns, it
doesn't store them. The durable record belongs in the task thread, which is the
next piece.

## Protocol

| Call | Does |
|------|------|
| `GET /` | the raw protocol tester |
| `GET /demo`, `/drawer.js` | the drawer, and a pretend app to switch tasks in |
| `GET /state?task=` | `{ workdir, sessionId, busy, pending }` |
| `GET /events?task=` | SSE: `text`, `tool`, `ask`, `bound`, `turn` |
| `POST /bind` | `{ task, workdir }` bind the task's folder |
| `POST /context` | `{ task, title, description }` what the task says |
| `POST /pick` | open a folder picker on the Mac, return the path |
| `POST /allow` | `{ workdir }` add a folder to the drawer's own fence |
| `POST /message` | `{ task, text }` run a turn |
| `POST /approve` | `{ task, id, allow }` answer an approval |
| `POST /reset` | `{ task }` forget the session, keep the folder |
| `POST /stop` | `{ task }` abort the running turn |

`/message` returns 202 and the reply arrives on the task's SSE stream. Every
refusal (no folder, already working, folder busy) comes back on the POST, not
later on the stream.

## What it does differently from the webhook listener

- **It asks before it acts.** The webhook path runs `bypassPermissions` behind
  the fence, because a webhook has nobody to ask. Here, every write and shell
  call comes back to the drawer as an `ask` and waits. Reads
  (`Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `WebFetch`, `WebSearch`) run
  unprompted.
- **It streams.** Text arrives as it is written, not as one post at the end.
- **It loads none of your Claude Code settings** (`settingSources: []`).
  Otherwise your own `~/.claude` allowlist decides what runs unprompted, and a
  tool you allowed yourself long ago would never reach the drawer's approval.
  Your global CLAUDE.md rules do not load either; if the drawer should follow
  them, load them explicitly into the system prompt.

## Things worth knowing

- **It must drive the installed `claude`, not the SDK's bundled CLI.** The SDK
  ships CLI 2.0.77, which cannot complete a permission round-trip: it answers
  with a duplicate `tool_use` id and the process exits 1, killing the turn. The
  bridge refuses to start without a real Claude Code binary.
- **The folder is part of a session's identity.** Claude Code files transcripts
  per working directory, so a session can only be resumed from the folder it
  started in. Re-binding a task to a different folder starts a new thread; the
  old one is still on disk under the old path.
- **One task at a time per folder.** Two tasks editing the same checkout would
  overwrite each other with no way to tell afterwards, so the second is refused.
  Give each task its own worktree when that starts to bite.
- **The CLI auto-approves shell commands it judges read-only**, so `ls -la`
  runs without reaching the drawer. Only genuinely mutating calls prompt.
- **Loopback only.** Anything that can reach this port can run shell commands as
  you. The token is in the panel URL, which is fine on 127.0.0.1 and not a model
  to copy for anything reachable.
- **Nothing is posted into BasicOps.** A turn here leaves no record in the task
  thread yet.
- **The agent reads the task from your screen, not from BasicOps.** The bridge
  has no BasicOps credentials and the CLI's own connectors may be signed into
  the wrong workspace entirely, so whoever mounts the drawer sends the title
  and description to `/context` and the system prompt carries them. It is
  marked as a copy that may be stale, because it is one.
- **claude.ai connectors are denied unless you name them.** `settingSources: []`
  does not fence them: the CLI loads every connector on the account anyway. So
  the bridge reuses the listener's `connectorsForTurn` hook, and with
  `claudeAiConnectors` empty (the default) any `mcp__claude_ai_*` tool is
  refused outright.

  This matters more than it looks. The connectors belong to the Claude account
  the bridge runs as, and that account can be signed into a different workspace
  than the task on your screen. A turn bound to a Taskflow task reached for a
  BasicOps connector signed into another workspace, got "access denied", and
  spent five approval prompts finding that out. The task's own text arrives on
  `/context`, so there is usually nothing to fetch in the first place.

  To allow one, name it as it appears in its tool names:
  `mcp__claude_ai_BasicOps_-_MarinGrade__get_task` is the connector
  `"BasicOps - MarinGrade"`.
- **Watch the per-turn cost.** It is reported on each `turn done` event, and the
  first turn of a session is dearer than it looks.

## The Chrome extension

`extension/` puts the drawer in a Chrome side panel. It is the same `drawer.js`
in a different container: the bridge and the protocol are untouched.

Two reasons it exists rather than pasting `inject.js` into the page:

- **It can reach the bridge.** An extension page is not a public origin, so
  Chrome's local network block does not apply and the panel can hold an
  `EventSource` open to `http://127.0.0.1:4710` directly. No tunnel.
- **It reads the page, and only reads it.** One content script, in the
  extension's own world: the URL for the task id, the DOM for the name and the
  breadcrumb. It touches nothing the app owns.

  There was a second script in the page's own world, patching `fetch`, `XHR`
  and the `WebSocket` to harvest task text. It never delivered anything, and
  injecting it into an already-running page made BasicOps navigate away from
  the task you had open. It is gone. The task's text comes from the agent's
  own BasicOps MCP server, which is live, authoritative, and in the right
  workspace, and the system prompt tells the turn to use it.

  (Two dead ends worth recording: `api.basicops.com` is the API the MCP server
  uses, not the one the web app uses, and the web app talks over a WebSocket,
  so a dashboard load makes seventy HTTP requests carrying no data at all.)

The split that matters, and that I got backwards at first:

> **The URL says which task is open. The API says what that task contains.**

A feed or a list fetches many tasks, so the last task the app fetched is just
the last row that loaded, not the one you are looking at. Taking the id from a
fetch pinned the drawer to whichever task loaded first and then never moved.
The URL decides the id, every time it changes; the fetches only fill in details
for ids already seen. If no URL rule matches, no task is open: showing nothing
is safe in a way that showing a plausible wrong task is not.

**Reloading the extension no longer means reloading your tabs.** Chrome kills
the content scripts already running and does not put them back, which left the
drawer deaf until you reloaded the tab and threw away whatever you were looking
at. The worker now injects them again into open BasicOps tabs on install and on
browser startup, so the panel picks up the task you already have open. The
"reload the tab" notice stays as a fallback for when that fails.

### Load it

1. `npm run bridge` (leave it running)
2. `chrome://extensions`, turn on Developer mode
3. **Load unpacked**, pick `extension/`
4. Open a BasicOps task, click the extension's toolbar icon
5. Paste the bridge token once when the drawer asks, then bind a folder

The panel follows whichever tab is in front, so a task opening in a background
tab does not move it.

### Files

| File | Does |
|------|------|
| `manifest.json` | side panel, host permission for the bridge, content scripts |
| `sidepanel.html` / `.js` | mounts `drawer.js`, follows the active tab |
| `watch-main.js` | page world: patches `fetch`/`XHR`, reads the task id and title |
| `watch.js` | extension world: relays to the worker, URL fallback |
| `background.js` | remembers the open task per tab |
| `drawer.js` | a copy. `npm run ext:sync` after editing `drawer/drawer.js`. |

The copy is there because MV3 forbids loading remote code, so the panel cannot
import `drawer.js` from the bridge. One source of truth stays
`drawer/drawer.js`; the sync script keeps the copy honest.

### What it does not fix

The extension is yours, on this machine. It is not something a BasicOps
customer gets, and the bridge is still on loopback running shell commands as
you. If this ever ships to other people, the transport question reopens on
different terms.

## Using it in a real BasicOps

Tested against the live app on 2026-11-14. Two things block an injected drawer,
and both come from injecting rather than from the drawer itself.

### Chrome won't let the app reach the bridge

`https://app.basicops.com` cannot open `http://127.0.0.1:4710`. Not CORS, and
not mixed content: the request never leaves the browser, so nothing reaches the
bridge. A plain fetch, a `no-cors` fetch and an `<img>` all hang. This is
Chrome's local network access restriction on a public page reaching a local
address. The bridge answers the Private Network Access preflight
(`Access-Control-Allow-Private-Network`), which is necessary and not sufficient.

The ways out, in the order worth trying:

1. **Give the bridge an https origin on the tailnet.** This Mac already runs
   Tailscale, so `tailscale serve --bg --https=8443 --set-path=/
   http://127.0.0.1:4710` puts it at
   `https://<machine>.<tailnet>.ts.net:8443` with a real certificate, reachable
   from the tailnet only, not the internet. Then point the drawer at that
   origin and add it to `origins`. Use `serve`, never `funnel`: this bridge
   runs shell commands, and Funnel is the public internet.
2. **A Chrome extension.** Its service worker can reach `127.0.0.1` with host
   permissions, so it works where the page cannot. That is the one job the
   extension is genuinely needed for, and it is a transport, not a way to
   work out which task is open.
3. **The app ships its own transport**, which is the real answer, and the only
   one that works for anybody other than you.

### The URL does not reliably say which task is open

BasicOps has at least three URL shapes and they contradict each other. With a
task open over a list, the path names the list's task and the page title names
that one too, while the task actually on screen appears only as `3936.<id>`
inside the `ol-` query parameter:

```
/…/list/l2221477/v95673-2221477/task-details/…?ol-…/3936.2221868/…
       ^ not the open task                              ^ the open task
```

`drawer/inject.js` handles all three (overlay first, then the plain
`/list/l<id>/` route, then the `?l=` share link, whose token is the id in base
36 with six more characters; checked against 50 real tasks). It gets the live
app right.

But read that again: the obvious signals point at a **neighbouring real task**,
not at nothing. A wrong read binds a session to a plausible wrong task rather
than failing visibly. The drawer shows the task name beside the id for exactly
that reason, and a task can do nothing until you bind a folder to it.

This is the mixup you called out when you chose the drawer over the extension,
and it is worse than it looked from outside. Inside the app it doesn't exist:
the app knows the task and passes it to `setTask`. Injection is a way to try
the thing, not a way to ship it.
