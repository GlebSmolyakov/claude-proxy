// One ACP session: where the agent works, its mode, the prompt that is
// running, and what the editor has been shown so far.

import { realpathSync } from "node:fs";

import type { SessionConfigSelectOption, SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  McpServerConfig,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentQuery, Pushable } from "./agent.js";
import { type Input, TaskPlan, toolInfo } from "./tools.js";

/** Until the first result says otherwise. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** The agent of a session: one `query()` that serves every prompt in it. */
export interface LiveQuery {
  query: AgentQuery;
  /** Where prompts go. */
  input: Pushable<SDKUserMessage>;
  /** Read one message at a time, so the stream stays open between prompts. */
  messages: AsyncIterator<SDKMessage>;
  /** The last lines the CLI printed on stderr, for when it dies. */
  stderrTail: string[];
}

export interface RunningPrompt {
  query: AgentQuery;
  cancelled: boolean;
  /** Settles when the prompt's query has ended. */
  done: Promise<void>;
}

export class Session {
  /** The running agent, until it ends or is stopped. */
  live: LiveQuery | undefined;
  /**
   * `cwd` with its symlinks resolved. Tool inputs carry resolved paths, so
   * this is what they shorten against in a card's title.
   */
  readonly displayRoot: string;
  /** The CLI has saved this session's transcript; later prompts resume it. */
  started = false;
  running: RunningPrompt | undefined;
  /** Tool calls seen and not finished yet. */
  readonly tools = new Map<string, { name: string; input: Input }>();
  /** Tool calls the editor already has a card for. */
  readonly emitted = new Set<string>();
  readonly plan = new TaskPlan();
  contextWindow = DEFAULT_CONTEXT_WINDOW;
  /** What the editor's model picker offers, once the agent has reported it. */
  models: SessionConfigSelectOption[] | undefined;

  constructor(
    /** Both the ACP session id and the Claude Code session id. */
    readonly id: string,
    readonly cwd: string,
    readonly additionalDirectories: string[],
    readonly mcpServers: Record<string, McpServerConfig>,
    public mode: PermissionMode,
    /** An alias or a full id; the CLI's own default when absent. */
    public model: string | undefined,
  ) {
    this.displayRoot = resolved(cwd);
  }

  /**
   * The card of a tool call: `tool_call` the first time the editor hears of
   * it, `tool_call_update` after that, as more of the input is known.
   */
  card(id: string, name: string, input: Input, parent: string | null): SessionUpdate {
    this.tools.set(id, { name, input });
    const info = toolInfo(name, input, this.displayRoot);
    const _meta = {
      claudeCode: { toolName: name, ...(parent !== null && { parentToolUseId: parent }) },
    };
    if (this.emitted.has(id)) {
      return { sessionUpdate: "tool_call_update", toolCallId: id, ...info, rawInput: input, _meta };
    }
    this.emitted.add(id);
    return {
      sessionUpdate: "tool_call",
      toolCallId: id,
      status: "pending",
      ...info,
      rawInput: input,
      _meta,
    };
  }
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
