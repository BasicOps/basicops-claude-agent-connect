/**
 * Small listener state that must survive restarts (the funnel watchdog and
 * deploys restart the agent often): which Agent SDK session each BasicOps
 * conversation resumes, the proactive review's rolling session, and the Gmail
 * send approval. Each map is a JSON file next to the agent's config. The
 * session transcripts themselves are already on disk (Claude Code writes them);
 * this only remembers which one belongs to which conversation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class PersistedMap<V> extends Map<string, V> {
  private ready = false;

  constructor(private readonly path: string | undefined) {
    super();
    if (path) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, "utf8")))) super.set(k, v as V);
      } catch {
        // missing or unreadable → start empty
      }
    }
    this.ready = true;
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    if (this.ready) this.save();
    return this;
  }

  override delete(key: string): boolean {
    const had = super.delete(key);
    if (had) this.save();
    return had;
  }

  private save() {
    if (!this.path) return;
    try {
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this)), { mode: 0o600 });
    } catch (e: any) {
      console.error(`  [state] could not save ${this.path}: ${e.message}`);
    }
  }
}

/** `<config dir>/<slug>.<name>.json`, beside the agent's config file. */
export const statePath = (configPath: string | undefined, name: string) =>
  configPath ? configPath.replace(/\.json$/, `.${name}.json`) : undefined;

/**
 * Whether Claude Code has a transcript for `sessionId` recorded under `cwd`.
 * Sessions are stored per working directory, so a session can only be resumed
 * from the same folder it was started in.
 */
export const sessionExists = (sessionId: string, cwd: string) =>
  existsSync(join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`));
