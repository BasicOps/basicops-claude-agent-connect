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
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query, type PermissionResult, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { connectorPrefix, connectorsForTurn, resolveClaudeExecutable } from "./connectors.js";
import { loadCapabilities } from "./config.js";
import { basicopsReadOnlyHook, expandHome, fenceHook, fenceRoots, workplaceLock } from "./fence.js";
import { RuleBook } from "./rules.js";
import { PersistedMap, sessionExists } from "./state.js";

const CONFIG_DIR = join(homedir(), ".config", "basicops-agent");
const CONFIG_PATH = join(CONFIG_DIR, "bridge.json");
const SESSIONS_PATH = join(CONFIG_DIR, "bridge.sessions.json");
// Task names, kept across restarts so a subtask can still find its parent by
// breadcrumb after the bridge has been restarted.
const NAMES_PATH = join(CONFIG_DIR, "bridge.names.json");
// Folders the operator has added from the drawer. The drawer starts from the
// agent's folders; it does not borrow the agent's list, so adding one here
// never widens what the agent itself may touch.
const ALLOWED_PATH = join(CONFIG_DIR, "bridge.allowed.json");
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
  "/inject.js": { path: "drawer/inject.js", type: "text/javascript; charset=utf-8" },
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
   * claude.ai connectors this drawer may use, by name, e.g. ["BasicOps"].
   *
   * Empty (the default) denies every one of them. They belong to the Claude
   * account the bridge runs as, and that account can be signed into a
   * different workspace than the task you are looking at: a turn that reaches
   * for the wrong BasicOps gets "access denied" and an agent that goes hunting
   * instead of working. The task's own text arrives on `/context`, so there is
   * usually nothing to fetch.
   */
  claudeAiConnectors?: string[];
  /**
   * An agent whose capability config this drawer takes on, e.g. "roy-claude".
   *
   * The drawer then runs as that agent: its MCP servers, plugins, connector
   * allowlist, standing rules, operator instructions and folder fence, all
   * from `~/.config/basicops-agent/<agent>.json`. Without it the drawer is a
   * parallel universe with its own rules, which is how it ended up reaching
   * for a BasicOps signed into the wrong workspace while the agent that owns
   * that folder had the right one configured all along.
   *
   * Keys set here win over the agent's, so the drawer can differ deliberately.
   */
  agent?: string;
  /**
   * Stop and ask before every write and shell call. Default: true on its own,
   * false when `agent` is set, since that agent doesn't ask either.
   */
  approvals?: boolean;
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

/**
 * BasicOps descriptions are HTML. The agent wants the words, not the markup,
 * and a system prompt is no place for a stray `<script>` either. Capped,
 * because a long task should not crowd out the conversation.
 */
function plainText(html: string, limit = 4000): string {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > limit ? text.slice(0, limit) + "\n… (truncated)" : text;
}

/**
 * The task itself, for the system prompt. Marked as a copy, because it is one:
 * it was read from the operator's screen, not from BasicOps, so it can be out
 * of date and the agent should say so rather than trust it blindly.
 */
function taskBrief(ctx: { title: string; description: string } | undefined, reader?: string): string {
  // What the drawer knows is the task's number and the name on screen. The
  // text itself comes from the agent's own BasicOps server, which is live and
  // authoritative, so point at that rather than have it guess or ask.
  const how = reader
    ? `\n\nRead the task itself with \`${reader}__get_task\` (and its discussion and subtasks) before answering questions about it.`
    : `\n\nYou have only the task's number and name, and no tool configured to read it. Ask the operator what it says rather than hunting for it.`;
  if (!ctx || (!ctx.title && !ctx.description)) return how;
  const parts = ["\n\nThis is what the task says, copied from the operator's screen:"];
  if (ctx.title) parts.push(`\nTitle: ${ctx.title}`);
  if (ctx.description) parts.push(`\n\n${ctx.description}`);
  parts.push(`\n\nThat name is read off the operator's screen, so treat it as a label, not the record.${how}`);
  return parts.join("");
}

/** A real, existing directory, or a reason it won't do. */
function checkDir(raw: unknown): { dir: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "Give a folder path." };
  // Quotes come along when a path is dragged in or copied from a terminal.
  // Left in, the path stops being absolute and `resolve` silently hangs it off
  // the bridge's own folder, which produces a baffling error further down.
  const given = raw.trim().replace(/^['"]|['"]$/g, "").trim();
  if (!given.startsWith("/") && !given.startsWith("~")) {
    return { error: `Give the whole path, starting at /. "${given}" is relative.` };
  }
  const dir = resolve(expandHome(given));
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
  // The agent this drawer runs as, if any. Everything below prefers the
  // bridge's own config where it is set, and falls back to the agent's.
  const caps = cfg.agent ? loadCapabilities(cfg.agent) : undefined;
  const rules = caps ? new RuleBook(caps.vault, caps.workplaceRules) : undefined;
  /**
   * The fence: the agent's folders as a starting point, the bridge's own
   * config, and whatever the operator has since added from the drawer.
   *
   * Based on the agent, not dependent on it. Roy's list is where this starts,
   * but a task that needs another checkout should not mean editing Roy's
   * config and widening what Roy itself may touch on every run.
   */
  const added = new PersistedMap<string>(ALLOWED_PATH);
  const fenceDirs = () => {
    const dirs = [...(cfg.allowedDirs ?? []), ...(caps?.coding?.allowedDirs ?? [])].map((d) => resolve(expandHome(d)));
    for (const dir of added.values()) dirs.push(dir);
    return [...new Set(dirs)];
  };
  const allowedDirs = fenceDirs();
  // Which claude.ai connectors a turn may touch. Empty denies them all: the
  // hook refuses any `mcp__claude_ai_*` tool outside this list, so a connector
  // signed into the wrong workspace cannot be reached at all.
  const connectors = cfg.claudeAiConnectors ?? caps?.claudeAiConnectors ?? [];
  const conn = connectorsForTurn(connectors, false);
  // The agent's own BasicOps server, if it has one: the thing that can
  // actually read a task, in the workspace the operator is looking at.
  const basicopsReader = (() => {
    const named = caps?.operatorBasicops?.server;
    if (named) return `mcp__${named}`;
    const guess = Object.keys(caps?.mcpServers ?? {}).find((n) => /basicops/i.test(n));
    return guess ? `mcp__${guess}` : undefined;
  })();
  /**
   * Does every write and shell call stop and wait for the operator?
   *
   * With no agent to match, yes: a drawer that acts unseen is worse than one
   * that asks. Running as an agent, no, because that agent does not ask and
   * the point of naming one is to behave like it. The fence, the connector
   * allowlist, the read-only rule and the workplace lock still apply; they are
   * hooks, and they run whatever the permission mode.
   */
  const ask = cfg.approvals ?? !caps;
  /** The agent's own tool set: what the listener allows it, plus coding. */
  const agentTools = [
    "mcp__basicops",
    "WebSearch",
    "WebFetch",
    ...Object.keys(caps?.mcpServers ?? {}).map((name) => `mcp__${name}`),
    ...(caps?.plugins?.length ? ["Skill"] : []),
    ...(caps?.allowedTools ?? []),
    ...CODING_TOOLS,
    ...(connectors.length ? conn.allowedTools : []),
  ];
  const claudePath = findClaude(cfg.claudePath ?? caps?.claudeCodePath);
  if (!claudePath) {
    throw new Error(
      "No Claude Code binary found. Install it (or set claudePath in " +
        `${CONFIG_PATH}): the SDK's bundled CLI breaks every approval prompt.`,
    );
  }
  const bindings = new PersistedMap<Binding>(SESSIONS_PATH);
  const runs = new Map<string, Run>();
  // What each task says, as the drawer's page already has it on screen. Not
  // persisted: the page re-sends it every time it opens a task, and a stale
  // description would be worse than none.
  const context = new Map<string, { title: string; description: string }>();
  // A task's ancestors, nearest parent first, as the open overlay stack has
  // them. Not persisted: the page re-sends it whenever a task is opened.
  const parents = new Map<string, string[]>();
  // The same chain by name, from the breadcrumb, for when the URL has no
  // overlay stack to read (walking down the task tree gives none).
  const trails = new Map<string, string[]>();

  const names = new PersistedMap<string>(NAMES_PATH);

  /** The id of a task we have been told the name of. Most recent wins. */
  const idNamed = (want: string): string | undefined => {
    const w = want.trim().toLowerCase();
    let found: string | undefined;
    for (const [id, title] of names) if (title.trim().toLowerCase() === w) found = id;
    return found;
  };

  /**
   * The folder a task works in. Its own binding if it has one, otherwise the
   * nearest ancestor's: a subtask belongs to its parent's folder until someone
   * says otherwise. The session is still the task's own, so a subtask gets its
   * own thread in the same checkout.
   */
  const boundFor = (id: string): (Binding & { inheritedFrom?: string }) | undefined => {
    const own = bindings.get(id);
    if (own?.workdir) return own;
    // Ancestors by id (the overlay stack), nearest first.
    for (const up of parents.get(id) ?? []) {
      const anc = bindings.get(up);
      if (anc?.workdir) return { workdir: anc.workdir, sessionId: own?.sessionId, inheritedFrom: up };
    }
    // Then by name (the breadcrumb), nearest first. The breadcrumb has no ids,
    // so this only finds an ancestor the drawer has already seen by name.
    for (const name of [...(trails.get(id) ?? [])].reverse()) {
      const up = idNamed(name);
      const anc = up ? bindings.get(up) : undefined;
      if (up && anc?.workdir) return { workdir: anc.workdir, sessionId: own?.sessionId, inheritedFrom: up };
    }
    return own;
  };
  const clients = new Map<string, Set<http.ServerResponse>>();

  // The real app is allowed by default; anything else goes in `origins`.
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, "https://app.basicops.com", ...(cfg.origins ?? [])]);

  /**
   * The side panel's origin is `chrome-extension://<id>`, and the id is only
   * known once the extension is loaded, so it cannot be listed ahead of time.
   * Allowing the scheme is no weaker than what already guards this port: an
   * extension needs an explicit host permission for 127.0.0.1 before it can
   * ask at all, and every request still has to carry the token.
   */
  const allowed = (origin: string) => origins.has(origin) || origin.startsWith("chrome-extension://");

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
    const bound = boundFor(task);
    if (!bound?.workdir) return "This task has no folder yet. Bind one first.";
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
    const bound = boundFor(task)!;
    const abort = new AbortController();
    if (bound.inheritedFrom) console.log(`[bridge] task ${task} works in ${bound.workdir} (its parent #${bound.inheritedFrom}'s folder)`);
    const pending = new Map<string, Pending>();
    runs.set(task, { abort, pending });

    // A session can only be resumed from the folder it started in: Claude Code
    // files transcripts per working directory.
    const resume = bound.sessionId && sessionExists(bound.sessionId, bound.workdir) ? bound.sessionId : undefined;
    if (bound.sessionId && !resume) console.log(`  [bridge] session ${bound.sessionId} not found under ${bound.workdir}; starting fresh`);
    send(task, { type: "turn", state: "start", resumed: !!resume, workdir: bound.workdir });

    let streamed = false; // did this assistant message arrive as deltas?
    const dirs = fenceDirs();
    const roots = fenceRoots(dirs.length ? [...dirs, bound.workdir] : [bound.workdir], []);
    const fence = fenceHook(bound.workdir, roots, dirs.length ? [...dirs, bound.workdir] : [bound.workdir]);

    // Writing as the operator in BasicOps only after the server proves which
    // workplace it is actually pointed at. The whole mess today was a turn
    // talking to the wrong workspace, so this is worth inheriting.
    const ob = caps?.operatorBasicops;
    const lock = ob
      ? workplaceLock(ob.server ? `mcp__${ob.server}` : connectorPrefix(ob.connector!), ob.workplaceUrl, true)
      : undefined;
    const preToolHooks = [
      fence,
      conn.hook,
      ...(caps?.basicopsReadOnly ? [basicopsReadOnlyHook] : []),
      ...(lock ? [lock.pre] : []),
    ];

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
          // Running as an agent means running the way that agent runs: its whole
          // tool set, allowed, behind the fence and the hooks. Approvals are
          // the drawer's own idea, so they apply only when it has no agent to
          // match (or `approvals: true` asks for them back).
          ...(ask ? { tools: CODING_TOOLS } : {}),
          allowedTools: ask
            ? [...AUTO_OK, ...(caps?.allowedTools ?? []), ...(connectors.length ? conn.allowedTools : [])]
            : agentTools,
          disallowedTools: BLOCKED_TOOLS,
          ...(caps?.mcpServers && Object.keys(caps.mcpServers).length ? { mcpServers: caps.mcpServers } : {}),
          ...(caps?.plugins?.length ? { plugins: caps.plugins } : {}),
          hooks: {
            PreToolUse: [{ hooks: preToolHooks }],
            ...(lock ? { PostToolUse: [{ hooks: [lock.post] }] } : {}),
          },
          ...(ask
            ? {
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
              }
            : { permissionMode: "bypassPermissions" as const }),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append:
              `You are answering in a drawer beside BasicOps task ${task}. The folder \`${bound.workdir}\` on this Mac is that task's workspace. ` +
              `Do the work there, then reply with a short summary of what you changed and what you ran. ` +
              (ask
                ? `Your file and shell calls are shown to the operator for approval as you make them, so work in small, obvious steps.`
                : `The operator is watching every tool call as you make it, so work in small, obvious steps.`) +
              taskBrief(context.get(task), basicopsReader) +
              // The agent's standing rules and its operator's instructions,
              // re-read every turn so the drawer follows the same vault the
              // agent does without a restart.
              (rules ? `\n\n${rules.build([])}` : "") +
              (caps?.instructions ? `\n\n## Your operator's instructions\nFollow these unless they conflict with the rules above:\n${caps.instructions}` : "") +
              (connectors.length ? `\n\n${conn.prompt}` : ""),
          },
          maxTurns: 60,
          pathToClaudeCodeExecutable: claudePath,
          // Load no Claude Code settings. Otherwise the operator's own
          // ~/.claude allowlist decides what runs unprompted, and a tool they
          // allowed themselves long ago would never reach the drawer's
          // approval. `--setting-sources` also stops claude.ai connectors
          // loading at all, so when some are allowed we pass the env instead
          // and let the hook do the gating.
          ...(connectors.length ? { env: conn.env } : { settingSources: [] as [] }),
          stderr: (d: string) => {
            const line = d.trim();
            if (line) console.error(`  [claude stderr] ${line}`);
          },
        },
      })) {
        const sid = (m as any).session_id;
        if (sid && sid !== bindings.get(task)?.sessionId) {
          // The folder may be the parent's; the session is this task's own.
          bindings.set(task, { workdir: bound.workdir, sessionId: sid });
        }

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
    if (origin && allowed(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "OPTIONS") {
      const extra: Record<string, string> = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
      // A page on a public site reaching 127.0.0.1 is a Private Network Access
      // request: Chrome preflights it and needs this header, or the drawer in
      // the real app can't call the bridge at all.
      if (req.headers["access-control-request-private-network"] === "true") {
        extra["Access-Control-Allow-Private-Network"] = "true";
      }
      res.writeHead(204, extra);
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
      // Saying where the watcher came from makes it obvious whether the side
      // panel is talking (chrome-extension://…) or a leftover tab is.
      console.log(`[bridge] watching task ${task} from ${origin ?? "unknown"} (${set.size} open)`);
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
        const b = boundFor(task);
        const run = runs.get(task);
        return json(200, {
          task,
          workdir: b?.workdir ?? null,
          inheritedFrom: b?.inheritedFrom ?? null,
          parents: parents.get(task) ?? [],
          trail: trails.get(task) ?? [],
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
    /**
     * Add a folder to the drawer's own scope, because the operator said so.
     *
     * This is the drawer's list, kept beside its sessions. The agent's config
     * is not touched, so saying yes here never widens what the agent may do on
     * its own runs.
     */
    if (url.pathname === "/allow") {
      const checked = checkDir(payload.workdir);
      if ("error" in checked) return json(400, { error: checked.error });
      added.set(checked.dir, checked.dir);
      console.log(`[bridge] folder added by the operator: ${checked.dir}`);
      return json(200, { workdir: checked.dir, dirs: fenceDirs() });
    }


    const id = String(payload.task ?? task ?? "");
    if (!id) return json(400, { error: "task is required" });

    /**
     * Open a real folder picker, on the Mac, and return what was chosen.
     *
     * A browser cannot do this: `showDirectoryPicker` hands back a handle with
     * no path, and `webkitdirectory` gives relative names. But the bridge is
     * already running on the machine whose folders we are choosing, so it can
     * just ask macOS. The typed field stays for anyone whose bridge is not
     * sitting in front of them.
     */
    if (url.pathname === "/pick") {
      if (process.platform !== "darwin") return json(501, { error: "The picker is macOS only. Type the path instead." });
      const chosen = await new Promise<{ path?: string; error?: string }>((done) => {
        execFile(
          "osascript",
          ["-e", "activate", "-e", 'POSIX path of (choose folder with prompt "Folder for this task")'],
          { timeout: 120_000 },
          (err, stdout) => {
            // Cancelling is not a failure, it just means no folder.
            if (err) return done({ error: /canceled/i.test(String(err)) ? "" : "The picker didn't open." });
            done({ path: stdout.trim().replace(/\/$/, "") });
          },
        );
      });
      if (!chosen.path) return json(chosen.error ? 500 : 200, chosen.error ? { error: chosen.error } : { workdir: null });
      return json(200, { workdir: chosen.path });
    }

    /**
     * What the task says, from whoever mounted the drawer. They have the task
     * on screen and the credentials to read it; the bridge has neither.
     */
    if (url.pathname === "/context") {
      if (Array.isArray(payload.parents)) {
        const chain = payload.parents.filter((x: unknown) => typeof x === "string" && /^\d+$/.test(x)) as string[];
        if (chain.length) parents.set(id, chain);
        else parents.delete(id);
      }
      if (Array.isArray(payload.trail)) {
        const names = payload.trail.filter((x: unknown) => typeof x === "string" && x.trim()) as string[];
        if (names.length) trails.set(id, names);
        else trails.delete(id);
      }
      const title = typeof payload.title === "string" ? payload.title.trim() : "";
      const description = typeof payload.description === "string" ? plainText(payload.description) : "";
      if (!title && !description) {
        context.delete(id);
        return json(200, { task: id, context: null, parents: parents.get(id) ?? [] });
      }
      context.set(id, { title, description });
      if (title && names.get(id) !== title) names.set(id, title);
      console.log(`[bridge] task ${id} is "${title}" (${description.length} chars of description)`);
      return json(200, { task: id, context: { title, description: description.length } });
    }

    if (url.pathname === "/bind") {
      const checked = checkDir(payload.workdir);
      if ("error" in checked) return json(400, { error: checked.error });
      const dirs = fenceDirs();
      if (dirs.length && !fenceRoots(dirs, []).some((r) => checked.dir === r || checked.dir.startsWith(r + "/"))) {
        // Not a refusal so much as a question: the operator can say yes.
        return json(400, {
          error: `${checked.dir} is outside this drawer's folders.`,
          offer: checked.dir,
          dirs,
        });
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
      if (added.size) console.log(`[bridge]   ${added.size} of those you added from the drawer`);
      console.log(`[bridge] agent: ${cfg.agent ?? "(none, the drawer has its own capabilities)"}`);
      if (caps) {
        const servers = Object.keys(caps.mcpServers ?? {});
        console.log(`[bridge] mcp servers: ${servers.length ? servers.join(", ") : "none"}`);
        console.log(`[bridge] plugins: ${caps.plugins?.length ? caps.plugins.map((pl) => pl.path).join(", ") : "none"}`);
        if (caps.operatorBasicops) console.log(`[bridge] workplace: ${caps.operatorBasicops.workplaceUrl}`);
      }
      console.log(
        `[bridge] connectors: ${connectors.length ? connectors.join(", ") : "(none, every claude.ai connector is denied)"}`,
      );
      console.log(
        `[bridge] approvals: ${ask ? "every write and shell call asks first" : "off, matching the agent (the fence and hooks still apply)"}`,
      );
      console.log(`[bridge] bound tasks: ${bindings.size || "none yet"}`);
      res(port);
    });
  });
}
