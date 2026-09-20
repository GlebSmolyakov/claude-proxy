// Runs Claude Code as a full agent through the Agent SDK, one `query()` per
// turn, and turns what it says into events.
//
// The agent works with its own system prompt, built-in tools, CLAUDE.md,
// settings, skills and MCP servers, and runs its tool loop itself: one turn
// is one run from the prompt to the final answer.

import { createRequire } from "node:module";

import {
  type CanUseTool,
  type Options,
  type PermissionMode,
  query,
  type SDKMessage,
  type SDKRateLimitInfo,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

import { log } from "./log.js";

/** A run that prints nothing for this long is stopped. */
export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_TAIL_LINES = 5;
const PROGRESS_EVERY_MS = 30 * 1000;

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
];

/** Startup savings only; nothing here narrows what the agent can do. */
export const AGENT_ENV = {
  // In a non-interactive run this skips an extra model call that titles every session.
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  // No update, telemetry or feature-flag calls at startup: about 1 s saved per turn.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** What the model is told when an action waits for approval nobody can give. */
export const REFUSAL =
  "This action needs the user's approval, and this session has no way to ask for it. " +
  "Do not retry it. Finish without it and tell the user what you wanted to do and why.";

export type AgentEvent =
  /** The session started; `model` is the id the alias resolved to. */
  | { type: "init"; sessionId: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "rate_limit"; info: SDKRateLimitInfo }
  | { type: "result"; result: SDKResultMessage }
  /** Nothing came for `INACTIVITY_TIMEOUT_MS`; the run was stopped. */
  | { type: "timeout" }
  /** The run is over. `error` is set when the SDK failed: the CLI did not start, crashed or exited with an error. */
  | { type: "exit"; error?: string; stderrTail: string };

export interface AgentOptions {
  requestId: string;
  api: string;
  /** An alias or a full model id. */
  model: string;
  /** The client's system prompt, appended to Claude Code's own. */
  systemPrompt: string;
  /** Continue this saved session, forking it. */
  resume?: string;
  cwd: string;
  permissionMode: PermissionMode;
  /** The Claude Code binary. */
  executable: string;
  prompt: ContentBlockParam[];
  /** Aborted when nobody waits for the turn any more. */
  signal: AbortSignal;
}

export function buildOptions(o: AgentOptions, stderr: (data: string) => void): Options {
  return {
    model: o.model,
    cwd: o.cwd,
    // Claude Code's prompt, tools and settings from every source; the last
    // is what brings CLAUDE.md in.
    systemPrompt: o.systemPrompt
      ? { type: "preset", preset: "claude_code", append: o.systemPrompt }
      : { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
    permissionMode: o.permissionMode,
    allowDangerouslySkipPermissions: o.permissionMode === "bypassPermissions",
    canUseTool: refuseUnapproved(o.requestId),
    // Its questions would have nobody to answer them, as in the official
    // adapter for clients without forms.
    disallowedTools: ["AskUserQuestion"],
    ...(o.resume !== undefined && { resume: o.resume, forkSession: true }),
    pathToClaudeCodeExecutable: o.executable,
    env: { ...process.env, ...AGENT_ENV },
    stderr,
  };
}

/**
 * Called for every action that the permission mode and the user's settings
 * leave to a human. An HTTP client has no way to answer, so the action is
 * refused and the model hears why.
 */
export function refuseUnapproved(requestId: string): CanUseTool {
  return async (toolName) => {
    log.info(`[req=${requestId}] Refused ${toolName}: it needs approval, and nobody can give it`);
    return { behavior: "deny", message: REFUSAL };
  };
}

/** Run the agent on one prompt. The last event is always `timeout` or `exit`, unless the turn was abandoned. */
export async function* runAgent(o: AgentOptions): AsyncGenerator<AgentEvent> {
  const rid = o.requestId;
  const started = performance.now();
  const elapsed = () => ((performance.now() - started) / 1000).toFixed(2);
  const session = o.resume !== undefined ? "resume" : "fresh";
  log.info(
    `[req=${rid}] Starting claude model=${o.model} api=${o.api} session=${session} permissions=${o.permissionMode}`,
  );

  const stderrTail: string[] = [];
  let run: ReturnType<typeof query> | undefined;
  let timedOut = false;
  let abandoned = false;
  let inactivity: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(inactivity);
    inactivity = setTimeout(() => {
      timedOut = true;
      run?.close();
    }, INACTIVITY_TIMEOUT_MS);
  };
  const onStderr = (data: string) => {
    touch();
    for (const line of data.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      log.debug(`[req=${rid}] stderr: ${line}`);
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) {
        stderrTail.shift();
      }
    }
  };
  const onAbort = () => {
    abandoned = true;
    run?.close();
  };

  let ttft: string | undefined;
  let chunks = 0;
  // Messages since the last progress report; an idle run reports nothing.
  let recent = 0;
  const progress = setInterval(() => {
    if (recent > 0) {
      log.info(`[req=${rid}] Still running ${elapsed()}s chunks=${chunks}`);
      recent = 0;
    }
  }, PROGRESS_EVERY_MS);

  const translator = new Translator();
  let error: string | undefined;
  try {
    run = query({ prompt: once(userMessage(o.prompt)), options: buildOptions(o, onStderr) });
    o.signal.addEventListener("abort", onAbort, { once: true });
    if (o.signal.aborted) {
      onAbort();
    }
    touch();
    for await (const message of run) {
      touch();
      recent += 1;
      for (const event of translator.push(message)) {
        if (event.type === "text_delta") {
          chunks += 1;
          if (ttft === undefined) {
            ttft = `${elapsed()}s`;
            log.info(`[req=${rid}] First token after ${ttft}`);
          }
        }
        yield event;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(inactivity);
    clearInterval(progress);
    o.signal.removeEventListener("abort", onAbort);
  }

  if (abandoned) {
    log.info(`[req=${rid}] Turn abandoned after ${elapsed()}s, stopped claude`);
    return;
  }
  if (timedOut) {
    log.warn(`[req=${rid}] No output for 30 minutes, stopped claude`);
    yield { type: "timeout" };
    return;
  }
  log.info(`[req=${rid}] Done model=${o.model} ttft=${ttft ?? "-"} total=${elapsed()}s`);
  yield { type: "exit", ...(error !== undefined && { error }), stderrTail: stderrTail.join("\n") };
}

function userMessage(content: ContentBlockParam[]): SDKUserMessage {
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/**
 * The prompt as a stream of one message. Streaming input keeps the control
 * channel open, which `canUseTool` needs; the SDK ends it after the result.
 */
async function* once(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
  yield message;
}

/**
 * SDK messages → events. Only the main agent speaks to the client: text of
 * subagents and thinking stay out. A run makes several API calls, so a text
 * block that starts after earlier text is set off by a blank line.
 */
export class Translator {
  private wroteText = false;
  private newBlock = false;

  push(message: SDKMessage): AgentEvent[] {
    switch (message.type) {
      case "system":
        return message.subtype === "init"
          ? [{ type: "init", sessionId: message.session_id, model: message.model }]
          : [];
      case "stream_event": {
        if (message.parent_tool_use_id !== null) {
          return [];
        }
        const event = message.event;
        if (event.type === "content_block_start") {
          this.newBlock = true;
          return [];
        }
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          event.delta.text !== ""
        ) {
          const gap = this.newBlock && this.wroteText ? "\n\n" : "";
          this.newBlock = false;
          this.wroteText = true;
          return [{ type: "text_delta", text: gap + event.delta.text }];
        }
        return [];
      }
      case "rate_limit_event":
        return [{ type: "rate_limit", info: message.rate_limit_info }];
      case "result":
        return [{ type: "result", result: message }];
      default:
        return [];
    }
  }
}

/**
 * The Claude Code binary: `CLAUDE_CODE_EXECUTABLE`, or the one the SDK ships
 * as a platform package, looked up the way the official adapter does it.
 */
export function claudeExecutable(): string {
  const override = process.env.CLAUDE_CODE_EXECUTABLE;
  if (override) {
    return override;
  }
  const require = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const ext = process.platform === "win32" ? ".exe" : "";
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const candidates =
    process.platform === "linux"
      ? [`${base}/claude${ext}`, `${base}-musl/claude${ext}`]
      : [`${base}/claude${ext}`];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try the next one
    }
  }
  throw new Error(
    `Claude Code binary not found for ${process.platform}-${process.arch}. ` +
      "Reinstall @anthropic-ai/claude-agent-sdk with its optional dependencies, or set CLAUDE_CODE_EXECUTABLE.",
  );
}
