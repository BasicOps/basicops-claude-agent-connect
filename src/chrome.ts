/**
 * Read-only browsing in the operator's own Chrome, through the Claude in Chrome
 * extension (the installed `claude` run with --chrome). The agent can open,
 * read and scroll pages with the operator's sign-ins, but never click, type,
 * fill forms, run scripts or upload: it finds things, the operator acts on them.
 *
 * With a deviceId the agent is pinned to that browser (one Chrome profile) and
 * may select no other; without one it uses the operator's current selection.
 * It may never broadcast a connect request. Only on operator-triggered turns.
 */
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

const PREFIX = "mcp__claude-in-chrome__";
const READ_TOOLS = [
  "select_browser", "tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp",
  "navigate", "get_page_text", "read_page", "find", "computer",
].map((t) => PREFIX + t);
// The `computer` tool also clicks and types; only these actions are reads.
const READ_ACTIONS = new Set(["screenshot", "scroll", "scroll_to", "wait", "zoom"]);

export type TurnChrome = { extraArgs: Record<string, null>; allowedTools: string[]; prompt: string; hook: HookCallback };

export function chromeForTurn(deviceId?: string): TurnChrome {
  const deny = (reason: string) => {
    console.log(`  [chrome] denied: ${reason}`);
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } };
  };
  const hook: HookCallback = async (input) => {
    const tool = (input as any).tool_name as string;
    const args = (input as any).tool_input ?? {};
    if (!tool?.startsWith(PREFIX)) return {};
    if (!READ_TOOLS.includes(tool)) return deny(`${tool.slice(PREFIX.length)} isn't allowed: browsing is read-only (open, read, scroll).`);
    if (tool === PREFIX + "select_browser" && (!deviceId || args.deviceId !== deviceId)) {
      return deny(deviceId ? `Only browser ${deviceId} may be used.` : "Use the browser that's already selected.");
    }
    if (tool === PREFIX + "computer" && !READ_ACTIONS.has(String(args.action))) {
      return deny(`computer action "${args.action}" isn't allowed: only ${[...READ_ACTIONS].join(", ")}. Never click, type or post.`);
    }
    return {};
  };
  return {
    extraArgs: { chrome: null },
    allowedTools: READ_TOOLS,
    prompt:
      `## Your operator's Chrome (read-only)\n` +
      `You can browse in your operator's own Chrome, signed in as them (LinkedIn, Reddit and so on), through the Claude in Chrome tools. ` +
      `Load them with ToolSearch ("claude-in-chrome"). ${
        deviceId
          ? `First call select_browser with deviceId "${deviceId}" (your operator's agent profile; never any other browser), then tabs_context_mcp (createIfEmpty true), and work in the tabs you create. `
          : `Use the browser that's already selected: call tabs_context_mcp (createIfEmpty true) and work in the tabs you create. `
      }Never send connect requests. If the browser can't be reached, tell the operator. ` +
      `Browsing is read-only: navigate, get_page_text, read_page, find, and computer only to screenshot or scroll. You can't click, type, comment, like, post or send anything, so draft what the operator should post and let them do it. ` +
      `Close the tabs you opened when you're done. If the browser isn't reachable (Chrome closed or the Mac asleep), say so and carry on without it.`,
    hook,
  };
}
