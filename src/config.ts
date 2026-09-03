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
 *       }
 *     },
 *     "plugins": ["/abs/path/to/plugin-dir"],  // each bundles skills/<name>/SKILL.md
 *     "allowedTools": ["Read", "Grep"]          // extra tools to permit (advanced)
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
   * `projects` or `workdir` must be set.
   */
  coding?: { workdir?: string; allowUsers: number[]; projects?: Record<string, string> };
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
};

/** Turn a config entry into a real SDK McpServerConfig (authToken → Bearer header). */
function normalizeServer(name: string, s: RawServer): McpServerConfig {
  if (s.command) {
    return { type: "stdio", command: s.command, args: s.args ?? [], env: s.env } as McpServerConfig;
  }
  if (!s.url) throw new Error(`mcpServers.${name}: needs a "url" (http/sse) or "command" (stdio)`);
  const headers: Record<string, string> = { ...(s.headers ?? {}) };
  if (s.authToken) headers.Authorization = `Bearer ${s.authToken}`;
  return { type: s.type === "sse" ? "sse" : "http", url: s.url, headers } as McpServerConfig;
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
      coding = { allowUsers, ...(workdir ? { workdir } : {}), ...(hasProjects ? { projects } : {}) };
    }
  }

  return { mcpServers, plugins, allowedTools, instructions, coding };
}
