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
- **`settingSources: []` does not fence connectors.** It stops your `~/.claude`
  settings loading, but the CLI's claude.ai connectors still reach the turn, so
  a turn can have BasicOps, Gmail or Drive tools. Each one comes back to the
  drawer as an approval, so nothing runs unseen, but the folder fence covers
  files and a connector is not a file.
- **Watch the per-turn cost.** It is reported on each `turn done` event, and the
  first turn of a session is dearer than it looks.

## The Chrome extension

`extension/` puts the drawer in a Chrome side panel. It is the same `drawer.js`
in a different container: the bridge and the protocol are untouched.

Two reasons it exists rather than pasting `inject.js` into the page:

- **It can reach the bridge.** An extension page is not a public origin, so
  Chrome's local network block does not apply and the panel can hold an
  `EventSource` open to `http://127.0.0.1:4710` directly. No tunnel.
- **It can read the task.** A content script runs at `document_start` in the
  page's own world and patches `fetch`/`XHR` before the app loads, so it sees
  every `/v1/task/<id>` reply go past, title and description included. Those go
  to `/context` and into the turn's system prompt.

The split that matters, and that I got backwards at first:

> **The URL says which task is open. The API says what that task contains.**

A feed or a list fetches many tasks, so the last task the app fetched is just
the last row that loaded, not the one you are looking at. Taking the id from a
fetch pinned the drawer to whichever task loaded first and then never moved.
The URL decides the id, every time it changes; the fetches only fill in details
for ids already seen. If no URL rule matches, no task is open: showing nothing
is safe in a way that showing a plausible wrong task is not.

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
