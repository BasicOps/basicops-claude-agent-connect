/**
 * The operator's claude.ai connectors (Gmail, Google Calendar, ...) for turns
 * the operator triggers. Any other BasicOps user's turn never loads them.
 *
 * claude.ai connectors belong to the Claude account the agent runs as. They
 * load only when (a) the Claude Code binary is new enough (the SDK's bundled
 * one isn't, so we run the installed `claude`), (b) ENABLE_CLAUDEAI_MCP_SERVERS
 * is set, and (c) no --setting-sources flag is passed. Every connector on the
 * account loads, so a PreToolUse hook (which also runs in bypassPermissions
 * coding mode) denies any claude.ai tool outside the configured allowlist.
 *
 * Gmail sending needs an explicit two-step approval enforced by that hook, not
 * just the prompt: the agent drafts and asks; send tools unlock only on the
 * operator's next message, and only if that message is an explicit "send".
 */
import { execFileSync } from "node:child_process";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_AI_PREFIX = "mcp__claude_ai_";

/** "Google Calendar" → "mcp__claude_ai_Google_Calendar" (the connector's tool-name prefix). */
export const connectorPrefix = (name: string) => `${CLAUDE_AI_PREFIX}${name.replace(/[^A-Za-z0-9_-]/g, "_")}`;

type Policy = { blocked: string[]; send: string[]; draft: string[]; rules: string };

/** Per-connector guardrails. Connectors without a policy are allowed as-is. */
const POLICIES: Record<string, Policy> = {
  Gmail: {
    blocked: ["trash_message", "trash_thread", "mark_message_spam", "mark_thread_spam", "delete_label"],
    send: ["send_message", "reply", "forward", "delete_draft"],
    // Drafting or showing drafts arms the send approval for the operator's next message.
    draft: ["create_draft", "update_draft", "list_drafts", "get_draft"],
    rules:
      `Gmail: search and read mail, and create or update drafts, freely. Sending is locked until the operator approves. ` +
      `To send: create one draft per email, then reply with a short list (each recipient, the subject, and the first line) and ask the operator to reply "send". ` +
      `Before asking for "send", re-read the drafts (list_drafts) so you report exactly what will go out, including any edits the operator made in Gmail. ` +
      `Never trash mail, mark it as spam, or delete labels.`,
  },
};
const APPROVED_SEND_RULES =
  `The operator just approved sending the drafts from your previous reply. Send exactly those emails, ` +
  `unchanged: send_message with the same to, subject and body (or reply / forward for a draft that answers an existing thread). ` +
  `Delete each draft once it's sent, then report what went out.`;

/**
 * An explicit go-ahead to send, allowing surrounding text ("ok I fixed Jason's
 * address. Go ahead and send them."). Questions, negations and change requests
 * ("can you send them to...", "don't send yet", "send but change the subject") never count.
 */
export function isSendApproval(text: string): boolean {
  const t = text.replace(/@[\w.-]+/g, "").replace(/\s+/g, " ").trim();
  if (/\?|\b(don'?t|do not|not yet|wait|hold|stop|cancel|instead|change|but|can you|could you|would you)\b/i.test(t)) return false;
  return /^(send|approved?)[\s.!]*$/i.test(t) ||
    /\b(send (it|them|those|these|all|now|the (emails?|drafts?|messages?))|go ahead( and send)?|approved?)\b/i.test(t);
}

/** The installed `claude` binary: config `claudeCodePath`, else the one on PATH. */
export function resolveClaudeExecutable(configured?: string): string | undefined {
  if (configured) return configured;
  try {
    return execFileSync("which", ["claude"], { encoding: "utf8", timeout: 5000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export type TurnConnectors = {
  env: Record<string, string>;
  allowedTools: string[];
  prompt: string;
  /** Tool names that count as "drafted something to send" (arms the approval step). */
  draftTools: string[];
  hook: HookCallback;
};

/** Options for a turn the operator triggered. `approvedSend` unlocks the send tools for this turn only. */
export function connectorsForTurn(allowed: string[], approvedSend: boolean): TurnConnectors {
  const prefixes = allowed.map(connectorPrefix);
  const denied = new Map<string, string>(); // tool name -> reason
  const draftTools: string[] = [];
  const rules: string[] = [];
  for (const name of allowed) {
    const p = POLICIES[name];
    if (!p) continue;
    const pre = connectorPrefix(name);
    for (const t of p.blocked) denied.set(`${pre}__${t}`, `${name} ${t} is never allowed for this agent.`);
    if (!approvedSend) {
      for (const t of p.send)
        denied.set(`${pre}__${t}`, `Sending is locked. Draft the email(s), show the operator the list, and ask them to reply "send".`);
    }
    draftTools.push(...p.draft.map((t) => `${pre}__${t}`));
    rules.push(p.rules);
  }
  if (approvedSend && draftTools.length) rules.push(APPROVED_SEND_RULES);

  const hook: HookCallback = async (input) => {
    const tool = (input as any).tool_name as string | undefined;
    if (!tool?.startsWith(CLAUDE_AI_PREFIX)) return {};
    const reason = denied.get(tool) ??
      (prefixes.some((p) => tool.startsWith(`${p}__`)) ? undefined : `The ${tool.split("__")[1]} connector is not enabled for this agent.`);
    if (!reason) return {};
    console.log(`  [connectors] denied ${tool}`);
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  };

  return {
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "true" } as Record<string, string>,
    allowedTools: prefixes,
    prompt:
      `## Your operator's claude.ai connectors\n` +
      `Because your operator triggered this run, you can use their claude.ai connectors: ${allowed.join(", ")}. ` +
      `They act as the operator's own accounts. Their tools are deferred and connect in the background at the start of every run, so they may not be listed yet: ` +
      `always load them with ToolSearch (for example "select:${prefixes[0]}__list_drafts"), which waits for a connecting server, before calling them. ` +
      `Never tell the operator a connector is down, dropped or disconnected unless ToolSearch in THIS run found none of its tools, or a call to it returned an error; then quote the error. ` +
      `If ToolSearch finds none of its tools, it isn't connected on the Claude account this agent runs as: tell the operator to reconnect it in claude.ai under Settings > Connectors.\n` +
      rules.map((r) => `- ${r}`).join("\n"),
    draftTools,
    hook,
  };
}
