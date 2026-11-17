/**
 * Optional per-agent capability config.
 *
 * Operators drop a JSON file at ~/.config/basicops-agent/<slug>.json to give the
 * agent extra abilities WITHOUT editing code — additional MCP connectors and
 * local skill plugins. Absent file → the agent behaves exactly as before.
 *
 * File shape (all keys optional):
 *   {
 *     "mcpServers": {
 *       "github": {
 *         "type": "http",
 *         "url": "https://api.example.com/mcp",
 *         "authToken": "xxx",           // → Authorization: Bearer xxx
 *         "headers": { "X-Extra": "1" } // merged (authToken wins Authorization)
 *       },
 *       "gmail": {                       // the agent's own Google sign-in (scripts/google-mcp-token.mjs)
 *         "type": "http",
 *         "url": "https://gmailmcp.googleapis.com/mcp/v1",
 *         "headersHelper": "node /abs/scripts/google-mcp-token.mjs headers /abs/token.json"
 *       }
 *     },
 *     "plugins": ["/abs/path/to/plugin-dir"],  // each bundles skills/<name>/SKILL.md
 *     "allowedTools": ["Read", "Grep"],         // extra tools to permit (advanced)
 *     "vault": "/abs/path/to/justin-os",        // Justin AI OS vault clone (see rules.ts)
 *     "claudeAiConnectors": ["Gmail"],          // operator's claude.ai connectors (see connectors.ts)
 *     "claudeCodePath": "/abs/path/to/claude"   // Claude Code binary (default: `claude` on PATH)
 *   }
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export type AgentCapabilities = {
  /** Extra MCP servers, keyed by name (in addition to the built-in `basicops`). */
  mcpServers: Record<string, McpServerConfig>;
  /** Local skill plugins to load. */
  plugins: { type: "local"; path: string }[];
  /** Tool allowlist additions beyond the auto-derived ones. */
  allowedTools: string[];
  /** Operator-supplied instructions appended to the agent's system prompt. */
  instructions?: string;
  /** Justin AI OS vault clone the standing rules load from. Default: auto-resolved (see rules.ts). */
  vault?: string;
  /**
   * Rule files loaded on every run, for an agent whose whole workplace belongs to
   * one client (e.g. the BasicOps client rules for an agent in BasicOps's own
   * workplace). `@imports` are expanded; `~` = home.
   */
  workplaceRules?: string[];
  /**
   * Channel ids where the agent answers every new message and thread reply, not
   * just @mentions. BasicOps only pushes mentions, so these are polled.
   */
  listenChannels?: number[];
  /**
   * The agent's own BasicOps key may only read (get_/list_/download_/link_to_).
   * Its conversation replies still post, because the listener posts them.
   */
  basicopsReadOnly?: boolean;
  /**
   * The operator's own BasicOps connection and the only workplace it may write
   * to: either an `mcpServers` entry the operator signed in to (`server`) or a
   * claude.ai connector (`connector`), e.g.
   * { server: "basicops-taskflow", workplaceUrl: "https://taskflow.basicops.com" }.
   */
  operatorBasicops?: { server?: string; connector?: string; workplaceUrl: string };
  /**
   * Read-only browsing in the operator's Chrome (Claude in Chrome) on operator
   * turns: `true` uses the current selection, `{ deviceId }` pins one profile.
   */
  chrome?: { deviceId?: string };
  /** When set, the agent ignores every event from a BasicOps user not on this list. */
  onlyUsers?: number[];
  /**
   * claude.ai connectors (e.g. "Gmail", "Google Calendar") the agent may use on
   * turns triggered by a coding.allowUsers operator. Never loaded for anyone else.
   */
  claudeAiConnectors?: string[];
  /** Claude Code binary to run (needed for claude.ai connectors). Default: `claude` on PATH. */
  claudeCodePath?: string;
  /**
   * Optional "coding agent" mode: give the agent real filesystem + shell access
   * (Read/Write/Edit/Bash/Grep/Glob → git, gh, builds), but ONLY for events
   * triggered by a BasicOps user id in `allowUsers`. Everyone else gets the normal
   * sealed agent. Omit entirely to keep the agent fully sealed.
   *
   * The working directory is chosen per event: if the event is in a BasicOps
   * project mapped in `projects` (projectId → local dir), that directory is used —
   * so a project is "attached" to a folder and its tasks/discussions operate there.
   * `workdir` is the fallback for events not in a mapped project. At least one of
   * `projects` or `workdir` must be set. `allowedDirs` (optional) fences file
   * and shell work, and attach_project, to those folders (see fence.ts).
   */
  coding?: { workdir?: string; allowUsers: number[]; projects?: Record<string, string>; allowedDirs?: string[] };
  /**
   * Optional "proactive" mode: on a schedule (hourly during work hours by
   * default) the agent reviews the user's open work in the attached projects and
   * nudges them — a DM with the priorities plus firm comments on slipping tasks.
   * The agent is purely reactive when this is omitted or `enabled` is not true.
   */
  proactive?: {
    enabled: boolean;
    /** BasicOps user id to nudge. Defaults to coding.allowUsers[0]. */
    dmUserId?: number;
    /** Project ids to review. Defaults to the keys of coding.projects. */
    projects?: string[];
    /** Work-hours window, local time, inclusive by hour (defaults 9..18). */
    startHour?: number;
    endHour?: number;
    /** Days to run on, 0=Sun..6=Sat (defaults Mon–Fri). */
    days?: number[];
    /** Also post nudge comments on slipping tasks, not just the DM (default true). */
    taskComments?: boolean;
    /** Tone hint for the nudges (default "firm"). */
    tone?: string;
  };
};

const EMPTY: AgentCapabilities = { mcpServers: {}, plugins: [], allowedTools: [] };

/** Plugins bundled with the package that load for EVERY agent, no config needed. */
const DEFAULT_PLUGIN_NAMES = ["basicops-default"];

/**
 * Resolve the bundled default plugins shipped in <pkg>/plugins. Works from source
 * (dist/config.js → ../plugins) and from the installed/packed package alike.
 * Silently skips any that aren't present so a stripped install still runs.
 */
export function defaultPlugins(): { type: "local"; path: string }[] {
  const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");
  return DEFAULT_PLUGIN_NAMES.map((name) => join(pluginsDir, name))
    .filter((p) => existsSync(join(p, ".claude-plugin", "plugin.json")))
    .map((path) => ({ type: "local" as const, path }));
}

/** Same slug rule as scripts/install-service.sh, so env + config filenames match. */
export function agentSlug(agent: string): string {
  const slug = agent.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
  return slug || "agent";
}

/** Absolute path we look for the config at (also used for logging/messages). */
export function configPath(agent: string): string {
  return join(homedir(), ".config", "basicops-agent", `${agentSlug(agent)}.json`);
}

type RawServer = {
  type?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  authToken?: string;
  headers?: Record<string, string>;
  /** Command printing a JSON object of headers on each connect (e.g. scripts/google-mcp-token.mjs). */
  headersHelper?: string;
};

/** Turn a config entry into a real SDK McpServerConfig (authToken → Bearer header). */
function normalizeServer(name: string, s: RawServer): McpServerConfig {
  if (s.command) {
    return { type: "stdio", command: s.command, args: s.args ?? [], env: s.env } as McpServerConfig;
  }
  if (!s.url) throw new Error(`mcpServers.${name}: needs a "url" (http/sse) or "command" (stdio)`);
  const headers: Record<string, string> = { ...(s.headers ?? {}) };
  if (s.authToken) headers.Authorization = `Bearer ${s.authToken}`;
  return {
    type: s.type === "sse" ? "sse" : "http",
    url: s.url,
    headers,
    // Not in the SDK's type, but the installed `claude` reads it from --mcp-config.
    ...(s.headersHelper ? { headersHelper: s.headersHelper } : {}),
  } as McpServerConfig;
}

/**
 * Load the capability config for an agent. Missing file → empty (no-op). A
 * malformed file throws, so a typo surfaces loudly at startup rather than
 * silently disabling capabilities the operator expected.
 */
export function loadCapabilities(agent: string): AgentCapabilities {
  const path = configPath(agent);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e: any) {
    // No config file → still load the bundled default skills.
    if (e?.code === "ENOENT") return { ...EMPTY, plugins: defaultPlugins() };
    throw new Error(`Could not read config ${path}: ${e.message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Config ${path} is not valid JSON: ${e.message}`);
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries(parsed.mcpServers ?? {})) {
    if (name === "basicops") throw new Error(`mcpServers.${name}: "basicops" is reserved.`);
    mcpServers[name] = normalizeServer(name, s as RawServer);
  }

  const pluginPaths: string[] = parsed.plugins ?? parsed.skills ?? []; // accept either key
  // Bundled defaults always load, plus whatever the operator added.
  const plugins = [...defaultPlugins(), ...pluginPaths.map((p) => ({ type: "local" as const, path: p }))];

  const allowedTools: string[] = Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [];
  const instructions =
    typeof parsed.instructions === "string" && parsed.instructions.trim() ? parsed.instructions.trim() : undefined;

  const vault = typeof parsed.vault === "string" && parsed.vault.trim() ? parsed.vault.trim() : undefined;
  const claudeAiConnectors = Array.isArray(parsed.claudeAiConnectors)
    ? parsed.claudeAiConnectors.filter((n: unknown) => typeof n === "string" && n.trim()).map((n: string) => n.trim())
    : undefined;
  const workplaceRules = Array.isArray(parsed.workplaceRules)
    ? parsed.workplaceRules.filter((r: unknown) => typeof r === "string" && r.trim()).map((r: string) => r.trim())
    : undefined;
  const listenChannels = Array.isArray(parsed.listenChannels)
    ? parsed.listenChannels.map(Number).filter((n: number) => Number.isFinite(n))
    : undefined;
  const ob = parsed.operatorBasicops;
  const operatorBasicops =
    ob && (typeof ob.server === "string" || typeof ob.connector === "string") && typeof ob.workplaceUrl === "string"
      ? {
          ...(typeof ob.server === "string" ? { server: ob.server } : { connector: ob.connector }),
          workplaceUrl: ob.workplaceUrl.replace(/\/$/, ""),
        }
      : undefined;
  const chrome =
    parsed.chrome === true
      ? {}
      : typeof parsed.chrome?.deviceId === "string" && parsed.chrome.deviceId.trim()
        ? { deviceId: parsed.chrome.deviceId.trim() }
        : undefined;
  const basicopsReadOnly = parsed.basicopsReadOnly === true || undefined;
  const onlyUsers = Array.isArray(parsed.onlyUsers)
    ? parsed.onlyUsers.map(Number).filter((n: number) => Number.isFinite(n))
    : undefined;
  const claudeCodePath = typeof parsed.claudeCodePath === "string" ? parsed.claudeCodePath : undefined;

  let coding: AgentCapabilities["coding"];
  if (parsed.coding && Array.isArray(parsed.coding.allowUsers)) {
    const allowUsers = parsed.coding.allowUsers.map(Number).filter((n: number) => Number.isFinite(n));
    const workdir = typeof parsed.coding.workdir === "string" ? parsed.coding.workdir : undefined;
    const projects: Record<string, string> = {};
    if (parsed.coding.projects && typeof parsed.coding.projects === "object") {
      for (const [k, v] of Object.entries(parsed.coding.projects)) if (typeof v === "string") projects[String(k)] = v;
    }
    const hasProjects = Object.keys(projects).length > 0;
    if (allowUsers.length && (workdir || hasProjects)) {
      const allowedDirs = Array.isArray(parsed.coding.allowedDirs)
        ? parsed.coding.allowedDirs.filter((d: unknown) => typeof d === "string" && d.trim())
        : undefined;
      coding = {
        allowUsers,
        ...(workdir ? { workdir } : {}),
        ...(hasProjects ? { projects } : {}),
        ...(allowedDirs?.length ? { allowedDirs } : {}),
      };
    }
  }

  let proactive: AgentCapabilities["proactive"];
  if (parsed.proactive && parsed.proactive.enabled === true) {
    const p = parsed.proactive;
    const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
    proactive = {
      enabled: true,
      dmUserId: num(p.dmUserId),
      projects: Array.isArray(p.projects) ? p.projects.map(String) : undefined,
      startHour: num(p.startHour),
      endHour: num(p.endHour),
      days: Array.isArray(p.days) ? p.days.map(Number).filter((n: number) => Number.isFinite(n)) : undefined,
      taskComments: typeof p.taskComments === "boolean" ? p.taskComments : undefined,
      tone: typeof p.tone === "string" ? p.tone : undefined,
    };
  }

  return { mcpServers, plugins, allowedTools, instructions, vault, workplaceRules, listenChannels, onlyUsers, basicopsReadOnly, operatorBasicops, chrome, claudeAiConnectors, claudeCodePath, coding, proactive };
}

/** Where the agent's environment file lives, beside its JSON config. */
export function envPath(agent: string): string {
  return join(homedir(), ".config", "basicops-agent", `${agentSlug(agent)}.env`);
}

/**
 * The agent's own environment, from `<slug>.env`.
 *
 * The launchd job that runs this agent as a BasicOps listener sources that
 * file before exec:
 *
 *   set -a; . "~/.config/basicops-agent/roy-claude.env"; set +a; exec node …
 *
 * so a listener run has `CPV_TOKEN` and friends, and anything started by hand
 * does not. The agent's skills reach for those tokens either way, so the
 * drawer inherited the agent's servers, plugins, connectors and instructions
 * and then failed at the one step that needed a credential, truthfully
 * reporting that no token was set. Reading the same file here closes that gap.
 *
 * Deliberately flat: `KEY=value`, `#` comments, optional `export`, optional
 * surrounding quotes. No `$VAR` expansion and no command substitution, so a
 * file that leans on either will differ from what the listener sees. Missing
 * file is normal and means no extra environment.
 */
export function loadAgentEnv(agent: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(envPath(agent), "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Could not read ${envPath(agent)}: ${e.message}`);
  }
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(text);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}
