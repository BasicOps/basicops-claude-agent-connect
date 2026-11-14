/**
 * Drawer bridge (prototype) — a task-bound Claude session, on this Mac.
 *
 * The BasicOps drawer (or the throwaway panel at `/`) talks to this over plain
 * HTTP on 127.0.0.1: POST a message for a task, read the reply back as Server-
 * Sent Events. One task id = one Claude session + one folder, remembered across
 * restarts. Switching tasks in the app is just a different task id on the wire,
 * so the session that answers switches with it, with nothing inferred.
 *
 *   GET  /                      the raw protocol tester
 *   GET  /demo, /drawer.js      the drawer, and a pretend app to switch tasks in
 *   GET  /state?task=&t=        { workdir, sessionId, busy }
 *   GET  /events?task=&t=       SSE: text, tool, ask, turn, error
 *   POST /bind                  { task, workdir }      bind the task's folder
 *   POST /message               { task, text }         run a turn
 *   POST /approve               { task, id, allow }     answer an approval
 *   POST /reset                 { task }               forget the session, keep the folder
 *   POST /stop                  { task }               abort the running turn
 *
 * Every request carries the bridge token (`Authorization: Bearer` or `?t=`),
 * generated on first run into ~/.config/basicops-agent/bridge.json. The server
 * binds to 127.0.0.1 only, and tool calls run behind the same fence the webhook
 * listener uses, so the agent stays inside the folders you allow and can't read
 * the agents' credentials.
 *
 * Unlike the webhook path this asks before it acts: file and shell tools come
 * back to the drawer as an approval, because a drawer has somebody to ask.
 *
 * Prototype, deliberately: it streams to the drawer and does not post into the
 * BasicOps task thread, so a turn here leaves no record in BasicOps yet.
 */
import http from "node:http";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type PermissionResult, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { expandHome, fenceHook, fenceRoots } from "./fence.js";
import { PersistedMap, sessionExists } from "./state.js";

const CONFIG_DIR = join(homedir(), ".config", "basicops-agent");
const CONFIG_PATH = join(CONFIG_DIR, "bridge.json");
const SESSIONS_PATH = join(CONFIG_DIR, "bridge.sessions.json");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = "text/html; charset=utf-8";
/**
 * `/` is the raw protocol tester. `/demo` is a pretend BasicOps with a task
 * list, so you can watch the session follow the task you click; it mounts the
 * same drawer.js the real app would.
 */
const STATIC: Record<string, { path: string; type: string }> = {
  "/": { path: "panel/index.html", type: HTML },
  "/demo": { path: "drawer/demo.html", type: HTML },
  "/drawer.js": { path: "drawer/drawer.js", type: "text/javascript; charset=utf-8" },
};

/** The only tools a drawer turn can reach at all. */
const CODING_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS", "TodoWrite", "NotebookEdit", "WebFetch", "WebSearch"];
/** Tools that keep the session open after the reply, so a turn would never finish. */
const BLOCKED_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "Monitor", "RemoteTrigger"];
/**
 * Reads that run without asking. `allowedTools` means "auto-allow, don't
 * prompt", so anything NOT in here (Write, Edit, Bash) reaches canUseTool and
 * comes back to the drawer as an approval. Adding a write tool to this list
 * silently turns the prompts off.
 */
const AUTO_OK = ["Read", "Glob", "Grep", "LS", "TodoWrite", "WebFetch", "WebSearch"];

type BridgeConfig = {
  /** Shared secret every request must present. Generated on first run. */
  token: string;
  /** Loopback port. Default 4710. */
  port?: number;
  /**
   * Folders a drawer turn may touch, on top of the task's own folder. Keep this
   * tight: it is the only thing standing between a wrong turn and your home dir.
   */
  allowedDirs?: string[];
  /** Browser origins allowed to call the bridge (the drawer's page). */
  origins?: string[];
  /**
   * Claude Code binary to drive. Default: `claude` on PATH. The SDK's own
   * bundled CLI (2.0.77) cannot complete a permission round-trip: it answers
   * with a duplicate tool_use id and exits 1, so every approval kills the turn.
   * The installed CLI handles it, so the bridge insists on a real one.
   */
  claudePath?: string;
};

type Binding = { workdir: string; sessionId?: string };

type Pending = { name: string; input: Record<string, unknown>; settle: (r: PermissionResult) => void };
type Run = { abort: AbortController; pending: Map<string, Pending> };

function loadConfig(): BridgeConfig {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let cfg: BridgeConfig | undefined;
  if (existsSync(CONFIG_PATH)) {
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch (e: any) {
      throw new Error(`${CONFIG_PATH} is not valid JSON: ${e.message}`);
    }
  }
  if (!cfg?.token) {
    cfg = { ...(cfg ?? {}), token: randomBytes(24).toString("hex") };
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    console.log(`[bridge] new token written to ${CONFIG_PATH}`);
  }
  return cfg;
}

/**
 * The operator's message as streaming input: one user message, then the input
 * closes so the turn ends. A plain string prompt would run the CLI in one-shot
 * mode, where it emits no partial messages (and exits non-zero if you ask for
 * them), so the drawer would only see the reply once it was finished.
 */
async function* oneTurn(text: string): AsyncGenerator<SDKUserMessage> {
  yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
}

/** The installed Claude Code binary, or undefined if there isn't one on PATH. */
function findClaude(configured?: string): string | undefined {
  if (configured) return existsSync(expandHome(configured)) ? expandHome(configured) : undefined;
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    return p && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** A real, existing directory, or a reason it won't do. */
function checkDir(raw: unknown): { dir: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Give a folder path." };
  const dir = resolve(expandHome(raw.trim()));
  try {
    if (!statSync(dir).isDirectory()) return { error: `${dir} is not a folder.` };
  } catch {
    return { error: `${dir} doesn't exist. Create it first, or pick another folder.` };
  }
  return { dir };
}

export async function startBridge(): Promise<number> {
  const cfg = loadConfig();
  const port = cfg.port ?? 4710;
  const allowedDirs = (cfg.allowedDirs ?? []).map((d) => resolve(expandHome(d)));
  const claudePath = findClaude(cfg.claudePath);
  if (!claudePath) {
    throw new Error(
      "No Claude Code binary found. Install it (or set claudePath in " +
        `${CONFIG_PATH}): the SDK's bundled CLI breaks every approval prompt.`,
    );
  }
  const bindings = new PersistedMap<Binding>(SESSIONS_PATH);
  const runs = new Map<string, Run>();
  const clients = new Map<string, Set<http.ServerResponse>>();

  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(cfg.origins ?? [])]);

  /** Push an event to every panel watching this task. */
  const send = (task: string, event: Record<string, unknown>) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients.get(task) ?? []) res.write(line);
  };

  /**
   * Why this task can't start a turn right now, or undefined if it can. Checked
   * before /message answers, so the caller is never told "accepted" for a turn
   * that is about to refuse itself.
   */
  function blocked(task: string): string | undefined {
    const bound = bindings.get(task);
    if (!bound) return "This task has no folder yet. Bind one first.";
    if (runs.has(task)) return "This task is already working. Stop it or wait for it to finish.";
    // One session per folder at a time: two tasks editing the same checkout
    // would overwrite each other's work with no way to tell afterwards.
    for (const other of runs.keys()) {
      if (bindings.get(other)?.workdir === bound.workdir) {
        return `Task ${other} is already working in ${bound.workdir}. One task at a time per folder.`;
      }
    }
    return undefined;
  }

  async function runTurn(task: string, text: string) {
    const bound = bindings.get(task)!;
    const abort = new AbortController();
    const pending = new Map<string, Pending>();
    runs.set(task, { abort, pending });

    // A session can only be resumed from the folder it started in: Claude Code
    // files transcripts per working directory.
    const resume = bound.sessionId && sessionExists(bound.sessionId, bound.workdir) ? bound.sessionId : undefined;
    if (bound.sessionId && !resume) console.log(`  [bridge] session ${bound.sessionId} not found under ${bound.workdir}; starting fresh`);
    send(task, { type: "turn", state: "start", resumed: !!resume, workdir: bound.workdir });

    let streamed = false; // did this assistant message arrive as deltas?
    const roots = fenceRoots(allowedDirs.length ? [...allowedDirs, bound.workdir] : [bound.workdir], []);
    const fence = fenceHook(bound.workdir, roots, allowedDirs.length ? [...allowedDirs, bound.workdir] : [bound.workdir]);

    try {
      for await (const m of query({
        // Streaming input (a generator, not a string) is what lets the CLI emit
        // partial messages, so the drawer gets text as it is written.
        prompt: oneTurn(text),
        options: {
          resume,
          cwd: bound.workdir,
          abortController: abort,
          includePartialMessages: true,
          tools: CODING_TOOLS,
          allowedTools: AUTO_OK,
          disallowedTools: BLOCKED_TOOLS,
          hooks: { PreToolUse: [{ hooks: [fence] }] },
          canUseTool: async (name, input, { signal, toolUseID }) => {
            return new Promise<PermissionResult>((settle) => {
              const id = toolUseID || randomUUID();
              pending.set(id, { name, input, settle });
              console.log(`  [bridge] waiting on ${name} (${id})`);
              send(task, { type: "ask", id, name, input });
              signal.addEventListener("abort", () => {
                if (!pending.delete(id)) return;
                settle({ behavior: "deny", message: "The operator stopped the turn.", interrupt: true });
              });
            });
          },
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              `You are answering in a drawer beside BasicOps task ${task}. The folder \`${bound.workdir}\` on this Mac is that task's workspace. ` +
              `Do the work there, then reply with a short summary of what you changed and what you ran. ` +
              `Your file and shell calls are shown to the operator for approval as you make them, so work in small, obvious steps.`,
          },
          maxTurns: 60,
          pathToClaudeCodeExecutable: claudePath,
          // Load no Claude Code settings. Otherwise the operator's own
          // ~/.claude allowlist decides what runs unprompted, and a tool they
          // allowed themselves long ago would never reach the drawer's approval.
          settingSources: [],
          stderr: (d: string) => {
            const line = d.trim();
            if (line) console.error(`  [claude stderr] ${line}`);
          },
        },
      })) {
        const sid = (m as any).session_id;
        if (sid && sid !== bindings.get(task)?.sessionId) bindings.set(task, { ...bound, sessionId: sid });

        if (m.type === "stream_event") {
          const ev: any = (m as any).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            streamed = true;
            send(task, { type: "text", text: ev.delta.text });
          }
        } else if (m.type === "assistant") {
          for (const block of (m as any).message?.content ?? []) {
            // Anything not auto-allowed arrives as an `ask` carrying the same
            // call, so announcing it here too would show it to the operator twice.
            if (block?.type === "tool_use" && AUTO_OK.includes(block.name)) send(task, { type: "tool", name: block.name, input: block.input });
            // Only when the deltas didn't arrive (partial messages unsupported,
            // or a cached reply): otherwise this would repeat what was typed.
            else if (block?.type === "text" && !streamed && block.text) send(task, { type: "text", text: block.text });
          }
          streamed = false;
        } else if (m.type === "result") {
          const r: any = m;
          send(task, {
            type: "turn",
            state: "done",
            subtype: r.subtype,
            turns: r.num_turns,
            cost: r.total_cost_usd,
            sessionId: bindings.get(task)?.sessionId,
          });
        }
      }
    } catch (e: any) {
      const stopped = abort.signal.aborted;
      console.error(`  [bridge] turn ${stopped ? "stopped" : "failed"}: ${e.message}`);
      send(task, { type: "turn", state: stopped ? "stopped" : "error", error: stopped ? undefined : e.message });
    } finally {
      for (const [, p] of pending) p.settle({ behavior: "deny", message: "The turn ended.", interrupt: true });
      runs.delete(task);
    }
  }

  const body = (req: http.IncomingMessage) =>
    new Promise<any>((res, rej) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 1_000_000) rej(new Error("body too large"));
      });
      req.on("end", () => {
        try {
          res(raw ? JSON.parse(raw) : {});
        } catch {
          rej(new Error("body is not JSON"));
        }
      });
      req.on("error", rej);
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
      return res.end();
    }

    // Static files are public: they can do nothing without a token.
    const file = STATIC[url.pathname];
    if (file && req.method === "GET") {
      try {
        res.writeHead(200, { "Content-Type": file.type });
        return res.end(readFileSync(join(ROOT, file.path), "utf8"));
      } catch {
        return json(500, { error: `${file.path} not found under ${ROOT}` });
      }
    }

    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if ((bearer || url.searchParams.get("t")) !== cfg.token) return json(401, { error: "bad or missing bridge token" });

    const task = String(url.searchParams.get("task") ?? "");

    if (url.pathname === "/events" && req.method === "GET") {
      if (!task) return json(400, { error: "task is required" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`retry: 2000\n\n`);
      const set = clients.get(task) ?? new Set();
      set.add(res);
      clients.set(task, set);
      const keepalive = setInterval(() => res.write(`: ping\n\n`), 25_000);
      console.log(`[bridge] panel watching task ${task} (${set.size} open)`);
      req.on("close", () => {
        clearInterval(keepalive);
        set.delete(res);
        if (!set.size) clients.delete(task);
      });
      return;
    }

    if (req.method !== "POST") {
      if (url.pathname === "/state") {
        if (!task) return json(400, { error: "task is required" });
        const b = bindings.get(task);
        const run = runs.get(task);
        return json(200, {
          task,
          workdir: b?.workdir ?? null,
          sessionId: b?.sessionId ?? null,
          busy: !!run,
          // So a drawer that was closed mid-turn can show the prompt it missed.
          pending: [...(run?.pending ?? [])].map(([id, p]) => ({ id, name: p.name, input: p.input })),
        });
      }
      return json(404, { error: "not found" });
    }

    let payload: any;
    try {
      payload = await body(req);
    } catch (e: any) {
      return json(400, { error: e.message });
    }
    const id = String(payload.task ?? task ?? "");
    if (!id) return json(400, { error: "task is required" });

    if (url.pathname === "/bind") {
      const checked = checkDir(payload.workdir);
      if ("error" in checked) return json(400, { error: checked.error });
      if (allowedDirs.length && !fenceRoots(allowedDirs, []).some((r) => checked.dir === r || checked.dir.startsWith(r + "/"))) {
        return json(400, { error: `${checked.dir} is outside the folders this bridge may use (${allowedDirs.join(", ")}).` });
      }
      const prev = bindings.get(id);
      // The folder is part of a session's identity: a session started elsewhere
      // can't be resumed here, so moving the folder starts a new thread.
      const sessionId = prev && prev.workdir === checked.dir ? prev.sessionId : undefined;
      bindings.set(id, { workdir: checked.dir, sessionId });
      console.log(`[bridge] task ${id} → ${checked.dir}${sessionId ? ` (session ${sessionId})` : " (new session)"}`);
      send(id, { type: "bound", workdir: checked.dir, sessionId: sessionId ?? null });
      return json(200, { task: id, workdir: checked.dir, sessionId: sessionId ?? null });
    }

    if (url.pathname === "/message") {
      const text = String(payload.text ?? "").trim();
      if (!text) return json(400, { error: "text is required" });
      const why = blocked(id);
      if (why) return json(409, { error: why });
      // Run in the background: the reply arrives on the task's SSE stream.
      runTurn(id, text).catch((e) => send(id, { type: "turn", state: "error", error: e.message }));
      return json(202, { task: id, accepted: true });
    }

    if (url.pathname === "/approve") {
      const run = runs.get(id);
      const p = run?.pending.get(String(payload.id ?? ""));
      if (!run || !p) return json(404, { error: "no pending approval with that id" });
      run.pending.delete(String(payload.id));
      p.settle(
        payload.allow
          ? { behavior: "allow", updatedInput: p.input }
          : { behavior: "deny", message: String(payload.reason ?? "The operator declined this."), interrupt: !payload.reason },
      );
      return json(200, { ok: true });
    }

    if (url.pathname === "/reset") {
      const b = bindings.get(id);
      if (!b) return json(404, { error: "that task has no folder bound" });
      if (runs.has(id)) return json(409, { error: "stop the running turn first" });
      bindings.set(id, { workdir: b.workdir });
      console.log(`[bridge] task ${id} session cleared (folder kept: ${b.workdir})`);
      send(id, { type: "bound", workdir: b.workdir, sessionId: null });
      return json(200, { task: id, workdir: b.workdir, sessionId: null });
    }

    if (url.pathname === "/stop") {
      const run = runs.get(id);
      if (!run) return json(404, { error: "nothing running for that task" });
      run.abort.abort();
      return json(200, { ok: true });
    }

    return json(404, { error: "not found" });
  });

  return new Promise((res, rej) => {
    server.once("error", rej);
    // Loopback only. Anything that can reach this port can run shell commands.
    server.listen(port, "127.0.0.1", () => {
      console.log(`[bridge] listening on http://127.0.0.1:${port}`);
      console.log(`[bridge] panel:  http://127.0.0.1:${port}/?t=${cfg.token}`);
      console.log(`[bridge] drawer: http://127.0.0.1:${port}/demo?t=${cfg.token}`);
      console.log(`[bridge] claude:  ${claudePath}`);
      console.log(`[bridge] folders: ${allowedDirs.length ? allowedDirs.join(", ") : "(any, set allowedDirs in bridge.json to fence it)"}`);
      console.log(`[bridge] bound tasks: ${bindings.size || "none yet"}`);
      res(port);
    });
  });
}
