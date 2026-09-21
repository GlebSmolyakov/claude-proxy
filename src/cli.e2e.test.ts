// The program itself, started the way an editor starts it.
//
// Everything else in this suite talks to the host in process. Here the
// editor is a child process away: the flags are parsed for real, the
// protocol goes over stdin and stdout as newline-delimited JSON, and
// closing the connection has to end the process.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const program = join(root, "dist", "index.js");

/** When the sources were last touched. */
async function newestSource(): Promise<number> {
  const dir = join(root, "src");
  const times = await Promise.all(
    (await readdir(dir)).map(async (name) => (await stat(join(dir, name))).mtimeMs),
  );
  return Math.max(...times);
}

/** A Claude Code that only has to answer `--version`; no turn is taken here. */
async function stubClaude(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-stub-"));
  const path = join(dir, "claude");
  await writeFile(path, '#!/bin/sh\necho "2.1.274 (Claude Code)"\n');
  await chmod(path, 0o755);
  return path;
}

/** The editor's side of the pipe: write a request, wait for its answer. */
function talk(args: string[], executable: string) {
  const child = spawn(process.execPath, [program, ...args], {
    env: { ...process.env, CLAUDE_CODE_EXECUTABLE: executable, LOG_LEVEL: "error" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter((l) => l.trim() !== "")) {
      const message = JSON.parse(line) as { id?: number };
      if (typeof message.id === "number") {
        waiting.get(message.id)?.(message as Record<string, unknown>);
      }
    }
  });
  let id = 0;
  return {
    child,
    request(method: string, params: unknown): Promise<Record<string, unknown>> {
      const mine = ++id;
      const answered = new Promise<Record<string, unknown>>((resolve) =>
        waiting.set(mine, resolve),
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params })}\n`);
      return answered;
    },
    /** The editor goes away, which is what the program must notice. */
    ended(): Promise<number | null> {
      child.stdin.end();
      return new Promise((resolve) => child.on("exit", resolve));
    },
  };
}

describe("the program an editor starts", () => {
  // A built program is what an editor runs, so these tests use the build —
  // and rebuild it when the sources have moved on, rather than quietly
  // testing yesterday's.
  beforeAll(async () => {
    if (!existsSync(program) || (await newestSource()) > (await stat(program)).mtimeMs) {
      await run("pnpm", ["run", "build"], { cwd: root });
    }
  }, 120_000);

  it("answers its own flags without needing anything else", async () => {
    const { stdout } = await run(process.execPath, [program, "--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const help = await run(process.execPath, [program, "--help"]);
    expect(help.stdout).toContain("--permission-mode");

    await expect(run(process.execPath, [program, "--permission-mode", "whatever"])).rejects.toThrow(
      /Unknown permission mode/,
    );
  });

  it("does the handshake over stdio and opens a session in the mode it was given", async () => {
    const editor = talk(["--permission-mode", "plan"], await stubClaude());

    const initialized = await editor.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    expect(initialized.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: "claude-proxy" },
      agentCapabilities: { loadSession: true },
    });

    const opened = await editor.request("session/new", { cwd: root, mcpServers: [] });
    expect(opened.result).toMatchObject({ modes: { currentModeId: "plan" } });

    // Closing the connection is how an editor says it is done.
    await expect(editor.ended()).resolves.toBe(0);
  }, 30_000);

  it("refuses a relative folder with an error, not a crash", async () => {
    const editor = talk([], await stubClaude());
    await editor.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const refused = await editor.request("session/new", { cwd: "repo", mcpServers: [] });
    expect(refused.error).toMatchObject({ message: expect.stringContaining("absolute") });
    await editor.ended();
  }, 30_000);
});
