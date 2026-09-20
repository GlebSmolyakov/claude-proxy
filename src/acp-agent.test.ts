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
    void (async () => {
      for await (const message of prompt) {
        fake.prompts.push(message);
      }
    })();
    const script = scripts[Math.min(fake.starts.length - 1, scripts.length - 1)];
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => (interrupt = resolve));
    const query: AgentQuery = {
      [Symbol.asyncIterator]: () => script(options, { interrupted })[Symbol.asyncIterator](),
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
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
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

  it("starts the Claude Code session under the ACP id and resumes it for the next prompt", async () => {
    const fake = fakeQuery(hello);
    const { prompt, sessionId } = await connect(fake);
    await prompt();
    await prompt();
    expect(fake.starts.map((o) => o.sessionId)).toEqual([sessionId, undefined]);
    expect(fake.starts.map((o) => o.resume)).toEqual([undefined, sessionId]);
  });

  it("starts the session again when its transcript is gone", async () => {
    const gone = async function* (): AsyncGenerator<SDKMessage> {
      yield result({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["No conversation found"],
      });
    };
    const fake = fakeQuery(hello, gone, hello);
    const { prompt, sessionId } = await connect(fake);
    await prompt();
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(fake.starts.map((o) => o.resume ?? o.sessionId)).toEqual([
      sessionId,
      sessionId,
      sessionId,
    ]);
    expect(fake.starts.map((o) => Boolean(o.resume))).toEqual([false, true, false]);
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
    await prompt();
    expect(fake.starts[1].permissionMode).toBe("acceptEdits");
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
    const fake = fakeQuery(waiting);
    const { prompt, editor, sessionId, updates } = await connect(fake);
    const running = prompt();
    await waitFor(() => updates.length > 0);
    await editor.notify(methods.agent.session.cancel, { sessionId });
    await expect(running).resolves.toEqual({ stopReason: "cancelled" });
    expect(fake.interrupts).toBe(1);
  });

  it("changes the mode of a running turn and of the next one", async () => {
    const fake = fakeQuery(waiting, hello);
    const { prompt, editor, sessionId, updates } = await connect(fake);
    const running = prompt();
    await waitFor(() => updates.length > 0);

    await editor.request(methods.agent.session.setMode, { sessionId, modeId: "acceptEdits" });
    expect(fake.modes).toEqual(["acceptEdits"]);
    await editor.notify(methods.agent.session.cancel, { sessionId });
    await running;

    await prompt();
    expect(fake.starts[1].permissionMode).toBe("acceptEdits");
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
