/**
 * Keeps an agent with shell access inside its own lane when several agents
 * (possibly for different BasicOps workplaces) share one machine and user.
 *
 *  - Credentials: the agents' keys and configs live in ~/.config/basicops-agent/.
 *    No tool call may reference that folder (bundled skill plugins under
 *    plugins/ excepted), so one agent can't pick up another workplace's key.
 *  - Folders: when coding.allowedDirs is set, file tools must stay inside those
 *    folders (plus the agent's skill plugins), and a Bash command may not name a
 *    path under the home folder outside them.
 *
 * This is a guard against mistakes, not a sandbox: a determined shell command
 * can still get around a text check. Hard isolation needs a separate OS user.
 */
import { realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const CREDENTIALS = /basicops-agent\/(?!plugins\/)|basicops-agent\/?(?=["'\s]|$)/;
const FILE_TOOLS: Record<string, string> = {
  Read: "file_path", Write: "file_path", Edit: "file_path", MultiEdit: "file_path",
  NotebookEdit: "notebook_path", Glob: "path", Grep: "path", LS: "path",
};

export const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export const isWithin = (p: string, roots: string[]) => {
  const target = real(resolve(p));
  return roots.some((r) => target === r || target.startsWith(r.endsWith(sep) ? r : r + sep));
};

/** Allowed roots: the configured folders, plus each skill plugin and the real folders its skills link to. */
export function fenceRoots(allowedDirs: string[], pluginPaths: string[]): string[] {
  const roots = allowedDirs.map((d) => real(resolve(expandHome(d))));
  for (const p of pluginPaths) {
    roots.push(real(p));
    try {
      for (const s of readdirSync(join(p, "skills"))) roots.push(real(join(p, "skills", s)));
    } catch {}
  }
  return roots;
}

/** Home-folder paths a shell command names (absolute, ~/ or $HOME/). */
function homePaths(command: string): string[] {
  const home = homedir();
  const out: string[] = [];
  const re = new RegExp(`(?:${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|~|\\$HOME|\\$\\{HOME\\})(/[^\\s"';|&<>()]*)?`, "g");
  for (const [, rest] of command.matchAll(re)) out.push(join(home, rest ?? ""));
  return out;
}

/** PreToolUse hook enforcing the credential guard and, when `roots` is given, the folder fence. */
export function fenceHook(cwd: string, roots?: string[], allowedDirs: string[] = []): HookCallback {
  const where = allowedDirs.length ? ` You can use: ${allowedDirs.join(", ")}.` : "";
  const deny = (reason: string) => {
    console.log(`  [fence] denied: ${reason}`);
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } };
  };
  return async (input) => {
    const tool = (input as any).tool_name as string;
    const args = (input as any).tool_input ?? {};
    if (CREDENTIALS.test(JSON.stringify(args))) {
      return deny("Agent keys and configs (~/.config/basicops-agent) are off limits to every agent.");
    }
    if (!roots) return {};
    // A tool result too large to return inline (a downloaded image, a long doc) is
    // saved under this session's own folder; the agent must be able to read it back.
    const transcript = (input as any).transcript_path;
    const allowed =
      typeof transcript === "string" && transcript.endsWith(".jsonl")
        ? [...roots, real(transcript.slice(0, -".jsonl".length)) + sep + "tool-results"]
        : roots;
    if (tool in FILE_TOOLS) {
      const raw = args[FILE_TOOLS[tool]];
      const p = typeof raw === "string" && raw ? expandHome(raw) : cwd;
      if (!isWithin(isAbsolute(p) ? p : join(cwd, p), allowed)) {
        return deny(`${raw} is outside the folders this agent may use.${where}`);
      }
    } else if (tool === "Bash" && typeof args.command === "string") {
      const outside = homePaths(args.command).find((p) => !isWithin(p, allowed));
      if (outside) return deny(`The command touches ${outside}, outside the folders this agent may use.${where}`);
    }
    return {};
  };
}

const BASICOPS_READ = /^mcp__basicops__(get|list|download|link_to)_/;

/** PreToolUse hook that limits the agent's own BasicOps tools to reads. */
export const basicopsReadOnlyHook: HookCallback = async (input) => {
  const tool = (input as any).tool_name as string;
  if (!tool?.startsWith("mcp__basicops__") || BASICOPS_READ.test(tool)) return {};
  console.log(`  [read-only] denied ${tool}`);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason:
        "Your own BasicOps access is read-only. Return your reply as HTML (it's posted for you); make any change or post as Justin through his BasicOps connector, if one is enabled.",
    },
  };
};

/**
 * Locks the operator's BasicOps connector to one workplace. Its reads are free,
 * but a write (anything not get_/list_/download_/link_to_) is denied until this
 * run's get_workspace_information on that same connector returned `workplaceUrl`.
 * Create one per run: verification never carries over to the next run. On a
 * turn the operator didn't trigger, every call to it is denied.
 */
export function workplaceLock(prefix: string, workplaceUrl: string, operatorTurn = true): { pre: HookCallback; post: HookCallback } {
  let verified = false;
  const isRead = (tool: string) => /__(get|list|download|link_to)_/.test(tool);
  return {
    pre: async (input) => {
      const tool = (input as any).tool_name as string;
      if (!tool?.startsWith(`${prefix}__`)) return {};
      if (!operatorTurn) {
        console.log(`  [workplace] denied ${tool} (not the operator's turn)`);
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: "This connection acts as your operator and is only for their own requests.",
          },
        };
      }
      if (verified || isRead(tool)) return {};
      console.log(`  [workplace] denied ${tool} (workplace not verified this run)`);
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason:
            `Call ${prefix}__get_workspace_information first. Writes through this connector unlock only once it reports ${workplaceUrl}.`,
        },
      };
    },
    post: async (input) => {
      const tool = (input as any).tool_name as string;
      if (tool !== `${prefix}__get_workspace_information`) return {};
      verified = JSON.stringify((input as any).tool_response ?? "").includes(workplaceUrl);
      console.log(`  [workplace] ${verified ? "verified" : "MISMATCH, writes stay locked:"} ${prefix} → ${workplaceUrl}`);
      return {};
    },
  };
}
