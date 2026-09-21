#!/usr/bin/env node
// Start-up: arguments, the Claude Code binary, and the ACP connection over
// stdio. Stdout carries the protocol, so everything else goes to stderr.

import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { parseArgs, promisify } from "node:util";

import { ndJsonStream } from "@agentclientprotocol/sdk";
import {
  getSessionMessages,
  listSessions,
  type PermissionMode,
  query,
} from "@anthropic-ai/claude-agent-sdk";

import { type Allowed, type ClaudeProxyAgent, createApp } from "./acp-agent.js";
import { claudeExecutable } from "./agent.js";
import { log } from "./log.js";
import { resolveModel } from "./models.js";
import { availableModes, isMode } from "./permissions.js";
import { parseWishes } from "./proxy.js";

const MODES = availableModes().map((m) => m.id);

/** How long agents and proxied servers have to end before this process does. */
const SHUTDOWN_GRACE_MS = 2_000;
const USAGE = `Usage: claude-proxy [--permission-mode MODE] [--model MODEL]

An ACP agent on stdio: an editor starts it and talks to it over stdin and stdout.

  --permission-mode    Mode of new sessions: ${MODES.join(", ")} [default: default]
  --model              Model of every session: an alias or a full id [default: the CLI's own]
  --idle-minutes       Stop an agent left unused this long; 0 keeps it [default: 30]
  --login              Hand this terminal to Claude Code's own sign-in
  --allow-mcp          MCP servers of the editor the CLI may run: names, or "all" [default: none]
  --proxy-mcp          Servers this host carries over itself: "Air" or "Air:tool,tool;other" [default: none]`;

function fail(message: string): never {
  log.error(message);
  process.exit(1);
}

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const { values } = (() => {
  try {
    return parseArgs({
      options: {
        "permission-mode": { type: "string", default: "default" },
        model: { type: "string" },
        "idle-minutes": { type: "string", default: "30" },
        login: { type: "boolean" },
        "allow-mcp": { type: "string", default: "" },
        "proxy-mcp": { type: "string", default: "" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\n\n${USAGE}`);
  }
})();
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
const permissionMode = values["permission-mode"];
if (!isMode(permissionMode)) {
  fail(`Unknown permission mode '${permissionMode}'. Use one of: ${MODES.join(", ")}`);
}
let model: string | undefined;
try {
  model = values.model === undefined ? undefined : resolveModel(values.model);
} catch (e) {
  fail((e as Error).message);
}

const idleMinutes = Number(values["idle-minutes"]);
if (!Number.isFinite(idleMinutes) || idleMinutes < 0) {
  fail(`Invalid --idle-minutes '${values["idle-minutes"]}'`);
}

const allowed = values["allow-mcp"].trim();
const allowMcp: Allowed =
  allowed === "all"
    ? "all"
    : allowed
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);

const proxyMcp = parseWishes(values["proxy-mcp"]);
if (values["proxy-mcp"].trim() === "all") {
  log.warn(
    "--proxy-mcp takes the names of servers, so 'all' is read as a server called all; " +
      "name each server you want carried over, as --proxy-mcp Air",
  );
}

let executable: string;
try {
  executable = claudeExecutable();
  if (values.login) {
    // The client runs the agent this way for terminal sign-in; the CLI takes
    // the terminal from here and this process ends with it.
    const login = spawn(executable, ["auth", "login"], { stdio: "inherit" });
    login.on("exit", (code) => process.exit(code ?? 1));
    login.on("error", (e) => fail(`Could not start the sign-in: ${e.message}`));
    await new Promise(() => {});
  }
  const { stdout } = await promisify(execFile)(executable, ["--version"]);
  log.info(`claude-proxy ${version}: Claude Code ${stdout.trim()} at ${executable}`);
} catch (e) {
  fail(`Claude Code is not usable: ${(e as Error).message}`);
}

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

let host: ClaudeProxyAgent | undefined;
const options = {
  executable,
  permissionMode: permissionMode as PermissionMode,
  model,
  idleMs: idleMinutes * 60_000,
  allowMcp,
  proxyMcp,
  runQuery: query,
  readSession: getSessionMessages,
  listSessions,
  version,
};
const connection = createApp(options, (h) => (host = h)).connect(stream);
const carried = Object.entries(proxyMcp).map(
  ([server, tools]) => `${server}:${tools === "all" ? "all" : tools.join(",")}`,
);
log.info(
  `Serving ACP on stdio (mode ${permissionMode}, model ${model ?? "the CLI's default"}, ` +
    `MCP of the editor: ${allowMcp === "all" ? "all" : allowMcp.length === 0 ? "none" : allowMcp.join(", ")}, ` +
    `carried over: ${carried.length === 0 ? "none" : carried.join(" ")})`,
);

const shutdown = (reason: string) => {
  log.info(`${reason}, stopping`);
  if (!host) {
    process.exit(0);
  }
  // Agents and proxied servers are processes of their own; they get a moment
  // to end before this one does, and no longer than that.
  void host.closeAll().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
};
void connection.closed.then(() => shutdown("The editor closed the connection"));
process.once("SIGINT", () => shutdown("Received SIGINT"));
process.once("SIGTERM", () => shutdown("Received SIGTERM"));
