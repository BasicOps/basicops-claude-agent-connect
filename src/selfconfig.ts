/**
 * An in-process MCP tool that lets a TRUSTED (allowlisted) operator attach a
 * BasicOps project to a local folder by asking the agent — instead of editing
 * the config file by hand. It ONLY writes the project→folder mapping into the
 * agent's own config; it can't touch anything else on the box.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

/** Build the self-config MCP server bound to a specific agent config file. */
export function selfConfigServer(configFilePath: string) {
  return createSdkMcpServer({
    name: "selfconfig",
    version: "0.1.0",
    tools: [
      tool(
        "attach_project",
        "Attach a BasicOps project to a local folder on THIS server, so the agent operates in that folder for the project's tasks and discussions. Use when the operator asks to link/attach/point a project at a directory. Applies immediately (no restart).",
        {
          projectId: z.union([z.string(), z.number()]).describe("The BasicOps project id to attach"),
          directory: z.string().describe("Absolute path to the local folder on this server"),
        },
        async (args) => {
          const pid = String(args.projectId).trim();
          const dir = String(args.directory).trim();
          if (!/^\d+$/.test(pid)) return err(`"${pid}" is not a numeric project id.`);
          if (!isAbsolute(dir)) return err(`Directory must be an absolute path; got "${dir}".`);

          let cfg: any = {};
          if (existsSync(configFilePath)) {
            try {
              cfg = JSON.parse(readFileSync(configFilePath, "utf8"));
            } catch (e: any) {
              return err(`Existing config is not valid JSON (${e.message}); fix it before attaching.`);
            }
          }
          cfg.coding ??= {};
          if (!Array.isArray(cfg.coding.allowUsers) || cfg.coding.allowUsers.length === 0) {
            return err("Coding mode has no allowUsers configured, so I can't safely enable filesystem access. Ask the operator to set coding.allowUsers first.");
          }
          cfg.coding.projects ??= {};
          cfg.coding.projects[pid] = dir;

          if (!existsSync(dir)) {
            try {
              mkdirSync(dir, { recursive: true });
            } catch (e: any) {
              return err(`Couldn't create ${dir}: ${e.message}`);
            }
          }
          writeFileSync(configFilePath, JSON.stringify(cfg, null, 2));
          return ok(`Attached BasicOps project ${pid} → ${dir}. It's live now — mention me in that project and I'll work in that folder.`);
        },
      ),
    ],
  });
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true });
