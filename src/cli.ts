#!/usr/bin/env node
/**
 * basicops-connect — connect a BasicOps agent in one command.
 *
 *   basicops-connect --api-key <key> [--agent claude] [--port 3000] [--project <id>]
 *
 * Steps: verify the key → bind the listener → open a Tailscale Funnel →
 * register the agent webhook → create a confirmation task → stay live.
 */
import * as readline from "node:readline";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { BasicOpsClient } from "./basicops.js";
import {
  startFunnel,
  funnelHelp,
  tailscaleStatus,
  tailscaleUp,
  funnelAvailable,
  setTailscaleOperator,
  isOperatorError,
} from "./funnel.js";
import { startListener } from "./listener.js";
import { loadCapabilities, configPath } from "./config.js";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

const c = {
  step: (s: string) => console.log(`\n\x1b[36m▶ ${s}\x1b[0m`),
  ok: (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`),
  info: (s: string) => console.log(`  ${s}`),
};

function fail(msg: string): never {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

/** Prominent end-of-install banner: agent is live, go check your DMs. */
function announceConnected(displayName: string, dmTarget?: string, future = false) {
  console.log(`\n\x1b[1m\x1b[32m🎉 ${displayName} is connected and live!\x1b[0m`);
  if (dmTarget) {
    console.log(`\n  \x1b[36m📬 Open BasicOps and go to your Direct Messages.\x1b[0m`);
    console.log(`     ${displayName} ${future ? "will send" : "just sent"} you a message — look for a DM from "${displayName}".`);
    console.log(`     Reply there, or @-mention ${displayName} in any task, chat, or channel.`);
  }
}

function promptText(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, (a) => resolve(a.trim())));
}

// One-shot prompt: opens and closes its own readline, so nothing holds stdin
// open across a spawned child (e.g. `tailscale up`) that also reads the TTY.
function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(query, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

// Strip bracketed-paste markers + control chars some terminals inject on paste.
function sanitizeSecret(value: string): string {
  return value
    .replace(/\x1b\[2(?:00|01)~/g, "") // bracketed-paste begin/end markers
    .replace(/[\x00-\x1f\x7f]/g, "") // any remaining control chars
    .trim();
}

// Like promptText but hides typed input (for secrets).
function promptHidden(rl: readline.Interface, query: string): Promise<string> {
  return new Promise((resolve) => {
    const rlAny = rl as any;
    rl.question(query, (value) => {
      rlAny._writeToOutput = (s: string) => rlAny.output.write(s); // restore echo
      rlAny.output.write("\n");
      resolve(sanitizeSecret(value));
    });
    rlAny._writeToOutput = () => {}; // hide keystrokes
  });
}

/** Interactive installer: prompt for just the BasicOps key (the agent is auto-detected from it). */
async function runInstaller(have: { apiKey?: string }): Promise<{ apiKey: string }> {
  console.log("\n\x1b[36m▶ basicops-connect installer\x1b[0m");
  console.log("  Paste your BasicOps agent API key (hidden). The agent is detected automatically.\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const apiKey = have.apiKey || (await promptHidden(rl, "  BasicOps agent API key: "));
    if (!apiKey) fail("BasicOps API key is required.");
    return { apiKey };
  } finally {
    rl.close();
  }
}

/**
 * True only if Claude can ACTUALLY authenticate — a real `claude -p` call.
 * (`claude auth status` returns loggedIn:true even for expired tokens, which is
 * what silently broke the agent, so we don't trust it.)
 */
function claudeWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("claude", ["-p", "ok"], { timeout: 60000 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`;
      if (/invalid authentication|failed to authenticate|401|unauthor/i.test(out)) return resolve(false);
      resolve(!err);
    });
  });
}

/** Run a `claude auth <sub>` command, ignoring its result (used for logout). */
function claudeAuth(sub: string): Promise<void> {
  return new Promise((resolve) => execFile("claude", ["auth", sub], () => resolve()));
}

/** Run the Claude OAuth login flow interactively (inherits the terminal). */
function claudeLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["auth", "login"], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`claude auth login exited with code ${code}`))));
  });
}

/**
 * Ensure Claude can actually authenticate. Validates with a real call; if it
 * fails (missing OR expired token), clears any stale token and runs the OAuth
 * login flow, then re-validates so the agent is guaranteed able to reply.
 */
async function ensureClaudeLogin(): Promise<void> {
  c.step("Checking Claude login");
  if (await claudeWorks()) {
    c.ok("Claude login works");
    return;
  }
  c.info("No working Claude login (missing or expired) — signing in.");
  await claudeAuth("logout"); // clear any stale token first
  c.step("Logging in to Claude (OAuth) — open the URL it shows and approve");
  await claudeLogin().catch((e) =>
    fail(`Claude login failed: ${e.message}\n  Run \`claude auth login\` manually, then retry.`),
  );
  if (!(await claudeWorks())) {
    fail('Claude login still not working. Run `claude auth login`, verify with `claude -p "say ok"`, then retry.');
  }
  c.ok("Claude login works");
}

/**
 * Interactive Tailscale readiness check, run BEFORE we hand off to a background
 * service (once installed, the funnel opens non-interactively, so this is our
 * only chance to guide the user). Ensures: (1) they're connected to Tailscale —
 * walking a brand-new user through creating an account + `tailscale up`; and
 * (2) Funnel is enabled on their tailnet — the one-time admin step new users
 * miss. Returns false only if the user chooses to skip Tailscale (they must then
 * provide --webhook-url).
 */
async function tailscalePreflight(): Promise<boolean> {
  c.step("Checking Tailscale (used to expose the agent's webhook)");

  // 1. Connected? (Backend "Running" = logged in.)
  let state = await tailscaleStatus();
  if (!state.installed) {
    fail("Tailscale isn't installed. Install it (https://tailscale.com/download), or pass --webhook-url to skip it.");
  }
  if (state.backendState !== "Running") {
    const have = (await ask("  Do you already have a Tailscale account? [Y/n] ")).toLowerCase();
    if (have === "n" || have === "no") {
      c.info("No problem — it's free. When the browser opens next, choose “Sign up”.");
      c.info("  (Or sign up first at https://login.tailscale.com/start)");
      await ask("  Press Enter when you're ready to connect this machine… ");
    }
    c.step("Connecting this machine to Tailscale — open the URL it prints and approve");
    await tailscaleUp().catch((e) =>
      fail(`Couldn't connect Tailscale: ${e.message}\n  Run \`sudo tailscale up\` manually, then retry.`),
    );
    state = await tailscaleStatus();
    if (state.backendState !== "Running") {
      fail("Tailscale still isn't connected. Run `sudo tailscale up`, then retry.");
    }
  }
  c.ok(`Tailscale connected${state.dns ? ` (${state.dns})` : ""}`);

  // 2. Funnel usable? Loop until it is, or the user skips. First auto-fix the
  //    common "operator not set" permission error (root owns the tailnet after
  //    `sudo tailscale up`, so the agent's user can't manage Funnel).
  let triedOperator = false;
  for (;;) {
    const probe = await funnelAvailable();
    if (probe.ok) {
      c.ok("Funnel is ready");
      return true;
    }
    if (!triedOperator && isOperatorError(probe.error ?? "")) {
      triedOperator = true;
      c.step("Granting your user permission to manage Funnel (sudo may prompt for your password)");
      await setTailscaleOperator().catch((e) => c.info(`Couldn't set operator automatically: ${e.message}`));
      continue; // re-probe
    }
    console.log("\n" + funnelHelp(probe.error ?? ""));
    const ans = (
      await ask("\n  Press Enter to re-check after enabling Funnel, or type 's' to skip Tailscale: ")
    ).toLowerCase();
    if (ans === "s" || ans === "skip") {
      c.info("Skipping Tailscale. Re-run with --webhook-url <your-own-public-https-url>.");
      return false;
    }
  }
}

/**
 * Offer to install a persistent systemd service (Linux only). Returns true if a
 * service was installed and started — in which case the caller should NOT also
 * run the agent in the foreground.
 */
async function offerServiceInstall(apiKey: string, agent: string, dmTarget?: string): Promise<boolean> {
  if (process.platform !== "linux") return false; // systemd only

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (
    await promptText(rl, "\n  Run as a background service (survives logout/reboot)? [Y/n] ")
  ).toLowerCase();
  rl.close();
  if (ans === "n" || ans === "no") return false;

  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "install-service.sh");
  c.step("Installing systemd service (sudo may prompt for your password)");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [script], {
      stdio: "inherit",
      env: { ...process.env, BASICOPS_API_KEY: apiKey, BASICOPS_AGENT: agent, BASICOPS_DM: dmTarget ?? "" },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`service install exited with code ${code}`)),
    );
  }).catch((e) => fail(`Service install failed: ${e.message}`));
  return true;
}

/** Resolve a BasicOps user by email (searching pages) or a numeric id. */
async function resolveUserId(client: BasicOpsClient, target: string): Promise<number | undefined> {
  const t = target.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const email = t.toLowerCase();
  let nextPage: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await client.call<any>("list_users", nextPage ? { nextPage } : {});
    const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    const match = list.find((u: any) => String(u.email ?? "").toLowerCase() === email);
    if (match?.id) return Number(match.id);
    nextPage = res?.nextPage;
    if (!nextPage) break;
  }
  return undefined;
}

function printHelp() {
  console.log(`basicops-connect — connect a BasicOps agent in one command

Usage:
  basicops-connect --api-key <key> [options]

Options:
  --api-key <key>    Agent bearer token (or set BASICOPS_API_KEY). The agent is
                     detected automatically from the key.
  --mcp-url <url>    Override the full MCP endpoint URL
  --port <n>         Local listener port (default: auto-pick a free port)
  --funnel-path <p>  Path on the shared :443 Funnel (default: /<detected-agent>).
                     Each concurrent agent gets its own path.
  --dm <email|id>    BasicOps user to DM when the agent connects (or set
                     BASICOPS_DM). Interactive install asks for this.
  --webhook-url <u>  Public webhook URL; skips Tailscale Funnel if provided
  --help             Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();

  let apiKey = (args["api-key"] as string) ?? process.env.BASICOPS_API_KEY;

  // Interactive installer: when the key is missing and we're on a terminal,
  // prompt for it and ensure a Claude login. (Flags/env still work headless.)
  const interactive = !apiKey && process.stdin.isTTY;
  if (interactive) {
    const cfg = await runInstaller({ apiKey });
    apiKey = cfg.apiKey;
    await ensureClaudeLogin(); // step 3: Claude OAuth login flow
  }
  if (!apiKey) fail("Missing --api-key (or BASICOPS_API_KEY env). See --help.");

  const port = Number(args.port ?? process.env.PORT ?? 0); // 0 = auto-pick a free port
  // The key alone identifies the agent; the ?agent= URL param is ignored.
  const mcpUrl = (args["mcp-url"] as string) ?? "https://app.basicops.com/mcp";
  const explicitWebhook = args["webhook-url"] as string | undefined;
  // Who to DM when the agent connects (the person running the install). Email or
  // numeric user id; persisted into the service env so restarts reuse it.
  let dmTarget = (args.dm as string) ?? process.env.BASICOPS_DM;

  const client = new BasicOpsClient(mcpUrl, apiKey);

  // 1. Verify the key and DISCOVER the agent (no name needed — the key is the agent).
  c.step("Verifying key & detecting agent");
  const user = await client.call<{ id?: number; firstName?: string }>("get_current_user").catch((e) =>
    fail(`Could not authenticate to ${mcpUrl}\n  ${e.message}`),
  );
  const config = await client.call<{ agentId?: string; enabled?: boolean; ["Display name"]?: string }>(
    "get_agent_configuration",
  );
  if (!user?.id) fail("Authenticated, but no user id returned — is this an agent connector key?");
  const agent = config?.agentId;
  if (!agent) fail("Could not determine the agent from this key.");
  if (!config?.enabled)
    fail(`Agent "${config["Display name"] ?? agent}" exists but is not enabled in BasicOps. Enable it and retry.`);
  const agentUserId = String(user.id);
  const displayName = config["Display name"] ?? agent;
  c.ok(`Detected agent "${displayName}" (agentId ${agent}, id ${agentUserId}, enabled)`);

  // Ask who the agent should DM when it connects (the person installing it).
  if (interactive && !dmTarget) {
    dmTarget = await ask(`  Your BasicOps email (so ${displayName} can DM you when it's live): `);
  }

  // Funnel path defaults to the detected agent id (override with --funnel-path).
  const rawPath = (args["funnel-path"] as string) ?? `/${agent}`;
  const funnelPath = "/" + rawPath.replace(/^\/+/, "").replace(/\/+$/, "");

  // Tailscale readiness (interactive only, and only when using the Funnel):
  // guide the user through account + `tailscale up` + enabling Funnel, BEFORE a
  // possible service hand-off (where the funnel would open non-interactively).
  if (interactive && !explicitWebhook) {
    const ready = await tailscalePreflight();
    if (!ready) {
      fail("Tailscale skipped. Re-run with --webhook-url <your-own-public-https-url> to use your own endpoint.");
    }
  }

  // Offer the persistent service (interactive only), now that we know the agent.
  if (interactive && (await offerServiceInstall(apiKey, agent, dmTarget))) {
    c.ok("Agent installed as a service and started. It will keep running and survive reboots.");
    c.info(`Logs: journalctl -u basicops-agent-${agent} -f`);
    // The service runs the connect sequence (incl. the DM) a moment from now.
    announceConnected(displayName, dmTarget, /* future */ true);
    return;
  }

  // Load capabilities: bundled default skills (always) + optional config file
  // (extra MCP connectors + skill plugins the operator added).
  const capabilities = loadCapabilities(agent);
  const nServers = Object.keys(capabilities.mcpServers).length;
  c.step("Loading capabilities");
  const pluginNames = capabilities.plugins.map((p) => basename(p.path));
  c.ok(`Skill plugins: ${pluginNames.length ? pluginNames.join(", ") : "(none)"}`);
  if (nServers) c.ok(`Extra MCP connectors: ${Object.keys(capabilities.mcpServers).join(", ")}`);
  if (capabilities.instructions) c.ok(`Custom instructions: ${capabilities.instructions.length} chars`);
  c.info(`Add more (skills / MCP / instructions) at ${configPath(agent)}`);

  // 2. Bind the listener first (so the Funnel has something to proxy to).
  c.step("Starting listener");
  const boundPort = await startListener({
    mcpUrl,
    apiKey,
    agentUserId,
    port,
    capabilities,
    configPath: configPath(agent),
    getCoding: () => loadCapabilities(agent).coding, // re-read so attach_project hot-applies
  });
  c.ok(`Listener is up on port ${boundPort}`);

  // 3. Public URL — Tailscale Funnel at this agent's path (unless one was provided).
  let webhookUrl: string;
  let stopFunnel: (() => Promise<void>) | undefined;
  if (explicitWebhook) {
    webhookUrl = explicitWebhook.replace(/\/$/, "") + "/webhook";
    c.step("Using provided webhook URL");
    c.ok(webhookUrl);
  } else {
    c.step(`Opening Tailscale Funnel at ${funnelPath}`);
    const funnel = await startFunnel(boundPort, funnelPath).catch((e) => fail(e.message));
    stopFunnel = funnel.stop;
    webhookUrl = `${funnel.url}/webhook`;
    c.ok(`Public URL: ${funnel.url}`);
  }

  // 4. Register the agent webhook.
  c.step("Registering agent webhook");
  const reg = await client.call<{ webhookId?: string }>("connect_agent", {
    kind: "basicops-agent-connect",
    webhook: webhookUrl,
  });
  c.ok(`Webhook registered${reg?.webhookId ? ` (${reg.webhookId})` : ""} → ${webhookUrl}`);

  // 5. DM the person who installed the agent, confirming it's live.
  c.step("Sending connect DM");
  let dmSent = false;
  if (!dmTarget) {
    c.info("⚠ No DM recipient — skipping. Pass --dm <email|id> (or set BASICOPS_DM) to enable.");
  } else {
    const userId = await resolveUserId(client, dmTarget).catch(() => undefined);
    if (!userId) {
      c.info(`⚠ No BasicOps user found for "${dmTarget}" — skipping connect DM (check the email is a workspace member).`);
    } else {
      const chat = await client.call<any>("create_chat", { userId }).catch((e: any) => ({ __err: e.message }));
      const chatId = chat?.id ?? chat?.chatId;
      if (!chatId) {
        c.info(`⚠ Couldn't open a direct chat with user ${userId} — skipping DM${chat?.__err ? ` (${chat.__err})` : ""}.`);
      } else {
        await client.call("create_message_in_chat", {
          chatId,
          message:
            `<p>👋 <strong>${displayName}</strong> is connected and live.</p>` +
            `<p>Message me here, or @-mention me in any task, chat, or channel, and I'll help.</p>`,
        });
        c.ok(`DM sent to ${dmTarget} (user ${userId})`);
        dmSent = true;
      }
    }
  }

  // 6. Announce, then stay live.
  announceConnected(displayName, dmSent ? dmTarget : undefined, /* future */ false);
  c.step("Agent is live — send it a message in BasicOps (Ctrl-C to stop)");
  const shutdown = async () => {
    console.log("\nShutting down…");
    if (stopFunnel) await stopFunnel();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => fail(err?.stack ?? String(err)));
