import {
  client as acpClient,
  methods,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  Options,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { type AgentQuery, type RunQuery } from "./agent.js";
import { createApp } from "./acp-agent.js";
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

async function connect(
  fake: Fake,
  answer: (request: RequestPermissionRequest) => RequestPermissionResponse = () => ({
    outcome: { outcome: "selected", optionId: OPTION.allow },
  }),
  fs: { readTextFile: boolean; writeTextFile: boolean } = {
    readTextFile: false,
    writeTextFile: false,
  },
) {
  const updates: SessionNotification[] = [];
  const asked: RequestPermissionRequest[] = [];
  const connection = acpClient({ name: "test-editor" })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      asked.push(ctx.params);
      return answer(ctx.params);
    })
    .connect(
      createApp({
        executable: "/bin/claude",
        permissionMode: "default",
        runQuery: fake.runQuery,
        version: "0.0.0-test",
      }),
    );
  const editor = connection.agent;
  await editor.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs },
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
  return { editor, sessionId, updates, asked, prompt, connection };
}

const kinds = (updates: SessionNotification[]) => updates.map((u) => u.update.sessionUpdate);

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
    expect(kinds(updates)).toEqual(["agent_message_chunk", "usage_update", "usage_update"]);
    expect(updates[0].update).toMatchObject({ content: { type: "text", text: "Hello" } });
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
    expect(kinds(updates).slice(0, 2)).toEqual(["tool_call", "tool_call_update"]);
    expect(updates.at(-3)?.update).toMatchObject({ content: { type: "text", text: "Written." } });
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
