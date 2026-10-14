/**
 * Standing rules for the BasicOps agents, loaded fresh on every run from the
 * same files Claude Code itself loads, so an agent called from BasicOps follows
 * the same rules as a Claude Code session in the terminal, VS Code or desktop.
 * The rules live in the Justin AI OS vault (github.com/jtoberbauer/justin-os).
 *
 * Three scopes, in order (later is more specific):
 *   1. Global: ~/.claude/CLAUDE.md, which imports the vault's
 *      AGENT-OPERATING-RULES.md (scripts/install-rules.sh sets this up).
 *   2. Agent-User: the agent was called from inside a BasicOps account, so it
 *      loads the vault's 70 SOPs/BasicOps-Agent-User-Rules.md. Any project.
 *   3. Project: the attached project's folder and its CLAUDE.md,
 *      CLAUDE.local.md and AGENTS.md. A BasicOps client project's
 *      CLAUDE.local.md imports the BasicOps client rules, so those apply only
 *      to BasicOps client work, never just because BasicOps called the agent.
 *
 * `@path` imports are expanded the way Claude Code does it: relative to the
 * importing file, `~` = home, up to 5 levels deep, ignored inside code.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Lookup order from the vault's 70 SOPs/Agent-Obsidian-Context-SOP.md. */
const KNOWN_VAULT_PATHS = [
  "/home/gus/.openclaw/workspace/obsidian-ai-os/Justin-OS",
  join(homedir(), "Obsidian", "Justin-AI-OS", "justin-os"),
];
const VAULT_REMOTE = "jtoberbauer/justin-os";
const GLOBAL_CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");
const GLOBAL_RULES_DOC = "AGENT-OPERATING-RULES.md";
const AGENT_USER_RULES_DOC = "70 SOPs/BasicOps-Agent-User-Rules.md";
const PROJECT_RULE_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
const MAX_IMPORT_DEPTH = 5;
const MAX_FILE_CHARS = 40_000;
const PULL_INTERVAL_MS = 10 * 60_000;

export type AttachedProject = { id: string; dir?: string };

const isVault = (p: string) => existsSync(join(p, "AGENTS.md")) && existsSync(join(p, "INDEX.md"));

function hasVaultRemote(p: string): boolean {
  try {
    return execFileSync("git", ["-C", p, "remote", "-v"], { encoding: "utf8", timeout: 5000 }).includes(VAULT_REMOTE);
  } catch {
    return false;
  }
}

/**
 * Resolve the local vault clone: config `vault`, then $JUSTIN_AI_OS_VAULT, then
 * the known paths. A path counts only if it has AGENTS.md + INDEX.md and its git
 * remote is the justin-os repo. Undefined if none qualifies.
 */
export function resolveVault(configured?: string): string | undefined {
  for (const c of [configured, process.env.JUSTIN_AI_OS_VAULT, ...KNOWN_VAULT_PATHS]) {
    if (c && isVault(c) && hasVaultRemote(c)) return c;
  }
  return undefined;
}

function readCapped(path: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n\n[truncated]` : text;
  } catch {
    return undefined;
  }
}

/** `@path` import targets in a file, skipping fenced blocks and inline code. */
function importTargets(text: string, fromFile: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out: string[] = [];
  for (const [, raw] of prose.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s@`]+\.md)\b/gm)) {
    const p = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : join(dirname(fromFile), raw);
    out.push(p);
  }
  return out;
}

/**
 * Read a rules file plus everything it imports, as labelled sections. `seen`
 * dedupes across the whole stack so a note imported twice is included once.
 */
function loadWithImports(path: string, seen: Set<string>, depth = 0): { path: string; text: string }[] {
  if (seen.has(path) || depth > MAX_IMPORT_DEPTH) return [];
  const text = readCapped(path);
  if (text === undefined) return [];
  seen.add(path);
  const out = [{ path, text }];
  for (const target of importTargets(text, path)) out.push(...loadWithImports(target, seen, depth + 1));
  return out;
}

const tilde = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

export class RuleBook {
  readonly vault: string | undefined;
  private lastPull = 0;

  constructor(configuredVault?: string) {
    this.vault = resolveVault(configuredVault);
  }

  /** Fast-forward the vault clone at most every 10 min, in the background. */
  private refresh() {
    if (!this.vault || Date.now() - this.lastPull < PULL_INTERVAL_MS) return;
    this.lastPull = Date.now();
    execFile("git", ["-C", this.vault, "pull", "--ff-only", "--quiet"], { timeout: 30_000 }, (err) => {
      if (err) console.error(`  [rules] vault pull failed (using local copy): ${err.message.split("\n")[0]}`);
    });
  }

  /** Global scope: ~/.claude/CLAUDE.md (as Claude Code loads it), else the vault note directly. */
  private globalFiles(seen: Set<string>) {
    if (existsSync(GLOBAL_CLAUDE_MD)) return loadWithImports(GLOBAL_CLAUDE_MD, seen);
    return this.vault ? loadWithImports(join(this.vault, GLOBAL_RULES_DOC), seen) : [];
  }

  /** Every file a run about `projects` would load (for startup logging). */
  files(projects: AttachedProject[] = []): string[] {
    return this.sections(projects).flatMap((s) => s.files.map((f) => f.path));
  }

  private sections(projects: AttachedProject[]) {
    const seen = new Set<string>();
    const global = this.globalFiles(seen);
    const agentUser = this.vault ? loadWithImports(join(this.vault, AGENT_USER_RULES_DOC), seen) : [];
    const project =
      projects.length === 1 && projects[0].dir
        ? PROJECT_RULE_FILES.flatMap((name) => loadWithImports(join(projects[0].dir!, name), seen))
        : [];
    return [
      { title: "1. Global rules (every agent, every surface)", files: global },
      { title: "2. BasicOps Agent-User rules (you were called from a BasicOps account)", files: agentUser },
      { title: "3. Project rules", files: project },
    ];
  }

  /** The full rule stack as a system-prompt section, re-read from disk each call. */
  build(projects: AttachedProject[] = []): string {
    this.refresh();
    const [global, agentUser, project] = this.sections(projects);
    const out: string[] = [
      `# Standing rules`,
      `You load the same rules as every Claude Code session Justin runs, plus the BasicOps Agent-User rules, fresh on every run from the Justin AI OS vault. Follow them in everything you write, post or do. Where they conflict, the more specific scope wins: project over Agent-User over global. Client rules (for example the BasicOps copy rules) apply only when the project's own rules import them.`,
    ];
    if (!this.vault) {
      out.push(`The Justin AI OS vault is not available on this machine. Mention once to the operator that the vault clone is missing (set JUSTIN_AI_OS_VAULT or "vault" in the agent config).`);
    }

    for (const s of [global, agentUser]) {
      out.push(`## ${s.title}`);
      out.push(s.files.length ? s.files.map((f) => `### ${tilde(f.path)}\n\n${f.text}`).join("\n\n") : "(none found on this machine)");
    }

    out.push(`## ${project.title}`);
    if (!projects.length) {
      out.push(`This run is not about a specific BasicOps project, so no project or client rules apply.`);
    } else {
      for (const p of projects) {
        out.push(
          p.dir
            ? `BasicOps project ${p.id} is attached to the local folder \`${p.dir}\`, the project's source of truth for files, docs and code.`
            : `BasicOps project ${p.id} is not attached to a local folder, so no project or client rules apply to it.`,
        );
      }
      if (projects.length > 1) out.push(`This run covers several projects; check a project's own rules in its folder before writing anything client-facing for it.`);
      for (const f of project.files) out.push(`### ${tilde(f.path)}\n\n${f.text}`);
    }
    return out.join("\n\n");
  }
}
