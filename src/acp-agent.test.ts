import {
  client as acpClient,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AccountInfo,
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { type AgentQuery, type RunQuery } from "./agent.js";
import { type ClaudeProxyAgent, createApp, type HostOptions, mcpServers } from "./acp-agent.js";
import { OPTION } from "./permissions.js";
import {
  init,
  messageDelta,
  messageStart,
  result,
  text,
  toolStart,
  toolUse,
} from "./sdk-messages.test-support.js";

/** A turn, written as the messages the CLI would print and what it would ask. */
type Script = (
  options: Options,
  controls: { interrupted: Promise<void> },
) => AsyncGenerator<SDKMessage>;

interface Fake {
  runQuery: RunQuery;
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

function fakeQuery(...scripts: Script[]): Fake {
  const fake: Fake = {
    runQuery: () => never(),
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
    let interrupt = () => {};
    // One agent for the session: every prompt pushed into the stream runs the next turn.
    const messages = (async function* () {
      for await (const message of prompt) {
        fake.prompts.push(message);
        const script = scripts[Math.min(fake.prompts.length - 1, scripts.length - 1)];
        const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
        yield* script(options, { interrupted });
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

/** A saved conversation, in the shape `getSessionMessages` returns. */
const saved = (messages: object[]) =>
  messages.map((message, i) => ({
    ...message,
    uuid: `u${i}`,
    session_id: "saved",
    parent_agent_id: null,
  })) as never;

async function connect(
  fake: Fake,
  answer: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "selected", optionId: OPTION.allow },
  }),
  fs: { readTextFile: boolean; writeTextFile: boolean } = {
    readTextFile: false,
    writeTextFile: false,
  },
  readSession: HostOptions["readSession"] = async () => [],
  elicit?: (request: CreateElicitationRequest) => CreateElicitationResponse,
  listSessions: HostOptions["listSessions"] = async () => [],
) {
  const updates: SessionNotification[] = [];
  const asked: RequestPermissionRequest[] = [];
  const forms: CreateElicitationRequest[] = [];
  let host!: ClaudeProxyAgent;
  const connection = acpClient({ name: "test-editor" })
    .onRequest(methods.client.elicitation.create, (ctx) => {
      forms.push(ctx.params);
      return elicit ? elicit(ctx.params) : { action: "cancel" };
    })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      asked.push(ctx.params);
      return answer(ctx.params);
    })
    .connect(
      createApp(
        {
          executable: "/bin/claude",
          permissionMode: "default",
          runQuery: fake.runQuery,
          readSession,
          listSessions,
          idleMs: 30 * 60_000,
          allowMcp: [],
          proxyMcp: {},
          version: "0.0.0-test",
        },
        (h) => (host = h),
      ),
    );
  const editor = connection.agent;
  await editor.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs, ...(elicit && { elicitation: { form: {} } }) },
  });
  const { sessionId } = await editor.request(methods.agent.session.new, {
    cwd: "/repo",
    mcpServers: [],
  });
  const prompt = (t = "go") =>
    editor.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: t }],
    });
  return { editor, sessionId, updates, asked, forms, prompt, connection, host: () => host };
}

const kinds = (updates: SessionNotification[]) => updates.map((u) => u.update.sessionUpdate);
/** The agent's first spoken words. */
const said = (updates: SessionNotification[]) =>
  updates.map((u) => u.update).find((u) => u.sessionUpdate === "agent_message_chunk");

async function* hello(): AsyncGenerator<SDKMessage> {
  yield init();
  yield messageStart("msg_1");
  yield text("Hello");
  yield messageDelta(100, 20);
  yield result();
}

describe("initialize and session/new", () => {
  it("report what the host can do and the modes of a new session", async () => {
    const connection = acpClient({ name: "test-editor" }).connect(
      createApp({
        executable: "/bin/claude",
        permissionMode: "acceptEdits",
        runQuery: fakeQuery(hello).runQuery,
        readSession: async () => [],
        listSessions: async () => [],
        idleMs: 30 * 60_000,
        allowMcp: [],
        proxyMcp: {},
        version: "1.2.3",
      }),
    );
    const initialized = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(initialized).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      authMethods: [],
      agentInfo: { name: "claude-proxy", version: "1.2.3" },
      agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
    });

    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: "/repo",
      mcpServers: [],
    });
    expect(session.modes?.currentModeId).toBe("acceptEdits");
    expect(session.modes?.availableModes.map((m) => m.id)).toContain("plan");
    await expect(
      connection.agent.request(methods.agent.session.new, { cwd: "relative", mcpServers: [] }),
    ).rejects.toThrow(/absolute/);
  });
});

describe("MCP servers of the editor", () => {
  const stdio = { name: "Air", command: "/tmp/mcp-proxy", args: ["--port", "65110"], env: [] };
  const http = {
    name: "tickets",
    type: "http" as const,
    url: "https://example.com/mcp",
    headers: [{ name: "Authorization", value: "secret" }],
  };

  it("stay with the editor unless they are allowed by name", () => {
    expect(mcpServers([stdio, http], [])).toEqual({});
    expect(mcpServers([stdio, http], ["Air"])).toEqual({
      Air: { type: "stdio", command: "/tmp/mcp-proxy", args: ["--port", "65110"], env: {} },
    });
    expect(Object.keys(mcpServers([stdio, http], "all"))).toEqual(["Air", "tickets"]);
  });

  it("are left out when their transport is one this host does not speak", () => {
    const overAcp = { name: "editor", type: "acp" as const };
    expect(mcpServers([overAcp as never], "all")).toEqual({});
  });
});

describe("signing in", () => {
  it("is offered when the client can run the agent in a terminal", async () => {
    const connection = acpClient({ name: "test-editor" }).connect(
      createApp({
        executable: "/bin/claude",
        permissionMode: "default",
        runQuery: fakeQuery(hello).runQuery,
        readSession: async () => [],
        listSessions: async () => [],
        idleMs: 0,
        allowMcp: [],
        proxyMcp: {},
        version: "1.2.3",
      }),
    );
    const withTerminal = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { auth: { terminal: true } },
    });
    expect(withTerminal.authMethods).toEqual([
      {
        type: "terminal",
        id: "claude-login",
        name: "Log in to Claude Code",
        description: "Signs in to your Anthropic account, as `claude auth login` does",
        args: ["--login"],
      },
    ]);

    const without = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(without.authMethods).toEqual([]);
    // The client runs that method itself; it is not something to call here.
    await expect(
      connection.agent.request(methods.agent.authenticate, { methodId: "claude-login" }),
    ).rejects.toThrow(/terminal/);
    await expect(
      connection.agent.request(methods.agent.authenticate, { methodId: "made-up" }),
    ).rejects.toThrow(/unknown authentication method/);
  });
});

describe("session/list", () => {
  const saved = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({
      sessionId: `s${from + i}`,
      summary: `Conversation ${from + i}`,
      lastModified: 1_789_000_000_000 + i,
      cwd: "/repo",
    })) as never;

  it("hands the editor what the CLI saved, newest first", async () => {
    const { editor } = await connect(
      fakeQuery(hello),
      undefined,
      undefined,
      undefined,
      undefined,
      async () =>
        [
          {
            sessionId: "s1",
            summary: "Looked at the parser",
            customTitle: "Parser work",
            lastModified: 1_789_000_000_000,
            cwd: "/repo",
          },
          {
            sessionId: "s2",
            summary: "Fixed the tests",
            lastModified: 1_788_000_000,
            cwd: "/other",
          },
        ] as never,
    );
    const listed = await editor.request(methods.agent.session.list, { cwd: "/repo" });
    expect(listed.sessions).toEqual([
      {
        sessionId: "s1",
        cwd: "/repo",
        title: "Parser work",
        updatedAt: new Date(1_789_000_000_000).toISOString(),
      },
      {
        sessionId: "s2",
        cwd: "/other",
        title: "Fixed the tests",
        // An older CLI counts seconds, and it still lands on the right day.
        updatedAt: new Date(1_788_000_000_000).toISOString(),
      },
    ]);
    expect(listed.nextCursor).toBeUndefined();
  });

  it("gives a cursor when more is waiting, and takes it back", async () => {
    const asked: { offset?: number }[] = [];
    const { editor } = await connect(
      fakeQuery(hello),
      undefined,
      undefined,
      undefined,
      undefined,
      async (options) => {
        asked.push(options);
        return saved(options.offset === 0 ? 51 : 2, options.offset);
      },
    );
    const first = await editor.request(methods.agent.session.list, {});
    expect(first.sessions).toHaveLength(50);
    expect(first.nextCursor).toBe("50");

    const second = await editor.request(methods.agent.session.list, { cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(asked.map((o) => o.offset)).toEqual([0, 50]);

    await expect(editor.request(methods.agent.session.list, { cursor: "later" })).rejects.toThrow(
      /not a cursor/,
    );
  });
});

describe("session/load", () => {
  const transcript = saved([
    {
      type: "user",
      message: { role: "user", content: "what is in a.ts?" },
      parent_tool_use_id: null,
    },
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "export {}" }],
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "msg_2", content: [{ type: "text", text: "An empty module." }] },
    },
  ]);

  it("replays the saved conversation and carries on from it", async () => {
    const fake = fakeQuery(hello);
    const { editor, updates } = await connect(fake, undefined, undefined, async () => transcript);
    const loaded = await editor.request(methods.agent.session.load, {
      sessionId: "saved-1",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(loaded.modes?.currentModeId).toBe("default");
    expect(kinds(updates)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    expect(updates[2].update).toMatchObject({ toolCallId: "t1", title: "Read a.ts" });
    expect(updates[3].update).toMatchObject({ toolCallId: "t1", status: "completed" });

    await editor.request(methods.agent.session.prompt, {
      sessionId: "saved-1",
      prompt: [{ type: "text", text: "and b.ts?" }],
    });
    expect(fake.starts[0].resume).toBe("saved-1");
    expect(fake.starts[0].sessionId).toBeUndefined();
  });

  it("refuses a session the CLI does not have", async () => {
    const { editor } = await connect(fakeQuery(hello), undefined, undefined, async () => []);
    await expect(
      editor.request(methods.agent.session.load, {
        sessionId: "gone",
        cwd: "/repo",
        mcpServers: [],
      }),
    ).rejects.toThrow();
  });
});

describe("session/prompt", () => {
  it("streams the answer and ends the turn with the tokens it used", async () => {
    const fake = fakeQuery(hello);
    const { prompt, updates } = await connect(fake);
    const response = await prompt("hi");

    expect(response).toEqual({
      stopReason: "end_turn",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedReadTokens: 100,
        cachedWriteTokens: 20,
        totalTokens: 135,
      },
    });
    expect(kinds(updates)).toEqual([
      // The agent's first init also brings the account's models and commands.
      "config_option_update",
      "available_commands_update",
      "agent_message_chunk",
      "usage_update",
      "usage_update",
    ]);
    expect(said(updates)).toMatchObject({ content: { type: "text", text: "Hello" } });
    expect(fake.prompts[0].message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("keeps one agent for the whole session", async () => {
    const fake = fakeQuery(hello);
    const { prompt, sessionId } = await connect(fake);
    await prompt("first");
    await prompt("second");
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).toMatchObject({ sessionId });
    expect(fake.starts[0].resume).toBeUndefined();
    expect(fake.prompts).toHaveLength(2);
  });

  it("starts a new agent on the same session when the old one dies", async () => {
    const died = async function* (): AsyncGenerator<SDKMessage> {
      yield init();
      throw new Error("Claude Code process exited with code 1");
    };
    const fake = fakeQuery(died, hello);
    const { prompt, sessionId } = await connect(fake);
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1].resume).toBe(sessionId);
    expect(fake.starts[1].sessionId).toBeUndefined();
  });

  it("asks the editor for a sign-in when the CLI has no credential", async () => {
    const fake = fakeQuery(hello, hello);
    fake.account = {};
    const { prompt } = await connect(fake);
    await expect(prompt()).rejects.toThrow(/not logged in/);
    // One agent, not a retry, and it is gone so a signed-in one can replace it.
    expect(fake.starts).toHaveLength(1);
    expect(fake.closes).toBe(1);

    fake.account = { email: "user@example.com" };
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("asks for a sign-in when the API refuses the credential", async () => {
    const refused = async function* (): AsyncGenerator<SDKMessage> {
      yield init();
      yield result({ is_error: true, api_error_status: 401, result: "Invalid API key" });
    };
    const { prompt } = await connect(fakeQuery(refused));
    await expect(prompt()).rejects.toThrow(/not logged in/);
  });

  it("works under a third-party backend, which carries its own credential", async () => {
    const fake = fakeQuery(hello);
    fake.account = { apiProvider: "bedrock" };
    const { prompt } = await connect(fake);
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("turns a failed turn into an error for the editor", async () => {
    const failed = async function* (): AsyncGenerator<SDKMessage> {
      yield init();
      yield result({ is_error: true, result: "You've hit your limit" });
    };
    const { prompt } = await connect(fakeQuery(failed));
    await expect(prompt()).rejects.toThrow(/hit your limit/);
  });

  it("reports a CLI that dies without a result", async () => {
    const crash = async function* (): AsyncGenerator<SDKMessage> {
      yield init();
      throw new Error("Claude Code process exited with code 1");
    };
    const { prompt } = await connect(fakeQuery(crash));
    await expect(prompt()).rejects.toThrow(/exited with code 1/);
  });
});

describe("closing and idling", () => {
  it("stops the agent of a closed session and forgets it", async () => {
    const fake = fakeQuery(hello);
    const { editor, prompt, sessionId } = await connect(fake);
    await prompt();
    await editor.request(methods.agent.session.close, { sessionId });
    expect(fake.closes).toBe(1);
    await expect(
      editor.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "hi" }],
      }),
    ).rejects.toThrow(/unknown session/);
  });

  it("cancels a running turn before closing", async () => {
    const waiting = async function* (
      _options: Options,
      controls: { interrupted: Promise<void> },
    ): AsyncGenerator<SDKMessage> {
      yield init();
      yield messageStart("msg_1");
      yield text("Working");
      await controls.interrupted;
      yield result({ subtype: "error_during_execution", is_error: true, errors: ["Interrupted"] });
    };
    const fake = fakeQuery(waiting);
    const { editor, prompt, sessionId, updates } = await connect(fake);
    const running = prompt();
    await waitFor(() => updates.length > 0);
    await editor.request(methods.agent.session.close, { sessionId });
    await expect(running).resolves.toEqual({ stopReason: "cancelled" });
    expect(fake.interrupts).toBe(1);
  });

  it("stops an idle agent but keeps the session, which the next prompt resumes", async () => {
    const fake = fakeQuery(hello, hello);
    const { prompt, sessionId, host } = await connect(fake);
    await prompt();
    expect(fake.starts).toHaveLength(1);

    host().closeIdle(Date.now() + 31 * 60_000);
    expect(fake.closes).toBe(1);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1].resume).toBe(sessionId);
  });

  it("leaves a busy session alone", async () => {
    const waiting = async function* (
      _options: Options,
      controls: { interrupted: Promise<void> },
    ): AsyncGenerator<SDKMessage> {
      yield init();
      yield messageStart("msg_1");
      yield text("Working");
      await controls.interrupted;
      yield result();
    };
    const fake = fakeQuery(waiting);
    const { editor, prompt, sessionId, updates, host } = await connect(fake);
    const running = prompt();
    await waitFor(() => updates.length > 0);
    host().closeIdle(Date.now() + 31 * 60_000);
    expect(fake.closes).toBe(0);
    await editor.notify(methods.agent.session.cancel, { sessionId });
    await running;
  });
});

describe("the model picker", () => {
  it("offers aliases at first and the account's models once the agent is up", async () => {
    const fake = fakeQuery(hello);
    const { editor, prompt, updates, sessionId } = await connect(fake);
    const session = await editor.request(methods.agent.session.new, {
      cwd: "/repo",
      mcpServers: [],
    });
    const option = session.configOptions?.[0];
    expect(option).toMatchObject({ id: "model", type: "select", currentValue: "default" });
    // Effort waits until the agent says the model takes it; thinking does not.
    expect(session.configOptions?.map((o) => o.id)).toEqual(["model", "thinking"]);
    const values =
      option?.type === "select" ? option.options.map((o) => ("value" in o ? o.value : o.name)) : [];
    expect(values).toEqual(["default", "opus", "sonnet", "haiku"]);

    await prompt();
    const offered = updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "config_option_update");
    expect(offered?.configOptions[0]).toMatchObject({
      id: "model",
      currentValue: "default",
      options: [
        { value: "default" },
        { value: "sonnet", name: "Sonnet 5" },
        { value: "haiku", name: "Haiku 4.5" },
      ],
    });
    expect(sessionId).toBeTruthy();
  });

  it("switches the model of a running agent and of the ones after it", async () => {
    const fake = fakeQuery(hello, hello);
    const { editor, prompt, sessionId } = await connect(fake);
    await prompt();

    const set = await editor.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "haiku",
    });
    expect(fake.models).toEqual(["haiku"]);
    expect(set.configOptions[0]).toMatchObject({ id: "model", currentValue: "haiku" });

    // A later agent of the same session starts on the chosen model.
    fake.starts.length = 0;
    await editor.notify(methods.agent.session.cancel, { sessionId });
    await expect(
      editor.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "colour",
        value: "teal",
      }),
    ).rejects.toThrow(/unknown option/);
  });
});

describe("slash commands", () => {
  it("are offered to the editor once the agent knows them", async () => {
    const { prompt, updates } = await connect(fakeQuery(hello));
    await prompt();
    const offered = updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "available_commands_update");
    expect(offered?.availableCommands).toEqual([
      { name: "compact", description: "Compact the conversation" },
      { name: "review", description: "Review the diff", input: { hint: "[pr]" } },
    ]);
  });

  it("show what they printed as the agent's answer", async () => {
    const command = async function* (): AsyncGenerator<SDKMessage> {
      yield init();
      yield {
        type: "system",
        subtype: "local_command_output",
        content: "Context compacted.",
      } as unknown as SDKMessage;
      yield result();
    };
    const { prompt, updates } = await connect(fakeQuery(command));
    await prompt("/compact");
    expect(said(updates)).toMatchObject({ content: { type: "text", text: "Context compacted." } });
  });
});

describe("effort and thinking", () => {
  it("are offered once the agent says the model takes them", async () => {
    const { prompt, updates } = await connect(fakeQuery(hello));
    await prompt();
    const offered = updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "config_option_update");
    const effort = offered?.configOptions.find((o) => o.id === "effort");
    expect(effort).toMatchObject({ currentValue: "default", category: "model_config" });
    expect(
      effort?.type === "select" && effort.options.map((o) => ("value" in o ? o.value : "")),
    ).toEqual(["default", "low", "high"]);
  });

  it("restart an idle agent so the next turn has them", async () => {
    const fake = fakeQuery(hello, hello);
    const { editor, prompt, sessionId } = await connect(fake);
    await prompt();

    const set = await editor.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "effort",
      value: "high",
    });
    expect(set.configOptions.find((o) => o.id === "effort")).toMatchObject({
      currentValue: "high",
    });
    expect(fake.closes).toBe(1);

    await prompt();
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1]).toMatchObject({ effort: "high", resume: sessionId });
  });

  it("turn thinking off for the agents that follow", async () => {
    const fake = fakeQuery(hello, hello);
    const { editor, prompt, sessionId } = await connect(fake);
    await prompt();
    await editor.request(methods.agent.session.setConfigOption, {
      sessionId,
      configId: "thinking",
      value: "off",
    });
    await prompt();
    expect(fake.starts[1].thinking).toEqual({ type: "disabled" });
  });
});

describe("files", () => {
  it("run through the editor when it serves them, and on disk when it does not", async () => {
    const serving = fakeQuery(hello);
    const { prompt } = await connect(serving, undefined, {
      readTextFile: true,
      writeTextFile: true,
    });
    await prompt();
    expect(serving.starts[0].toolAliases).toEqual({
      Read: "mcp__acp__read",
      Write: "mcp__acp__write",
      Edit: "mcp__acp__edit",
    });
    expect(serving.starts[0].mcpServers).toHaveProperty("acp");
    expect(serving.starts[0].allowedTools).toBeUndefined();

    const plain = fakeQuery(hello);
    await (await connect(plain)).prompt();
    expect(plain.starts[0].toolAliases).toBeUndefined();
    expect(plain.starts[0].mcpServers).toBeUndefined();
  });
});

describe("redirected reads", () => {
  const reading = (path: string) =>
    async function* (options: Options): AsyncGenerator<SDKMessage> {
      yield init();
      const input = { file_path: path };
      yield toolUse("t1", "Read", input);
      const decision = await options.canUseTool!("mcp__acp__read", input, {
        signal: new AbortController().signal,
        toolUseID: "t1",
        requestId: "q1",
      });
      yield messageStart("msg_1");
      yield text(decision?.behavior === "allow" ? "Read it." : "Refused.");
      yield result();
    };

  it("go through without a dialog inside the session's folders", async () => {
    const { prompt, asked, updates } = await connect(
      fakeQuery(reading("/repo/src/a.ts")),
      undefined,
      {
        readTextFile: true,
        writeTextFile: true,
      },
    );
    await prompt();
    expect(asked).toEqual([]);
    const said = updates
      .map((u) => u.update)
      .find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(said).toMatchObject({ content: { type: "text", text: "Read it." } });
  });

  it("ask about a file outside them", async () => {
    const { prompt, asked } = await connect(
      fakeQuery(reading("/Users/me/.ssh/id_rsa")),
      undefined,
      {
        readTextFile: true,
        writeTextFile: true,
      },
    );
    await prompt();
    expect(asked).toHaveLength(1);
    expect(asked[0].toolCall.title).toBe("Read /Users/me/.ssh/id_rsa");
  });
});

describe("permissions", () => {
  const writing = async function* (options: Options): AsyncGenerator<SDKMessage> {
    yield init();
    yield toolStart("t1", "Write");
    const input = { file_path: "/repo/a.ts", content: "hi" };
    yield toolUse("t1", "Write", input);
    const decision = await options.canUseTool!("Write", input, {
      signal: new AbortController().signal,
      toolUseID: "t1",
      requestId: "q1",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Write" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
    yield messageStart("msg_1");
    yield text(decision?.behavior === "allow" ? "Written." : "I was not allowed.");
    yield messageDelta(10, 2);
    yield result();
  };

  it("asks the editor about an action, on the card it already shows", async () => {
    const fake = fakeQuery(writing);
    const { prompt, asked, updates } = await connect(fake);
    await prompt();

    expect(asked).toHaveLength(1);
    expect(asked[0].toolCall).toMatchObject({
      toolCallId: "t1",
      title: "Write a.ts",
      content: [{ type: "diff", path: "/repo/a.ts", oldText: null, newText: "hi" }],
    });
    expect(asked[0].options.map((o) => o.optionId)).toEqual([
      OPTION.allow,
      OPTION.allowAlways,
      OPTION.reject,
    ]);
    expect(kinds(updates).filter((k) => k.startsWith("tool_call"))).toEqual([
      "tool_call",
      "tool_call_update",
    ]);
    expect(said(updates)).toMatchObject({ content: { type: "text", text: "Written." } });
  });

  it("passes a rejection back to the agent", async () => {
    const fake = fakeQuery(writing);
    const { prompt, updates } = await connect(fake, () => ({
      outcome: { outcome: "selected", optionId: OPTION.reject },
    }));
    await prompt();
    expect(updates.at(-3)?.update).toMatchObject({
      content: { type: "text", text: "I was not allowed." },
    });
  });

  it("switches the session's mode when a plan is approved", async () => {
    const planning = async function* (options: Options): AsyncGenerator<SDKMessage> {
      yield init();
      yield toolUse("t1", "ExitPlanMode", { plan: "1. Do it" });
      await options.canUseTool!(
        "ExitPlanMode",
        { plan: "1. Do it" },
        {
          signal: new AbortController().signal,
          toolUseID: "t1",
          requestId: "q1",
        },
      );
      yield result();
    };
    const fake = fakeQuery(planning, hello);
    const { prompt, updates } = await connect(fake, () => ({
      outcome: { outcome: "selected", optionId: OPTION.planAcceptEdits },
    }));
    await prompt();

    expect(
      updates.map((u) => u.update).find((u) => u.sessionUpdate === "current_mode_update"),
    ).toEqual({
      sessionUpdate: "current_mode_update",
      currentModeId: "acceptEdits",
    });
  });
});

describe("the agent's questions", () => {
  const asking = (input: object) =>
    async function* (options: Options): AsyncGenerator<SDKMessage> {
      yield init();
      const decision = await options.canUseTool!("AskUserQuestion", input as never, {
        signal: new AbortController().signal,
        toolUseID: "t1",
        requestId: "q1",
      });
      yield messageStart("msg_1");
      yield text(
        decision?.behavior === "allow"
          ? JSON.stringify((decision.updatedInput as { answers: unknown }).answers)
          : `refused: ${decision?.behavior === "deny" ? decision.message : ""}`,
      );
      yield result();
    };
  const question = {
    questions: [
      {
        question: "Which colour?",
        header: "Colour",
        multiSelect: false,
        options: [{ label: "Teal", description: "Blue-green" }, { label: "Red" }],
      },
    ],
  };

  it("reach the user as a form, and the answer reaches the tool", async () => {
    const { prompt, forms, updates, asked } = await connect(
      fakeQuery(asking(question)),
      undefined,
      undefined,
      undefined,
      () => ({ action: "accept", content: { question_0: "Teal" } }),
    );
    await prompt();
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({ mode: "form", toolCallId: "t1", message: "Which colour?" });
    expect(asked).toEqual([]);
    expect(said(updates)).toMatchObject({ content: { text: '{"Which colour?":"Teal"}' } });
  });

  it("end the call when the user closes the form", async () => {
    const { prompt, updates } = await connect(
      fakeQuery(asking(question)),
      undefined,
      undefined,
      undefined,
      () => ({ action: "cancel" }),
    );
    await prompt();
    expect(said(updates)?.content).toMatchObject({ text: expect.stringContaining("refused") });
  });
});

describe("an MCP server asking for input", () => {
  it("reaches the user through the same dialog and answers the server", async () => {
    const asking = async function* (options: Options): AsyncGenerator<SDKMessage> {
      yield init();
      const answer = await options.onElicitation!(
        {
          serverName: "tickets",
          message: "Which ticket?",
          mode: "form",
          requestedSchema: { type: "object", properties: { ticket: { type: "string" } } },
        },
        { signal: new AbortController().signal, requestId: "e1" },
      );
      yield messageStart("msg_1");
      yield text(JSON.stringify(answer));
      yield result();
    };
    const { prompt, forms, updates } = await connect(
      fakeQuery(asking),
      undefined,
      undefined,
      undefined,
      () => ({ action: "accept", content: { ticket: "AB-1" } }),
    );
    await prompt();
    expect(forms[0]).toMatchObject({ mode: "form", message: "Which ticket?" });
    expect(said(updates)).toMatchObject({
      content: { text: '{"action":"accept","content":{"ticket":"AB-1"}}' },
    });
  });
});

describe("session/cancel and session/set_mode", () => {
  const waiting = async function* (
    _options: Options,
    controls: { interrupted: Promise<void> },
  ): AsyncGenerator<SDKMessage> {
    yield init();
    yield messageStart("msg_1");
    yield text("Working");
    await controls.interrupted;
    yield result({ subtype: "error_during_execution", is_error: true, errors: ["Interrupted"] });
  };

  it("interrupts the turn and answers the prompt with cancelled", async () => {
    const fake = fakeQuery(waiting, hello);
    const { prompt, editor, sessionId, updates } = await connect(fake);
    const running = prompt();
    await waitFor(() => updates.length > 0);
    await editor.notify(methods.agent.session.cancel, { sessionId });
    await expect(running).resolves.toEqual({ stopReason: "cancelled" });
    expect(fake.interrupts).toBe(1);

    // The agent survives a cancelled turn and takes the next prompt.
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(fake.starts).toHaveLength(1);
  });

  it("changes the mode of a running turn", async () => {
    const fake = fakeQuery(waiting, hello);
    const { prompt, editor, sessionId, updates } = await connect(fake);
    const running = prompt();
    await waitFor(() => updates.length > 0);

    await editor.request(methods.agent.session.setMode, { sessionId, modeId: "acceptEdits" });
    expect(fake.modes).toEqual(["acceptEdits"]);
    await editor.notify(methods.agent.session.cancel, { sessionId });
    await running;
    await expect(
      editor.request(methods.agent.session.setMode, { sessionId, modeId: "yolo" }),
    ).rejects.toThrow(/unknown mode/);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
