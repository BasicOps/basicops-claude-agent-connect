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
import { PersistedMap, sessionExists, statePath } from "./state.js";
import { RuleBook, type AttachedProject } from "./rules.js";
import { connectorsForTurn, isSendApproval, resolveClaudeExecutable, type TurnConnectors } from "./connectors.js";

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
  /** Re-read the proactive config each tick, so config edits apply without a restart. */
  getProactive?: () => AgentCapabilities["proactive"];
  /** Standing rules from the Justin AI OS vault, added to every run's system prompt. */
  rules?: RuleBook;
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
  // convId -> Agent SDK session id. Persisted so a restart resumes the same
  // conversation with full memory instead of starting from a blank session.
  const sessions = new PersistedMap<string>(statePath(cfg.configPath, "sessions"));

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
  // Read-only subset: lets a scheduled/auto trigger INSPECT a repo to judge
  // whether it could do a task, without mutating anything unprompted.
  const READ_CODING_TOOLS = ["Read", "Glob", "Grep", "LS"];

  // Standing rules (vault AGENTS.md + BasicOps rules + attached project), re-read
  // every run so all agents follow the current vault without a restart.
  const rules = cfg.rules ?? new RuleBook(caps.vault);
  const withRules = (system: string, projects: AttachedProject[]) => `${system}\n\n${rules.build(projects)}`;

  // System prompt = the Agent doc + standing rules, plus any operator instructions from the config.
  const systemPromptFor = (projects: AttachedProject[]) => {
    const base = withRules(AGENT_SYSTEM_PROMPT, projects);
    return caps.instructions
      ? `${base}\n\n## Your operator's instructions\nFollow these unless they conflict with the rules above:\n${caps.instructions}`
      : base;
  };

  // The operator's claude.ai connectors (Gmail, ...). When configured, every turn
  // runs on the installed `claude` (the SDK's bundled one can't load them), so a
  // conversation's session never switches binaries. Only operator turns get the
  // connectors; everyone else's turn runs with all settings sources off, sealed.
  const claudeExe = caps.claudeAiConnectors?.length ? resolveClaudeExecutable(caps.claudeCodePath) : undefined;
  if (caps.claudeAiConnectors?.length && !claudeExe) console.error("  [connectors] no `claude` binary found; claude.ai connectors disabled");
  // convId -> when the agent last drafted something to send. Persisted, so a
  // restart between "here are the drafts" and the operator's "send" keeps it armed.
  const pendingSend = new PersistedMap<number>(statePath(cfg.configPath, "pending-send"));

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

    // Resume this conversation's session, if its transcript exists for this turn's folder.
    const saved = sessions.get(ev.convId);
    const resume = saved && sessionExists(saved, coder?.workdir ?? process.cwd()) ? saved : undefined;
    if (saved && !resume) console.log(`  [session] ${saved} not found for this folder; starting fresh`);
    else if (allowlisted) console.log(`  [coding] user allowed but no directory mapped for project ${ev.context.projectId ?? "(none)"}`);

    // Allowlisted operators can self-attach projects via the in-process tool.
    const canSelfConfig = allowlisted && !!selfCfg;
    const turnMcpServers = canSelfConfig ? { ...mcpServers, selfconfig: selfCfg } : mcpServers;
    const allowedTools = [
      ...(coder ? [...baseAllowedTools, ...CODING_TOOLS] : baseAllowedTools),
      ...(canSelfConfig ? ["mcp__selfconfig"] : []),
    ];

    const eventPid = ev.context.projectId != null ? String(ev.context.projectId) : undefined;
    const systemPrompt = systemPromptFor(
      eventPid ? [{ id: eventPid, dir: (coder && coder.workdir) || coding?.projects?.[eventPid] }] : [],
    );
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

    // Operator turn with claude.ai connectors. Sending unlocks only when the agent
    // drafted something last turn (within 24h) and this message is an explicit "send".
    let conn: TurnConnectors | undefined;
    if (allowlisted && claudeExe) {
      const drafted = pendingSend.get(ev.convId);
      const approvedSend = !!drafted && Date.now() - drafted < 86_400_000 && isSendApproval(htmlToText(ev.request));
      // Stay armed until the operator approves (or 24h pass); a turn in between doesn't disarm it.
      if (approvedSend || (drafted && Date.now() - drafted >= 86_400_000)) {
        pendingSend.delete(ev.convId);
      }
      conn = connectorsForTurn(caps.claudeAiConnectors!, approvedSend);
      turnSystemPrompt = `${turnSystemPrompt}\n\n${conn.prompt}`;
      console.log(`  [connectors] ${caps.claudeAiConnectors!.join(", ")}${approvedSend ? " (send approved)" : ""}`);
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
        allowedTools: conn ? [...allowedTools, ...conn.allowedTools] : allowedTools,
        disallowedTools: BLOCKED_TOOLS,
        ...(conn ? { hooks: { PreToolUse: [{ hooks: [conn.hook] }] } } : {}),
        systemPrompt: turnSystemPrompt,
        maxTurns: coder ? 60 : 14,
        // Installed `claude`: operator turns load the connectors (which requires
        // leaving settingSources unset); every other turn loads no settings at all.
        ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
        ...(conn ? { env: conn.env } : claudeExe ? { settingSources: [] } : {}),
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
            if (conn?.draftTools.includes(b.name)) {
              pendingSend.set(ev.convId, Date.now());
            }
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

  // ---------------------------------------------------------------------------
  // Proactive mode: a scheduled review that pushes the user to make progress.
  // Unlike the webhook flow (agent RETURNS html, listener posts), the proactive
  // agent POSTS directly — a DM with the priorities + firm comments on slipping
  // tasks. It keeps one rolling session so it can escalate across the day.
  // ---------------------------------------------------------------------------
  const proactiveState = new PersistedMap<string>(statePath(cfg.configPath, "proactive")); // resume id → memory across hourly ticks
  let lastTickKey = ""; // dedupe: run at most once per hour slot
  let tickRunning = false; // never overlap ticks
  const recentTaskEvents = new Map<string, number>(); // collapse duplicate state-change deliveries

  // Resolve who/what to nudge from config, defaulting to the coding settings.
  function proactiveTargets() {
    const p = cfg.getProactive ? cfg.getProactive() : caps.proactive;
    if (!p || !p.enabled) return undefined;
    const coding = cfg.getCoding ? cfg.getCoding() : caps.coding;
    const dmUserId = p.dmUserId ?? coding?.allowUsers?.[0];
    const projectIds = p.projects && p.projects.length ? p.projects : Object.keys(coding?.projects ?? {});
    if (dmUserId == null || projectIds.length === 0) return undefined;
    return {
      dmUserId,
      projectIds,
      startHour: p.startHour ?? 9,
      endHour: p.endHour ?? 18,
      days: p.days && p.days.length ? p.days : [1, 2, 3, 4, 5],
      taskComments: p.taskComments !== false,
      tone: p.tone ?? "firm",
    };
  }

  // Behavior shared by every proactive/auto message: the agent has HANDS, so it
  // should offer to do the work or say exactly what access it's missing.
  const SELF_CAPABILITY_NOTE =
    `You also have HANDS: in coding mode you can act directly in each attached project's local folder on this machine — read/edit files, run shell, git (pull, branch, commit, push), gh, build, and test. ` +
    `For the task you're pushing, quickly judge whether you could do it or make a real first pass:\n` +
    `- If you CAN: say so plainly and OFFER to start ("I can take the first pass — reply \"go\" and I'll start"). Do NOT actually start the work in this run; wait for the go-ahead.\n` +
    `- If you're BLOCKED by missing access — a credential or API key, an MCP connector, a URL/doc, or access to some system — state EXACTLY what you need and how to grant it: add it to this agent's config file at ${cfg.configPath ?? "the agent config"} (mcpServers / instructions), or run the add-capability skill. Be specific ("I need a GITHUB_TOKEN with repo scope as an mcpServers entry", not "I need access").\n`;

  // Run an agent turn that POSTS to BasicOps directly (proactive/auto flows,
  // unlike the webhook flow where the skill returns HTML for us to post). With a
  // `cwd`, it gets READ-ONLY filesystem access there so it can judge feasibility
  // without mutating anything unprompted. Returns the session id for continuity.
  async function runPostingAgent(o: {
    label: string;
    system: string;
    prompt: string;
    resume?: string;
    cwd?: string;
    /** BasicOps projects this run is about (for the standing rules' project section). */
    projects: AttachedProject[];
  }): Promise<string | undefined> {
    const allowedTools = o.cwd ? ["mcp__basicops", ...READ_CODING_TOOLS] : ["mcp__basicops"];
    const response = query({
      prompt: o.prompt,
      options: {
        resume: o.resume && sessionExists(o.resume, o.cwd ?? process.cwd()) ? o.resume : undefined,
        mcpServers,
        plugins: caps.plugins,
        allowedTools,
        disallowedTools: BLOCKED_TOOLS,
        systemPrompt: withRules(o.system, o.projects),
        maxTurns: 40,
        ...(o.cwd ? { cwd: o.cwd, permissionMode: "bypassPermissions" as const } : {}),
        stderr: (d: string) => {
          const line = d.trim();
          if (line) console.error(`  [claude stderr] ${line}`);
        },
      },
    });
    let summary = "";
    let sessionId: string | undefined;
    for await (const m of response) {
      if (m.type === "assistant") {
        for (const b of m.message.content as any[]) {
          if (b.type === "tool_use") console.log(`  [tool] ${b.name}`);
          else if (b.type === "text" && b.text.trim()) summary = b.text.trim();
        }
      } else if (m.type === "result") {
        sessionId = m.session_id;
        if ((m as any).subtype === "success" && typeof (m as any).result === "string") summary = (m as any).result.trim();
        console.log(`  [${o.label}] done (${m.num_turns} turns): ${htmlToText(summary).slice(0, 160)}`);
      }
    }
    return sessionId;
  }

  async function runProactiveTick(t: NonNullable<ReturnType<typeof proactiveTargets>>) {
    const localTime = new Date().toLocaleString();
    const sys =
      `You are a proactive accountability partner running a SCHEDULED review — you were NOT triggered by a user message, so do NOT wait to be asked. Your job is to push the user to make real progress on their active work: firm and direct, a little pressure, but professional and never rude.\n\n` +
      `This is a recurring run (about hourly during work hours) and you KEEP MEMORY across runs. Do this now:\n` +
      `1. For each attached BasicOps project id listed below, gather the OPEN (not Complete/Cancelled) tasks that involve the user (assigned to them or created by them). Use get_project (for the name + url), list_tasks_in_project, and get_task as needed. If a list tool returns nothing, it may be unreliable — try once more or broaden — but never invent tasks.\n` +
      `2. Decide what is actually SLIPPING: overdue, due today/tomorrow, or stalled (no recent activity). Rank hardest-hitting first. Ignore tasks that are on track or already done.\n` +
      `3. DM the user (BasicOps user id ${t.dmUserId}) ONE concise message with the top 3–5 things that must move now — each a clickable task link, why it's urgent, and one concrete next action. Open or reuse the direct chat with create_chat, then post with create_message_in_chat. Tone: ${t.tone} accountability coach ("this is overdue — what's blocking it?").\n` +
      (t.taskComments
        ? `4. On each genuinely slipping task, post a short ${t.tone} nudge with create_message_in_task — one crisp paragraph naming what's late and the single next action. Skip tasks that are on track.\n`
        : `4. Do NOT post comments on individual tasks this run — the DM is the only channel.\n`) +
      `5. Never delete, reassign, or change task fields. Only read and post messages.\n\n` +
      SELF_CAPABILITY_NOTE +
      `\nContinuity: if you already nudged something in an earlier run today, ESCALATE and acknowledge the repeat ("still not moved since this morning") instead of repeating yourself verbatim. If genuinely nothing is slipping, send at most a brief "you're on track" DM and post no task comments.\n\n` +
      `All posted content is BasicOps HTML: use <p>, <b>, <ul>/<li>, and <a href="URL">Task name</a>. Every href MUST be copied verbatim from a url field in a tool result — never guess a URL. When done, output a single plain-text line summarizing what you sent (for the server log only).`;

    const prompt =
      `Run your scheduled proactive review now.\n` +
      `Local time: ${localTime}.\n` +
      `User to nudge: BasicOps user id ${t.dmUserId}.\n` +
      `Attached BasicOps project ids to review: ${t.projectIds.join(", ")}.\n` +
      `Post per-task nudge comments: ${t.taskComments ? "yes" : "no"}.`;

    console.log(`[proactive] tick — projects ${t.projectIds.join(", ")}, nudging user ${t.dmUserId}`);
    const coding = cfg.getCoding ? cfg.getCoding() : caps.coding;
    const projects = t.projectIds.map((id) => ({ id, dir: coding?.projects?.[id] }));
    const sid = await runPostingAgent({ label: "proactive", system: sys, prompt, resume: proactiveState.get("session"), projects });
    if (sid) proactiveState.set("session", sid);
  }

  // A task changed state (no message body). If the operator just COMPLETED a task
  // in an attached project, advance them to the next priority task: post a firm
  // "let's start this" prompt in that next task's discussion, and assess whether
  // the agent could do it itself (and what access it would need).
  async function handleTaskCompletion(ev: Incoming) {
    const t = proactiveTargets();
    if (!t) return; // proactive off → no auto-advance
    const coding = cfg.getCoding ? cfg.getCoding() : caps.coding;
    const allow = !!coding && ev.userId != null && coding.allowUsers.includes(Number(ev.userId));
    if (!allow) return; // only react to the operator's own actions
    const pid = ev.context.projectId != null ? String(ev.context.projectId) : undefined;
    if (!ev.context.taskId || !pid || !t.projectIds.includes(pid)) return; // attached projects only

    const key = `${pid}:${ev.context.taskId}`;
    const now = Date.now();
    if (now - (recentTaskEvents.get(key) ?? 0) < 90_000) return; // collapse duplicate deliveries
    recentTaskEvents.set(key, now);

    const cwd = coding?.projects?.[pid];
    const sys =
      `A task in a BasicOps project the operator is actively working in just CHANGED STATE. ` +
      `FIRST, call get_task on the task id below and check whether it is now COMPLETE/Done. ` +
      `If it is NOT complete (some other edit), reply with the single word SKIP and stop — post nothing.\n\n` +
      `If it IS complete: keep the momentum. Find the NEXT priority OPEN task in the SAME project (highest priority, then soonest due, not blocked) using list_tasks_in_project / get_task. ` +
      `Then post ONE ${t.tone} message in THAT next task's discussion with create_message_in_task: a one-line acknowledgement that the last task is done, then push them to start this one NOW — what it is, why it's next, and the concrete first step. Include the next task's clickable link (href copied verbatim from a tool result url). ` +
      `If there is genuinely no sensible next task, reply SKIP.\n\n` +
      SELF_CAPABILITY_NOTE +
      `\nNever delete, reassign, or change task fields. Do NOT start doing the work yourself in this run — inspect read-only only, to judge feasibility and prompt. All posted content is BasicOps HTML (<p>, <b>, <a href>). End with a one-line plain-text log summary (or SKIP).`;
    const prompt =
      `A task just changed state. Event: ${ev.event || "(unknown)"}. Task id: ${ev.context.taskId}. Project id: ${pid}. ` +
      `Actor (BasicOps user id): ${ev.userId}. If it's now complete, advance them to the next priority task per your instructions.`;

    console.log(`[auto-advance] task ${ev.context.taskId} in project ${pid} changed state — checking for completion`);
    await runPostingAgent({ label: "auto-advance", system: sys, prompt, cwd, projects: [{ id: pid, dir: cwd }] });
  }

  function proactiveTick() {
    if (tickRunning) return;
    const t = proactiveTargets();
    if (!t) return;
    const now = new Date();
    const inWindow = t.days.includes(now.getDay()) && now.getHours() >= t.startHour && now.getHours() <= t.endHour;
    if (!inWindow) return;
    const key = `${now.toDateString()}-${now.getHours()}`;
    if (key === lastTickKey) return; // already ran this hour
    lastTickKey = key;
    tickRunning = true;
    runProactiveTick(t)
      .catch((e) => console.error("  [proactive] error:", e?.message ?? e))
      .finally(() => (tickRunning = false));
  }

  if (proactiveTargets()) {
    const t = proactiveTargets()!;
    console.log(
      `▶ Proactive mode ON — reviewing projects ${t.projectIds.join(", ")} hourly ${t.startHour}:00–${t.endHour}:00, nudging user ${t.dmUserId} (${t.tone})`,
    );
    setInterval(proactiveTick, 60_000).unref?.(); // check each minute; dedupes per hour
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
        // Diagnostic: log EVERY inbound event so we can see what BasicOps forwards
        // (incl. state changes with no message body, e.g. task completions).
        console.log(
          `[incoming] ${ev.event || "event"} conv=${ev.convId} task=${ev.context.taskId ?? "-"} proj=${ev.context.projectId ?? "-"} user=${ev.userId ?? "-"} req=${ev.request ? "y" : "n"}`,
        );
        if (!ev.request) {
          // No message body → a state change. Maybe a task completion to advance from.
          if (ev.context.taskId) {
            try {
              await handleTaskCompletion(ev);
            } catch (err) {
              console.error("  auto-advance error:", err);
            }
          }
          continue;
        }
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
