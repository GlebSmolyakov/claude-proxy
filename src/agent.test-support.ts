// The Claude Code process, as the host talks to it: a script says what the
// CLI would print for a turn, and the host cannot tell the difference.
//
// A script may also run a tool the way the CLI does: ask the host whether it
// is allowed, then call it where it really lives, which for a tool the
// editor serves is the host's own in-process MCP server. So a test drives
// the real permission flow and the real tool handler, and only the model's
// decisions are written down in advance.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  AccountInfo,
  McpServerStatus,
  Options,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentQuery, RunQuery } from "./agent.js";
import { SERVER } from "./editor-tools.js";

/** What a tool call is given and answers with, as the CLI passes it around. */
export type ToolInput = Record<string, unknown>;

/** A turn, written as the messages the CLI would print and what it would ask. */
export type Script = (options: Options, controls: Controls) => AsyncGenerator<SDKMessage>;

export interface Controls {
  /** Settles when the host interrupts the turn. */
  interrupted: Promise<void>;
  /**
   * Use a tool the way the CLI does, in the CLI's own order: say that the
   * model asked for it, ask the host whether it is allowed, run it, and
   * then report what came back. A tool the editor serves runs for real; for
   * one the CLI runs itself `answer` is what it would have replied.
   */
  use: (name: string, input: ToolInput, answer?: unknown) => AsyncGenerator<SDKMessage>;
  /** The turn was interrupted while a tool was running. */
  stopped: boolean;
}

export interface Fake {
  runQuery: RunQuery;
  /** Every tool a script used, and what the host answered about it. */
  used: ToolUse[];
  /** Prompts the host asked to rewind the files to. */
  rewinds: string[];
  /** What a rewind answers; a test changes it to try the other endings. */
  rewound: RewindFilesResult;
  /** What the CLI says about the context and the subscription. */
  context: SDKControlGetContextUsageResponse;
  spent: SDKControlGetUsageResponse;
  /** The MCP servers the CLI runs, and what the host asked to do with them. */
  mcp: McpServerStatus[];
  mcpChanges: string[];
  /** What the CLI reports about the account it works under. */
  account: AccountInfo;
  /** Models the editor asked for, through the picker. */
  models: string[];
  /** Options of every query the host started, in order. */
  starts: Options[];
  prompts: SDKUserMessage[];
  interrupts: number;
  closes: number;
  modes: PermissionMode[];
}

export function fakeQuery(...scripts: Script[]): Fake {
  const fake: Fake = {
    runQuery: () => never(),
    used: [],
    rewinds: [],
    rewound: { canRewind: true, filesChanged: ["src/a.ts"], insertions: 2, deletions: 1 },
    context: {
      categories: [
        { name: "Messages", tokens: 40_000, color: "blue", kind: "used" },
        { name: "Free", tokens: 160_000, color: "grey", kind: "free" },
      ],
      totalTokens: 200_000,
      maxTokens: 200_000,
      percentage: 20,
    } as unknown as SDKControlGetContextUsageResponse,
    spent: {
      subscription_type: "max",
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-09-21T14:20:00.000Z" },
        seven_day: { utilization: 12, resets_at: null },
      },
    } as unknown as SDKControlGetUsageResponse,
    mcp: [{ name: "db", status: "connected", serverInfo: { name: "db-mcp", version: "1.0" } }],
    mcpChanges: [],
    starts: [],
    prompts: [],
    interrupts: 0,
    closes: 0,
    modes: [],
    models: [],
    account: { email: "user@example.com", apiProvider: "firstParty" },
  };
  fake.runQuery = ({ prompt, options }) => {
    fake.starts.push(options);
    const tools = toolRunner(options, fake);
    let interrupt = () => {};
    // One agent for the session: every prompt pushed into the stream runs the next turn.
    const messages = (async function* () {
      for await (const message of prompt) {
        fake.prompts.push(message);
        const script = scripts[Math.min(fake.prompts.length - 1, scripts.length - 1)];
        const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
        const controls: Controls = {
          interrupted,
          stopped: false,
          use: (name, input, answer) => tools.use(controls, name, input, answer),
        };
        yield* script(options, controls);
      }
    })();
    const query: AgentQuery = {
      [Symbol.asyncIterator]: () => messages,
      interrupt: async () => {
        fake.interrupts += 1;
        interrupt();
        return undefined;
      },
      setPermissionMode: async (mode) => {
        fake.modes.push(mode);
      },
      setModel: async (model) => {
        fake.models.push(model ?? "default");
      },
      accountInfo: async () => fake.account,
      rewindFiles: async (userMessageId: string) => {
        fake.rewinds.push(userMessageId);
        return fake.rewound;
      },
      getContextUsage: async () => fake.context,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => fake.spent,
      mcpServerStatus: async () => fake.mcp,
      toggleMcpServer: async (name: string, enabled: boolean) => {
        fake.mcpChanges.push(`${enabled ? "on" : "off"} ${name}`);
      },
      reconnectMcpServer: async (name: string) => {
        fake.mcpChanges.push(`reconnect ${name}`);
      },
      supportedCommands: async () => [
        { name: "compact", description: "Compact the conversation", argumentHint: "" },
        { name: "review", description: "Review the diff", argumentHint: "[pr]" },
      ],
      supportedModels: async () => [
        {
          value: "sonnet",
          resolvedModel: "claude-haiku-4-5-20251001",
          displayName: "Sonnet 5",
          description: "Everyday work",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
        { value: "haiku", displayName: "Haiku 4.5", description: "Fast and cheap" },
      ],
      close: () => {
        fake.closes += 1;
        interrupt();
        void tools.close();
        void messages.return(undefined);
      },
    };
    return query;
  };
  return fake;
}

function never(): never {
  throw new Error("no script for this query");
}

/** One tool call a script made, as the CLI would have seen it go. */
export interface ToolUse {
  /** The name the host knows it by, after its aliases. */
  name: string;
  input: ToolInput;
  allowed: boolean;
  /** What came back: the tool's own answer, or why it was refused. */
  answer: unknown;
}

/**
 * The part of the CLI that runs tools. Permission goes to the host exactly
 * as the real one asks for it, and a tool of the host's own server runs
 * through a real MCP client, so the handler, the editor behind it and the
 * card that comes out of it are all the real ones.
 */
function toolRunner(options: Options, fake: Fake) {
  let client: Client | undefined;
  let calls = 0;

  const connected = async (): Promise<Client> => {
    if (client) {
      return client;
    }
    const server = options.mcpServers?.[SERVER];
    if (!server || !("instance" in server)) {
      throw new Error(`the host gave this query no '${SERVER}' server to call tools on`);
    }
    const [ours, theirs] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(theirs);
    const fresh = new Client({ name: "fake-cli", version: "0" });
    await fresh.connect(ours);
    client = fresh;
    return fresh;
  };

  async function* use(
    controls: Controls,
    name: string,
    input: ToolInput,
    answer?: unknown,
  ): AsyncGenerator<SDKMessage> {
    const id = `t${++calls}`;
    // The CLI resolves an alias before it asks about the call or runs it.
    const real = options.toolAliases?.[name] ?? name;
    // The model asks for the tool first; everything else follows from that.
    yield asked(id, real, input);
    const decision = await options.canUseTool?.(real, input, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: id,
      requestId: id,
    });
    if (decision == null) {
      throw new Error("the host gave this query no canUseTool");
    }
    if (decision.behavior !== "allow") {
      const why = decision.behavior === "deny" ? decision.message : "the tool was not allowed";
      fake.used.push({ name: real, input, allowed: false, answer: why });
      yield answered(id, why, true);
      return;
    }
    const args = decision.updatedInput ?? input;
    const call = real.startsWith(`mcp__${SERVER}__`)
      ? (await connected()).callTool({
          name: real.slice(`mcp__${SERVER}__`.length),
          arguments: args,
          _meta: { "claudecode/toolUseId": id },
        })
      : Promise.resolve({
          content: [{ type: "text", text: String(answer ?? "ok") }],
          isError: false,
        });
    // An interrupt stops the CLI waiting for a tool, whatever it is doing.
    const ran = await Promise.race([
      call.then((done) => ({ done })),
      controls.interrupted.then(() => ({ done: undefined })),
    ]);
    if (!ran.done) {
      controls.stopped = true;
      fake.used.push({ name: real, input: args, allowed: true, answer: INTERRUPTED });
      yield answered(id, INTERRUPTED, true);
      return;
    }
    const failed = ran.done.isError === true;
    fake.used.push({ name: real, input: args, allowed: true, answer: ran.done.content });
    yield answered(id, ran.done.content, failed);
  }

  return { use, close: () => client?.close() ?? Promise.resolve() };
}

/** What the CLI says when the model asks for a tool. */
function asked(id: string, name: string, input: ToolInput): SDKMessage {
  // No message id: the call belongs to the message the turn is streaming.
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  } as unknown as SDKMessage;
}

/** And what it says when the tool is done. */
function answered(id: string, content: unknown, failed: boolean): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: failed }],
    },
  } as unknown as SDKMessage;
}

/** What a tool call comes back with when the user stopped the turn instead. */
const INTERRUPTED = "This request was interrupted by user";
