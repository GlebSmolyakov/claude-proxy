// Runs Claude Code as a full agent through the Agent SDK: the options for
// `query()`, the prompt it reads, and where the binary is.
//
// The agent works with its own system prompt, built-in tools, CLAUDE.md,
// settings, skills and MCP servers, and runs its tool loop itself. Each ACP
// prompt is one `query()`; the next prompt of the session resumes it.

import { createRequire } from "node:module";

import type {
  CanUseTool,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

import { ALLOW_BYPASS } from "./permissions.js";
import type { Session } from "./session.js";

/** Startup savings only; nothing here narrows what the agent can do. */
export const AGENT_ENV = {
  // In a non-interactive run this skips an extra model call that titles every session.
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  // No update, telemetry or feature-flag calls at startup: about 1 s saved per turn.
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};

/** The part of a `query()` the host uses; tests put a fake in its place. */
export type AgentQuery = AsyncIterable<SDKMessage> &
  Pick<Query, "interrupt" | "setPermissionMode" | "close">;

export type RunQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AgentQuery;

export interface AgentOptions {
  session: Session;
  /** Continue the session's saved transcript instead of starting it. */
  resume: boolean;
  /** An alias or a full model id; the CLI's own default when absent. */
  model?: string;
  /** The Claude Code binary. */
  executable: string;
  /** Asks the editor about actions that need approval. */
  canUseTool: CanUseTool;
  stderr: (data: string) => void;
}

export function buildOptions(o: AgentOptions): Options {
  const s = o.session;
  return {
    ...(o.model !== undefined && { model: o.model }),
    cwd: s.cwd,
    ...(s.additionalDirectories.length > 0 && { additionalDirectories: s.additionalDirectories }),
    ...(Object.keys(s.mcpServers).length > 0 && { mcpServers: s.mcpServers }),
    // Claude Code's prompt, tools and settings from every source; the last
    // is what brings CLAUDE.md in.
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    includePartialMessages: true,
    permissionMode: s.mode,
    // Lets the editor switch to bypassPermissions later in the session.
    allowDangerouslySkipPermissions: ALLOW_BYPASS,
    canUseTool: o.canUseTool,
    // Its questions need forms, which this host does not render.
    disallowedTools: ["AskUserQuestion"],
    // The ACP session id is the CLI's session id, so the next prompt finds the transcript.
    ...(o.resume ? { resume: s.id } : { sessionId: s.id }),
    pathToClaudeCodeExecutable: o.executable,
    env: { ...process.env, ...AGENT_ENV },
    stderr: o.stderr,
  };
}

/** The user's message, typed in the editor. */
export function userMessage(content: ContentBlockParam[]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  };
}

/**
 * The prompt as a stream of one message. Streaming input keeps the control
 * channel open, which `canUseTool`, interrupting and switching modes need;
 * the SDK ends it after the result.
 */
export async function* once(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
  yield message;
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
