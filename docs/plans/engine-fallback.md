# Plan: engine fallback for Roy (Claude, then ChatGPT, then Ollama)

Status: on hold (2026-11-01). No code written yet.

## Why

On 2026-11-01 at 08:48 Roy received a channel message, but Claude returned only
"You've hit your weekly limit · resets 9am (America/Los_Angeles)". The reply had no
HTML, so the listener logged "agent stayed silent" and posted nothing. Justin got no
answer and no notice.

## Goal

When Claude can't answer, Roy tries ChatGPT and then Ollama, follows the same rules on
every engine, and says in the reply which engine answered.

## Decisions so far (Justin, 2026-11-01)

- Order: Claude, then ChatGPT, then Ollama.
- Ollama model: use one that is already installed (llama3.2 today).
- Fallbacks adopt the same rules and guardrails as Claude.
- Replies from a fallback get a short footer, for example:
  "Answered with ChatGPT, Claude's limit resets at 9am."

## Design

### 1. Detect a real failure (not intentional silence)

In `handleEvent` ([src/listener.ts](../../src/listener.ts)), the SDK's assistant message
carries `error` when Claude couldn't run. The 08:48 failure had `error: "rate_limit"`,
`apiError: "usage_limit_reached"` and `model: "<synthetic>"`. Fall back on:

- `rate_limit` / `usage_limit_reached` / `billing_error`
- `authentication_failed` (the expired token case, see the claw-deployment memory)
- the `claude` process exiting with an error

Do not fall back when the agent simply returns no HTML on purpose.

### 2. Cooldown

When Claude says "resets 9am", skip Claude until then, so every message doesn't hit
the failure first. Parse the reset time from the message and use 15 minutes for other
errors. Keep it in memory: after a restart Roy tries Claude once and re-learns.

### 3. ChatGPT via Codex

Port `createCodexEngine` from `basicops-agent-connect-openai/src/codex-engine.ts`
(Codex SDK `@openai/codex-sdk`, ChatGPT sign-in). Codex is installed at
`/opt/homebrew/bin/codex` and `~/.codex/auth.json` exists on the Mac.

- Same system prompt as the Claude turn (Agent doc, vault standing rules, workplace
  rules, operator instructions).
- Our PreToolUse hooks (`src/fence.ts`, connector guards, workplace lock, Chrome
  read-only) can't run inside Codex. So, to keep the same guarantees, Codex gets only:
  - the BasicOps MCP with Roy's key, limited by `enabled_tools` to the same read-only
    set `basicopsReadOnlyHook` allows (`BASICOPS_READ` in fence.ts), minus `BLOCKED_TOOLS`
  - web search
  - no shell, files, apps, plugins or browser (same feature switches as Open-Agent)
- Roy's reply is still posted by the listener, as now.
- Separate Codex thread per conversation, persisted next to the Claude sessions.

### 4. Ollama via the Claude harness

Ollama 0.40 speaks the Anthropic Messages API, so run the same `query()` with:

```
ANTHROPIC_BASE_URL=http://localhost:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_API_KEY=""
model: llama3.2
```

All hooks (fence, read-only, workplace lock) still apply, because it's the same
harness. claude.ai connectors probably won't load in this mode; that's acceptable.

**Open problem:** a smoke test (`claude -p "Reply with exactly: ok" --model llama3.2`
with the env above) gave no output in 3 minutes. Likely causes: Claude Code's large
system prompt and tool list are too much for a 3B model, and/or Ollama's default
context window truncates them. Next steps:

1. Retry with a larger context (`OLLAMA_CONTEXT_LENGTH=32768` on the Ollama server).
2. If llama3.2 still fails, either pull a larger tool-capable model (qwen3:14b, about
   9 GB, fits the 24 GB Mac) or run Ollama with a minimal prompt and BasicOps tools only.
   This needs Justin's call.

### 5. Footer and last resort

- Fallback replies append a one-line footer naming the engine and, when known, when
  Claude is back.
- If every engine fails, post a short notice in the thread instead of staying silent
  (for example "I couldn't answer: Claude's weekly limit resets at 9am and the fallbacks
  failed. Please send it again later.").

### 6. Proactive mode

`runPostingAgent` (proactive ticks, auto-advance) also calls Claude. When Claude is in
cooldown, skip the tick rather than fall back: those runs post directly and rely on the
hooks.

## Config

Add an optional block to the agent config (`~/.config/basicops-agent/<slug>.json`),
parsed in [src/config.ts](../../src/config.ts):

```json
"fallback": {
  "engines": ["codex", "ollama"],
  "codexModel": null,
  "ollamaModel": "llama3.2",
  "ollamaUrl": "http://localhost:11434"
}
```

No `fallback` block means today's behaviour, except for the last-resort notice.

## Status of smoke tests (2026-11-01)

- Claude: limit had reset by 09:16 (`claude -p "say ok"` answered).
- Ollama + llama3.2 through the Claude harness: hung, no output in 3 minutes.
- Codex `exec`: interrupted when the session ended, result unknown. Rerun first.

## Files to touch

- `src/listener.ts`: failure detection, engine loop, footer, last-resort notice, cooldown.
- `src/codex.ts` (new): ported Codex engine, read-only BasicOps tool list.
- `src/config.ts`: `fallback` block.
- `package.json`: add `@openai/codex-sdk`.
- `config.example.json` and `README.md`: document the option.
