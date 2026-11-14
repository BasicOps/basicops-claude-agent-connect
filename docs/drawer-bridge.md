# Drawer bridge (prototype)

A task-bound Claude session on this Mac. One BasicOps task id = one Claude
session + one folder, remembered across restarts. Switching tasks in the app is
just a different task id on the wire, so the session that answers switches with
it, with nothing inferred from a URL or a front tab.

This is the local half of the BasicOps drawer. The drawer UI itself lives in the
BasicOps web app; until it exists, `/` serves a throwaway panel that speaks the
same protocol.

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

## Protocol

| Call | Does |
|------|------|
| `GET /` | the test panel |
| `GET /state?task=` | `{ workdir, sessionId, busy, pending }` |
| `GET /events?task=` | SSE: `text`, `tool`, `ask`, `bound`, `turn` |
| `POST /bind` | `{ task, workdir }` bind the task's folder |
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
- **Watch the per-turn cost.** It is reported on each `turn done` event, and the
  first turn of a session is dearer than it looks.
