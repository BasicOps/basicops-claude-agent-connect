#!/usr/bin/env node
/**
 * Gives an agent its own Google sign-in for Google's hosted MCP servers (Gmail,
 * Calendar, ...), separate from the claude.ai connectors on the Claude account.
 *
 * Claude Code's built-in MCP OAuth never asks Google for offline access, so it
 * gets no refresh token and the sign-in dies after an hour. Instead, sign in
 * once here (access_type=offline), and let Claude Code call this script as the
 * server's `headersHelper` to get a fresh access token on every connect.
 *
 *   node google-mcp-token.mjs login <tokenFile> --client-id ID --client-secret SECRET \
 *        [--port 8765] [--expect justin@basicops.com] [--scopes "gmail.readonly gmail.compose"]
 *   node google-mcp-token.mjs headers <tokenFile>     # prints {"Authorization":"Bearer ..."}
 *   node google-mcp-token.mjs status <tokenFile>
 *
 * The OAuth client must be a Web application client in a Google Cloud project with
 * redirect URI http://localhost:<port>/callback. The token file is written mode 600;
 * keep it in ~/.config/basicops-agent, which the agent fence blocks.
 */
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES = "gmail.readonly gmail.compose";

const [cmd, file, ...rest] = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : dflt;
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!cmd || !file) fail("usage: google-mcp-token.mjs login|headers|status <tokenFile> [options]");

const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = (data) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
};

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`Google token request failed (${res.status}): ${body.error ?? ""} ${body.error_description ?? ""}`.trim());
  return body;
}

/** Signed-in address from the ID token (no signature check needed: it came straight from Google over TLS). */
const emailFromIdToken = (idToken) =>
  idToken ? JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString()).email : undefined;

async function login() {
  const clientId = flag("client-id");
  const clientSecret = flag("client-secret") ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) fail("login needs --client-id and --client-secret (or GOOGLE_CLIENT_SECRET)");
  const port = Number(flag("port", "8765"));
  const expect = flag("expect");
  const scopes = ["openid", "email", ...flag("scopes", DEFAULT_SCOPES).split(/\s+/).map((s) => `https://www.googleapis.com/auth/${s}`)];
  const redirectUri = `http://localhost:${port}/callback`;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");

  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(expect ? { login_hint: expect } : {}),
  }).toString();

  const code = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== "/callback") return res.writeHead(404).end();
      const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/plain" }).end(ok ? "Signed in. You can close this tab." : "Sign-in failed. Check the terminal.");
      server.close();
      if (!ok) fail(`Sign-in failed: ${u.searchParams.get("error") ?? "state mismatch"}`);
      resolve(u.searchParams.get("code"));
    }).listen(port, "127.0.0.1");
    console.log(`Opening Google sign-in${expect ? ` (sign in as ${expect})` : ""}. If no browser opens, visit:\n\n${url}\n`);
    execFile("open", [url.toString()], () => {});
  });

  const tok = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  if (!tok.refresh_token) fail("Google returned no refresh token. Remove the app's access at myaccount.google.com/permissions and run login again.");
  const email = emailFromIdToken(tok.id_token);
  if (expect && email?.toLowerCase() !== expect.toLowerCase()) fail(`Signed in as ${email}, expected ${expect}. Nothing saved; run login again.`);
  save({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tok.refresh_token,
    email,
    scope: tok.scope,
    access_token: tok.access_token,
    expires_at: Date.now() + tok.expires_in * 1000,
  });
  console.log(`Saved ${email}'s Google sign-in to ${file}`);
}

async function accessToken() {
  const data = load();
  if (data.access_token && data.expires_at - Date.now() > 5 * 60_000) return data.access_token;
  const tok = await tokenRequest({
    client_id: data.client_id,
    client_secret: data.client_secret,
    refresh_token: data.refresh_token,
    grant_type: "refresh_token",
  });
  save({ ...data, access_token: tok.access_token, expires_at: Date.now() + tok.expires_in * 1000 });
  return tok.access_token;
}

if (cmd === "login") await login();
else if (cmd === "headers") process.stdout.write(JSON.stringify({ Authorization: `Bearer ${await accessToken()}` }));
else if (cmd === "status") {
  await accessToken();
  const { email, scope } = load();
  console.log(`OK: ${email}, scopes: ${scope}`);
} else fail(`unknown command: ${cmd}`);
