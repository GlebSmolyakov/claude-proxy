// Running a command in the editor's terminal instead of behind its back.
//
// The redirected Bash creates a terminal through ACP, hangs it on the tool
// call's card so the user watches the output as it comes, and hands the
// model what the command printed when it is over.

import { methods } from "@agentclientprotocol/sdk";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Editor } from "./editor-tools.js";
import { log } from "./log.js";

export interface TerminalDeps {
  sessionId: string;
  cwd: string;
  editor: Editor;
  /** Show the terminal on the card of the call that started it. */
  attach: (toolCallId: string, terminalId: string) => Promise<void>;
  /** Terminals of this session, so they can be released when it ends. */
  terminals: Set<string>;
}

/** What the built-in Bash waits by default, and the most it ever waits. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Past this the model gets the tail; the editor still shows everything. */
const OUTPUT_LIMIT = 64_000;

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** The tool call this handler is serving, as the CLI names it. */
export function toolUseId(extra: unknown): string | undefined {
  const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const id = meta?.["claudecode/toolUseId"];
  return typeof id === "string" ? id : undefined;
}

export function bashTool(deps: TerminalDeps) {
  return tool(
    "bash",
    "Run a shell command in the user's terminal, where they can watch it.",
    {
      command: z.string().describe("The command line to run."),
      description: z.string().optional().describe("What the command does, in a few words."),
      timeout: z.number().optional().describe("How long to wait, in milliseconds."),
      run_in_background: z
        .boolean()
        .optional()
        .describe("Leave it running in the terminal instead of waiting for it."),
    },
    async (args, extra) => {
      const call = toolUseId(extra);
      const request = <T>(method: string, params: object) => ask<T>(deps, method, params);

      const { terminalId } = await request<{ terminalId: string }>(methods.client.terminal.create, {
        command: "bash",
        args: ["-lc", args.command],
        cwd: deps.cwd,
        outputByteLimit: OUTPUT_LIMIT,
      });
      deps.terminals.add(terminalId);
      if (call) {
        await deps.attach(call, terminalId);
      }

      if (args.run_in_background === true) {
        // The editor keeps the terminal; the model gets on with its work.
        return text(
          `Started in the user's terminal. It keeps running there, and its output cannot be read back here.`,
        );
      }

      const wait = request<{ exitCode?: number | null; signal?: string | null }>(
        methods.client.terminal.waitForExit,
        { terminalId },
      );
      const limit = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        wait.then(() => false),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), limit))),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        await request(methods.client.terminal.kill, { terminalId });
      }

      const result = await request<{
        output: string;
        truncated: boolean;
        exitStatus?: { exitCode?: number | null; signal?: string | null } | null;
      }>(methods.client.terminal.output, { terminalId });
      await release(deps, terminalId);

      const ending = timedOut
        ? `timed out after ${Math.round(limit / 1000)}s and was stopped`
        : result.exitStatus?.signal
          ? `killed by ${result.exitStatus.signal}`
          : `exited with ${result.exitStatus?.exitCode ?? 0}`;
      const truncated = result.truncated ? "\n[earlier output is only in the terminal]" : "";
      return text(`${result.output}${truncated}\n[${ending}]`);
    },
  );
}

function ask<T>(deps: TerminalDeps, method: string, params: object): Promise<T> {
  return deps.editor.request<T>(method, { sessionId: deps.sessionId, ...params });
}

export async function release(deps: TerminalDeps, terminalId: string): Promise<void> {
  deps.terminals.delete(terminalId);
  try {
    await deps.editor.request(methods.client.terminal.release, {
      sessionId: deps.sessionId,
      terminalId,
    });
  } catch (e) {
    log.warn(
      `[${deps.sessionId}] Could not release terminal ${terminalId}: ${(e as Error).message}`,
    );
  }
}
