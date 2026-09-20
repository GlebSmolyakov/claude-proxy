#!/usr/bin/env node
// Start-up: arguments, the state folder, the Claude Code binary, the server,
// and a clean stop.

import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { claudeExecutable, PERMISSION_MODES, runAgent } from "./agent.js";
import { log } from "./log.js";
import { createServer } from "./server.js";
import { SessionStore, transcriptsDirFor } from "./session.js";
import { RuntimeStatus } from "./status.js";

const USAGE = `Usage: claude-proxy [PORT] [--cwd DIR] [--permission-mode MODE]

  PORT                 Port on 127.0.0.1 [default: 8080]
  --cwd DIR            Working directory of the agent [default: ~/.claude-proxy/workdir]
  --permission-mode    ${PERMISSION_MODES.join(", ")} [default: default]`;

function fail(message: string): never {
  log.error(message);
  process.exit(1);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        cwd: { type: "string" },
        "permission-mode": { type: "string", default: "default" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    fail(`${(e as Error).message}\n\n${USAGE}`);
  }
})();
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const port = Number(positionals[0] ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535 || positionals.length > 1) {
  fail(`Invalid arguments: ${positionals.join(" ")}\n\n${USAGE}`);
}
const permissionMode = values["permission-mode"] as PermissionMode;
if (!PERMISSION_MODES.includes(permissionMode)) {
  fail(`Unknown permission mode '${permissionMode}'. Use one of: ${PERMISSION_MODES.join(", ")}`);
}

// State lives in ~/.claude-proxy: the session map, and by default the
// working directory whose CLI sessions the proxy owns.
const stateDir = join(homedir(), ".claude-proxy");
let cwd = values.cwd ?? join(stateDir, "workdir");
try {
  await mkdir(stateDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  cwd = await realpath(cwd);
} catch (e) {
  fail(`Cannot create ${cwd}: ${(e as Error).message}`);
}

let executable: string;
let cliVersion: string;
try {
  executable = claudeExecutable();
  const { stdout } = await promisify(execFile)(executable, ["--version"]);
  cliVersion = stdout.trim();
  log.info(`Found Claude Code ${cliVersion} at ${executable}`);
} catch (e) {
  fail(`Claude Code is not usable: ${(e as Error).message}`);
}

const sessions = await SessionStore.open(join(stateDir, "sessions.json"), transcriptsDirFor(cwd));
sessions.startCleanup();

const server = createServer({
  cwd,
  sessions,
  status: new RuntimeStatus(cliVersion),
  permissionMode,
  executable,
  runAgent,
});

server.on("error", (e: NodeJS.ErrnoException) => {
  fail(e.code === "EADDRINUSE" ? `Port ${port} is already in use` : `Server error: ${e.message}`);
});
server.listen(port, "127.0.0.1", () => {
  log.info(
    `claude-proxy listening on http://127.0.0.1:${port} (cwd: ${cwd}, permissions: ${permissionMode})`,
  );
  log.info(
    "endpoints: GET /health, /v1/models | POST /v1/chat/completions (OpenAI), /v1/messages (Anthropic)",
  );
});

// Graceful shutdown: stop accepting, let running turns finish.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log.info(`Received ${signal}, shutting down...`);
    server.close(() => {
      log.info("Server stopped.");
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}
