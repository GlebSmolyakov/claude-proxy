import { methods } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import { bashTool, type TerminalDeps, toolUseId } from "./terminal.js";

/** An editor with one terminal, whose command ends when the test says so. */
function editor(options: { exits?: Promise<void>; output?: string; exitCode?: number } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const attached: [string, string][] = [];
  const deps: TerminalDeps = {
    sessionId: "s1",
    cwd: "/repo",
    terminals: new Set<string>(),
    attach: async (toolCallId, terminalId) => {
      attached.push([toolCallId, terminalId]);
    },
    editor: {
      notify: async () => {},
      request: (async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        switch (method) {
          case methods.client.terminal.create:
            return { terminalId: "term-1" };
          case methods.client.terminal.waitForExit:
            await (options.exits ?? Promise.resolve());
            return { exitCode: options.exitCode ?? 0 };
          case methods.client.terminal.output:
            return {
              output: options.output ?? "done\n",
              truncated: false,
              exitStatus: { exitCode: options.exitCode ?? 0 },
            };
          default:
            return {};
        }
      }) as TerminalDeps["editor"]["request"],
    },
  };
  return { deps, calls, attached, methodsCalled: () => calls.map((c) => c.method) };
}

const run = (deps: TerminalDeps, args: Record<string, unknown>, extra?: unknown) =>
  bashTool(deps).handler(args as never, extra);
const output = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const CALL = { _meta: { "claudecode/toolUseId": "t1" } };

describe("bash in the editor's terminal", () => {
  it("runs the command there and hangs the terminal on its card", async () => {
    const { deps, calls, attached, methodsCalled } = editor();
    const result = await run(deps, { command: "ls -la" }, CALL);

    expect(calls[0].params).toMatchObject({
      sessionId: "s1",
      command: "bash",
      args: ["-lc", "ls -la"],
      cwd: "/repo",
    });
    expect(attached).toEqual([["t1", "term-1"]]);
    expect(methodsCalled()).toEqual([
      methods.client.terminal.create,
      methods.client.terminal.waitForExit,
      methods.client.terminal.output,
      methods.client.terminal.release,
    ]);
    expect(output(result)).toBe("done\n\n[exited with 0]");
    expect(deps.terminals.size).toBe(0);
  });

  it("reports how a command ended", async () => {
    const { deps } = editor({ output: "boom\n", exitCode: 2 });
    expect(output(await run(deps, { command: "false" }, CALL))).toBe("boom\n\n[exited with 2]");
  });

  it("leaves a background command running and says so", async () => {
    const { deps, methodsCalled } = editor({ exits: new Promise(() => {}) });
    const result = await run(deps, { command: "npm run dev", run_in_background: true }, CALL);
    expect(methodsCalled()).toEqual([methods.client.terminal.create]);
    expect(output(result)).toContain("keeps running");
    // The editor keeps the terminal; the session releases it at the end.
    expect([...deps.terminals]).toEqual(["term-1"]);
  });

  it("stops a command that outstays its timeout", async () => {
    vi.useFakeTimers();
    try {
      const { deps, methodsCalled } = editor({ exits: new Promise(() => {}) });
      const running = run(deps, { command: "sleep 100", timeout: 1000 }, CALL);
      await vi.advanceTimersByTimeAsync(1000);
      expect(output(await running)).toContain("timed out after 1s");
      expect(methodsCalled()).toContain(methods.client.terminal.kill);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still runs when the call has no id to hang the terminal on", async () => {
    const { deps, attached } = editor();
    expect(output(await run(deps, { command: "ls" }, {}))).toContain("[exited with 0]");
    expect(attached).toEqual([]);
    expect(toolUseId(CALL)).toBe("t1");
    expect(toolUseId(undefined)).toBeUndefined();
  });
});
