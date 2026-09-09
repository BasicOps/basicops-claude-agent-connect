/**
 * Webhook listener. Hands each raw BasicOps payload to the Claude Agent SDK
 * (system prompt = the Agent doc; bundled basicops-webhook skill on top). The
 * skill RETURNS an HTML string rather than posting, so this listener is the
 * "separate component" that posts it — to the right surface, from context. If
 * the agent instead posts a message itself, we detect that and don't double-post.
 * Per-conversation session memory + a loop guard for the agent's own messages.
 */
import http from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentCapabilities } from "./config.js";
import { AGENT_SYSTEM_PROMPT } from "./prompt.js";
import { BasicOpsClient } from "./basicops.js";
import { selfConfigServer } from "./selfconfig.js";

export type ListenerConfig = {
  mcpUrl: string;
  apiKey: string;
  agentUserId: string; // skip the agent's own messages (loop guard)
  port: number;
  /** Optional extra MCP connectors + skill plugins from the per-agent config file. */
  capabilities?: AgentCapabilities;
  /** Path to this agent's config file (cited when guiding the user to attach a project). */
  configPath?: string;
  /** Re-read the coding config each event, so attach_project changes apply without a restart. */
  getCoding?: () => AgentCapabilities["coding"];
};

// Destructive tools the agent must never call (blocked even though the whole
// BasicOps server is otherwise allowed). disallowedTools takes precedence.
const BLOCKED_TOOLS = [
  "delete_task", "delete_project", "delete_note", "delete_section",
  "delete_channel", "delete_groupchat", "delete_message", "delete_reply",
  "delete_template", "delete_time_entry", "delete_task_dependency", "delete_webhook",
  "deactivate_user", "reactivate_user",
].map((t) => `mcp__basicops__${t}`);

type Incoming = {
  event: string;
  context: Record<string, any>; // full context: all surface/entity IDs
  request: string; // raw HTML of the user's message (as the skill expects)
  userId?: number;
  convId: string; // for per-conversation session memory
  fromAgent: boolean;
};

const htmlToText = (s: unknown): string =>
  String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

// Webhook shape: { event, context: { userId, taskId/chatId/…, messageId, replyId }, request }
// (also tolerates the batch shape: { events: [{ event, data: { context, request } }] }).
// We hand the whole { context, request } to the agent and let the skill drive.
function parseEvents(body: any, agentUserId: string): Incoming[] {
  const list = Array.isArray(body?.events) ? body.events : [body];
  return list.map((e: any): Incoming => {
    const context = e?.context ?? e?.data?.context ?? e?.data ?? {};
    const request = e?.request ?? e?.data?.request ?? e?.data?.message ?? e?.message ?? "";
    const convId = String(
      context.taskId ?? context.chatId ?? context.groupChatId ?? context.channelId ?? context.projectId ?? "default",
    );
    return {
      event: String(e?.event ?? context?.event ?? ""),
      context,
      request: typeof request === "string" ? request : JSON.stringify(request),
      userId: context.userId,
      convId,
      fromAgent: String(context.userId) === agentUserId,
    };
  });
}

export function startListener(cfg: ListenerConfig): Promise<number> {
  const sessions = new Map<string, string>(); // convId -> Agent SDK session id

  const caps = cfg.capabilities ?? { mcpServers: {}, plugins: [], allowedTools: [] };

  // The built-in BasicOps connector, plus any extra ones from config.
  const mcpServers = {
    basicops: {
      type: "http" as const,
      url: cfg.mcpUrl,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    },
    ...caps.mcpServers,
  };

  // Allowlist: BasicOps + web research (so the agent can look up REAL MCP setup
  // instructions instead of guessing) + one entry per extra MCP server + `Skill`
  // when plugins load + any explicit extras. disallowedTools still blocks
  // destructive ops; the agent has no filesystem/shell access.
  const baseAllowedTools = [
    "mcp__basicops",
    "WebSearch",
    "WebFetch",
    ...Object.keys(caps.mcpServers).map((name) => `mcp__${name}`),
    ...(caps.plugins.length ? ["Skill"] : []),
    ...caps.allowedTools,
  ];

  // Coding-mode tools (filesystem + shell → git, gh, builds). Only added for
  // events from an allowlisted user (see caps.coding), never for anyone else.
  const CODING_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS", "TodoWrite", "NotebookEdit"];

  // System prompt = the Agent doc, plus any operator instructions from the config.
  const systemPrompt = caps.instructions
    ? `${AGENT_SYSTEM_PROMPT}\n\n## Your operator's instructions\nFollow these unless they conflict with the rules above:\n${caps.instructions}`
    : AGENT_SYSTEM_PROMPT;

  // Stateless client the listener uses to POST the agent's returned HTML.
  const client = new BasicOpsClient(cfg.mcpUrl, cfg.apiKey);

  // In-process tool that lets an allowlisted operator attach a project to a
  // folder by asking (writes only the project→folder mapping in the config).
  const selfCfg = cfg.configPath ? selfConfigServer(cfg.configPath) : undefined;

  // Post `html` to the surface identified by the event context. Prefer replying
  // to the triggering message; otherwise use the surface-specific tool.
  async function postToSurface(ctx: Record<string, any>, html: string): Promise<string | undefined> {
    const m = { message: html };
    if (ctx.messageId) return client.call("create_reply_in_message", { messageId: ctx.messageId, ...m }).then(() => "reply");
    if (ctx.chatId) return client.call("create_message_in_chat", { chatId: ctx.chatId, ...m }).then(() => "chat");
    if (ctx.taskId) return client.call("create_message_in_task", { taskId: ctx.taskId, ...m }).then(() => "task");
    if (ctx.channelId) return client.call("create_message_in_channel", { channelId: ctx.channelId, ...m }).then(() => "channel");
    if (ctx.groupChatId) return client.call("create_message_in_groupchat", { groupchatId: ctx.groupChatId, ...m }).then(() => "groupchat");
    if (ctx.projectId) return client.call("create_message_in_project", { projectId: ctx.projectId, ...m }).then(() => "project");
    return undefined;
  }

  // Clear the agent's "working" status (the skill leaves this to us).
  async function clearStatus(ctx: Record<string, any>): Promise<void> {
    if (!ctx.messageId && !ctx.event) return;
    await client
      .call("set_agent_status", { event: ctx.event ?? "", id: ctx.messageId ?? ctx.replyId ?? "", status: "done" })
      .catch(() => {});
  }

  let loggedCapabilities = false;

  // Run the agent on the payload, then POST its returned HTML to the right
  // surface — unless the agent already posted a message itself (then we stay out
  // to avoid a duplicate). Empty output = intentional silence.
  async function handleEvent(ev: Incoming) {
    const resume = sessions.get(ev.convId);
    const payload = JSON.stringify({ context: ev.context, request: ev.request });

    // Coding mode: ONLY when this event was triggered by an allowlisted user.
    // Fail closed — no userId, or not on the list, means the normal sealed agent.
    // Re-read the coding config each event so attach_project changes hot-apply.
    const coding = cfg.getCoding ? cfg.getCoding() : caps.coding;
    const allowlisted = !!coding && ev.userId != null && coding.allowUsers.includes(Number(ev.userId));
    let workdir: string | undefined;
    if (allowlisted && coding) {
      const pid = ev.context.projectId != null ? String(ev.context.projectId) : undefined;
      workdir = (pid && coding.projects?.[pid]) || coding.workdir;
    }
    const coder = allowlisted && workdir ? { workdir } : undefined;
    if (coder) console.log(`  [coding] enabled for user ${ev.userId} in ${coder.workdir}`);
    else if (allowlisted) console.log(`  [coding] user allowed but no directory mapped for project ${ev.context.projectId ?? "(none)"}`);

    // Allowlisted operators can self-attach projects via the in-process tool.
    const canSelfConfig = allowlisted && !!selfCfg;
    const turnMcpServers = canSelfConfig ? { ...mcpServers, selfconfig: selfCfg } : mcpServers;
    const allowedTools = [
      ...(coder ? [...baseAllowedTools, ...CODING_TOOLS] : baseAllowedTools),
      ...(canSelfConfig ? ["mcp__selfconfig"] : []),
    ];

    let turnSystemPrompt = systemPrompt;
    if (coder) {
      turnSystemPrompt = `${systemPrompt}\n\n## Coding mode (trusted operator)\nThe working directory \`${coder.workdir}\` on this server IS this BasicOps project's local workspace — the source of truth for the project's files, folders, docs, and code. You have full filesystem + shell access there.\n\nWhen the request refers to a file, folder, directory, list, doc, README, "the codebase", or "the directories" that would live in the project, LOOK IN \`${coder.workdir}\` FIRST — run \`ls\`/\`Grep\`/\`Read\` (e.g. check the repo and its docs/ folder) before concluding it doesn't exist or assuming it's only a BasicOps note. Only fall back to searching BasicOps notes/tasks if it's clearly not a file. Do the engineering work requested — read/edit files, run commands, use git (pull, branch, commit, push) and gh, build, and test — with your tools. Complete the work before replying; then make your HTML reply a concise summary (files/commands, results, and any tasks created with their links).\n\nYou can also attach ANOTHER BasicOps project to a folder for the operator with the \`attach_project\` tool.`;
    } else if (allowlisted && ev.context.projectId != null) {
      // Allowlisted operator, but this project isn't attached to a folder yet —
      // and you CAN attach it yourself with attach_project.
      turnSystemPrompt =
        `${systemPrompt}\n\n## This project isn't attached to a folder yet\n` +
        `You have no filesystem access here yet, because this BasicOps project (id ${ev.context.projectId}) isn't mapped to a local folder on this server. ` +
        `You CAN fix that: if the operator names a folder (an absolute path on this server), call the \`attach_project\` tool with projectId ${ev.context.projectId} and that directory — it takes effect immediately, no restart. ` +
        `If they want coding work here but haven't given a path, ask which folder to attach (offer to create one). ` +
        `Only attach when they clearly want engineering work in this project. For non-coding questions, just answer normally without mentioning any of this.`;
    }

    const response = query({
      prompt:
        "You received a BasicOps webhook event. Handle it and produce your reply. " +
        "Event payload:\n\n" +
        payload,
      options: {
        resume,
        mcpServers: turnMcpServers,
        plugins: caps.plugins,
        allowedTools,
        disallowedTools: BLOCKED_TOOLS,
        systemPrompt: turnSystemPrompt,
        maxTurns: coder ? 60 : 14,
        ...(coder ? { cwd: coder.workdir, permissionMode: "bypassPermissions" as const } : {}),
        stderr: (d: string) => {
          const line = d.trim();
          if (line) console.error(`  [claude stderr] ${line}`);
        },
      },
    });

    let finalText = "";
    let agentPosted = false; // the agent called a posting tool itself
    for await (const m of response) {
      if (m.type === "system" && (m as any).subtype === "init" && !loggedCapabilities) {
        loggedCapabilities = true;
        const sys = m as any;
        const skills = (sys.skills ?? []).filter((s: string) => s !== "none");
        const servers = (sys.mcp_servers ?? []).map((s: any) => `${s.name}(${s.status})`);
        if (servers.length) console.log(`  [mcp] ${servers.join(", ")}`);
        if (skills.length) console.log(`  [skills] ${skills.join(", ")}`);
      } else if (m.type === "assistant") {
        for (const b of m.message.content as any[]) {
          if (b.type === "tool_use") {
            console.log(`  [tool] ${b.name}`);
            if (/mcp__basicops__(create_reply_in_message|create_message_in_)/.test(b.name)) agentPosted = true;
          } else if (b.type === "text" && b.text.trim()) {
            finalText = b.text; // keep the last non-empty text block as the reply
          }
        }
      } else if (m.type === "result") {
        sessions.set(ev.convId, m.session_id);
        if ((m as any).subtype === "success" && typeof (m as any).result === "string") finalText = (m as any).result;
        console.log(`  done (${m.num_turns} turns)`);
      }
    }

    // Extract the HTML the skill returned (its output starts at the first tag).
    const html = finalText.slice(finalText.indexOf("<")).trim();
    if (agentPosted) {
      console.log("  agent posted directly; not re-posting");
    } else if (html.startsWith("<")) {
      const where = await postToSurface(ev.context, html).catch((e) => {
        console.error("  post error:", e.message);
        return undefined;
      });
      console.log(where ? `  posted reply → ${where}` : "  no surface to post to");
    } else {
      console.log("  agent stayed silent");
    }
    await clearStatus(ev.context);
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/webhook")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');

      let body: unknown;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return;
      }

      for (const ev of parseEvents(body, cfg.agentUserId)) {
        if (ev.fromAgent) continue; // loop guard: skip the agent's own messages
        if (!ev.request) continue; // nothing to respond to (lifecycle/empty events)
        console.log(`[${ev.event || "event"}] conv ${ev.convId}: ${htmlToText(ev.request).slice(0, 100)}`);
        try {
          await handleEvent(ev);
        } catch (err) {
          console.error("  handler error:", err);
        }
      }
    });
  });

  // cfg.port may be 0 (auto-pick a free port); resolve with the actual port.
  return new Promise<number>((resolve) =>
    server.listen(cfg.port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : cfg.port;
      console.log(`Listener bound on http://localhost:${actual}/webhook`);
      resolve(actual);
    }),
  );
}
