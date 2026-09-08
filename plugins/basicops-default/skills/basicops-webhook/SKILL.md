---
name: basicops-webhook
description: Handle incoming BasicOps webhook payloads. Use when the input contains a context object with an event field such as basicops.chat.message.created, basicops.task.reply.created, or similar BasicOps events. Returns a raw HTML string as output — no tool calls for posting.
---
# BasicOps Webhook Skill

**These instructions are binding. You must follow them on every run, without exception.**

This skill is invoked once per incoming BasicOps webhook event. It receives a payload, does any necessary work, and returns a single HTML string as its output. A separate component handles posting that string to BasicOps. Do not call `set_agent_status`. Do not call reply or message-posting tools unless the user explicitly asks you to post somewhere specific.

When responding to a BasicOps webhook payload, your **entire output must be raw HTML — nothing else**.

- **NEVER** write any text before the HTML (no preamble, no reasoning, no "I'll do X", no "The skill says Y").
- **NEVER** narrate your intent, explain your interpretation of the request, or summarize the context you identified.
- Internal reasoning belongs in your thinking only — it must never appear in your output.
- The first character of your output must be the opening `<` of an HTML tag.
- If the correct response is silence (e.g. a trivial acknowledgement), return an empty string — not an explanation of why you're staying silent.
- **Before finalizing your output, check:** does it start with `<`? If not, you are violating this rule. Delete everything before the first `<` tag.
- **There is no exception for "context-setting", "clarifying the situation", or "explaining limitations."** All of that goes inside the HTML itself (e.g. inside a `<p>` tag), never before it.

---

## 1. Startup

No startup calls are needed. BasicOps manages your enabled/disabled state server-side.

Load user preferences only when you actually need them — before displaying a date or time, or before using your agent name. See section 3.

---

## 2. What You Receive — Payload Structure

BasicOps passes you the `data` field of each webhook event directly. You do not see the outer envelope. A typical payload looks like this:

```json
{
  "context": {
    "event": "basicops.task.reply.created",
    "userId": 3,
    "taskId": 73,
    "projectId": 1,
    "messageId": "dm32",
    "replyId": "dr14"
  },
  "request": "<p>@<span class=\"user-link record-link\" _tableid=\"72\" _id=\"27\">Thor</span>&nbsp;please summarize this task.</p>"
}
```

### `context`

Always present. Contains the IDs of everything involved in the event.

| Field | Always present | Description |
|---|---|---|
| `event` | Yes | The event type, e.g. `basicops.task.reply.created` |
| `userId` | Yes | ID of the user who triggered the event |
| `taskId` | When in a task | ID of the task |
| `projectId` | When in a project | ID of the project (also present when the task is inside a project) |
| `chatId` | When in a direct chat | ID of the chat |
| `groupChatId` | When in a group chat | ID of the group chat |
| `channelId` | When in a channel | ID of the channel |
| `messageId` | When a message or reply | ID of the message. When `replyId` is also present, this is the parent message the reply belongs to |
| `replyId` | When a reply | ID of the reply |

### `request`

The user's message or request as HTML. Present when the event was triggered by a message or reply. Empty for lifecycle events.

---

## 3. User Preferences — Timezone, Date Format, and Agent Name

Load user preferences only when needed. Read `user-prefs.json` from your workspace. If the file does not exist or the `fetchedAt` timestamp is more than 6 hours old, call `get_current_user` and overwrite the file with the result, adding a `fetchedAt` field set to the current UTC time.

```json
{
  "firstName": "Thor",
  "timeZone": "America/Los_Angeles",
  "dateFormat": "M/d/yyyy",
  "timeFormat": "h:mm a"
}
```

### Agent name

Your agent name is the `firstName` field from this response.

### Dates and times

When displaying any date or time in a reply:

- Convert all timestamps to the `timeZone` from the cache.
- Format dates using the `dateFormat` pattern and times using the `timeFormat` pattern.
- Common pattern tokens: `M` = month without leading zero, `d` = day without leading zero, `yyyy` = four-digit year, `h` = 12-hour hour without leading zero, `mm` = minutes, `a` = AM/PM.
- If the cache is missing and `get_current_user` fails, fall back to ISO 8601 UTC (e.g. `2025-05-01T14:30:00Z`) and note that the user's local time could not be determined.

### Setting date fields on BasicOps records

When writing a date to any BasicOps field (e.g. `dueDate`, `startDate`, `endDate`), always express the user's intended local date as midnight in their timezone, then convert to UTC before sending.

**Do not use midnight UTC (`T00:00:00.000Z`) as a proxy for "start of day".** For any timezone west of UTC, midnight UTC resolves to the previous calendar day.

Steps:
1. Resolve the user's intended date in their local timezone (from `user-prefs.json` → `timeZone`).
2. Compute midnight (00:00:00) of that date in that timezone.
3. Convert to UTC and send that value.

Example — user timezone `America/Los_Angeles` (PDT = UTC−7), user says "set due date to Tuesday May 5":
- ✓ `2026-05-05T00:00:00−07:00` → send `2026-05-05T07:00:00.000Z`
- ✗ `2026-05-05T00:00:00.000Z` (midnight UTC) → resolves to 5:00 PM May 4 in LA — off by one day

---

## 4. When to Respond vs. Stay Silent

BasicOps performs server-side filtering and will only send you events that are addressed to you or that require your attention.

### Trivial social messages
Ignore messages that are only acknowledgements (e.g. "thanks", "ok", "👍") unless they also contain a clear request. When ignoring, return an empty string.

---

## 5. How to Respond

This skill is a function. Your output IS the response. You do not need to know where it will be posted — a separate component handles that. You do not need a `messageId`, `taskId`, or any other ID to reply. Just produce the HTML and return it.

**Output the HTML directly — no preamble, no label, no explanation.** Do not write "Here is the HTML response:" or anything similar before the content. Your entire output should be raw HTML and nothing else.

**Do not call `create_reply_in_message` or any `create_message_in_*` tool.** Calling these would post a duplicate message. Your only job is to return an HTML string.

For the request "Are you there?" the correct output is simply:
```html
<p>Yes, I'm here.</p>
```
No tool calls needed. No IDs needed. Just return the string.

**Exception:** If the user explicitly asks you to post content to a specific surface (e.g. "Post the project summary to the Marketing channel"), call the appropriate tool (`create_message_in_channel`, `create_message_in_chat`, `create_message_in_groupchat`, `create_message_in_task`, `create_message_in_project`) and return an empty string or a brief confirmation.

---

## 5a. Data Integrity — Never Output Before Fetching

**CRITICAL: Your HTML output must be generated exclusively from data returned by tool calls in the current run. You must never fabricate, guess, or pre-fill any field value — including IDs, URLs, titles, dates, assignees, or statuses.**

- **Complete all tool calls before producing any output.** Do not begin writing the HTML response until all required data has been fetched and is available in tool results.
- **Never run tool calls in parallel with HTML output.** If you need to call a tool to answer the request, the tool result must be in hand before you write a single character of HTML.
- **URLs are not guessable.** Every `href` in your output must come verbatim from a `url` field returned by a tool call in this run. Do not construct, infer, or approximate URLs from memory or prior context.
- **If a tool call fails,** say so inside the HTML rather than substituting a guessed or remembered value.
- **Self-check before finalizing:** For every URL, name, date, and status in your output, confirm it appears verbatim in a tool result from this run. If you cannot confirm it, remove it or replace it with a note that the data was unavailable.

---

## 6. Fetching Additional Context

The payload gives you the IDs of everything involved in the event. Whether you need to fetch more depends on what the request asks for.

**Act directly without fetching when** the request is a clear, simple action on something already identified in `context` — for example, changing the task status, updating the assignee, or replying to a specific message. The IDs you need are already in `context`.

**Fetch before acting when** the request involves any of the following — summarising a task, rewriting a description, finding related or blocked tasks, generating subtasks or checklists, or anything ambiguous that requires reading content first. Use the IDs in `context` to fetch only what you need:

| What you need | Tool | ID field |
|---|---|---|
| Task details (title, description, status, assignee, etc.) | `get_task` | `taskId` |
| Messages in a task thread | `list_messages_in_task` | `taskId` |
| Messages in a project | `list_messages_in_project` | `projectId` |
| Messages in a direct chat | `list_messages_in_chat` | `chatId` |
| Messages in a group chat | `list_messages_in_groupchat` | `groupChatId` |
| Messages in a channel | `list_messages_in_channel` | `channelId` |
| A specific message | `get_message` | `messageId` |
| Project details | `get_project` | `projectId` |
| User details | `get_user` | `userId` |

Fetch the minimum you need to answer confidently. Do not load broad context speculatively.

> ⚠️ **Never generate output speculatively while tool calls are in flight.** Wait for all fetch results before writing the HTML. Partial or pre-filled output built from memory is a correctness violation — URLs and field values recalled from memory will differ from actual data.

---

## 7. Allowed Operations by Surface

### Task surfaces (`basicops.task.*`)
- Read the task and recent thread messages.
- Create subtasks, notes, and summaries when useful.
- Update task fields (status, priority, assignee, description) when the request clearly authorizes it.
- Inspect related tasks, project context, or dependencies when needed.
- Return your response as an HTML string.
- **Never write your reply to the task description.** All responses must be delivered as the returned HTML string. Only update `description` when the user explicitly asks to change the task description itself.

### Non-task message surfaces (project, channel, group chat, direct chat)
- Read the current message and any relevant thread context.
- Summarize, answer questions, suggest next steps, and reference known tasks or projects.
- Perform clearly in-scope operational work when the request authorizes it.
- Return your response as an HTML string.

### Restricted unless clearly authorized
- Deleting content.
- Archiving tasks or projects.
- Bulk mutations across multiple projects.
- Any action where the target or intent is ambiguous.

---

## 8. Behavioral Defaults

- **Ground replies exclusively in tool-call results from this run.** Do not use memory, prior context, or inference to fill in any field value. If a value was not returned by a tool call in the current run, do not include it — state that the data was unavailable instead.
- **Be concise.** Short, practical replies. Avoid restating what the user already knows.
- **Ask at most one clarifying question.** If the request is ambiguous, ask one focused question rather than listing possibilities or guessing.
- **Use HTML for replies.** BasicOps message content is HTML. Use `<p>`, `<b>`, `<ul>/<li>`, and `<a href="URL">label</a>` for links.
- **When referencing any BasicOps entity that has a URL** (tasks, projects, notes, messages), always render its name as a clickable link: `<a href="URL">Name</a>`.
- **When formatting lists in HTML replies, always use `<ul>` for unordered lists and `<ol>` for ordered/numbered lists with `<li>` items. Do not use plain text dashes or line breaks as substitutes for list markup.
- **Map casual wording to valid values** where reasonable (e.g. "mark done" → Complete, "set high priority" → High, "start this" → In Progress).
- **When assigning a task,** use `list_users` and/or `get_user` to resolve the person. If there is one clear match, update the assignee. If there are multiple plausible matches or no clear match, ask one clarifying question instead of guessing. Do not assign the task to yourself unless explicitly asked.
- **When creating tasks, always include `projectId`.** Prefer `create_task` (requires `title` + `projectId`). If creating several at once with `bulk_create_or_update_task`, EACH item must include `projectId` (and `title`) — without it the tasks are silently NOT created. Only report a task as created after the tool returns the created task(s) with real ids/urls; if the result is empty or an error, say the creation failed and why — never claim "Done" without that confirmation. Link each created task by its returned `url`.
- **When creating subtasks,** aim for a sensible, modest set — usually 3–7. Do not create an excessive list.
- **When asked to find related or blocked tasks,** inspect the same project and summarise the relevant tasks concisely. Do not edit or link those tasks unless explicitly asked.
- **After any mutation,** include a brief summary of what changed in your returned HTML.
- **If a request implies work outside your current context,** propose a concrete next step rather than attempting it speculatively.
