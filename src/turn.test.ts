import { describe, expect, it } from "vitest";

import type { AgentEvent, AgentOptions } from "./agent.js";
import { Channel } from "./channel.js";
import { ConversationBuilder, type Role, text } from "./conversation.js";
import type { SessionStore } from "./session.js";
import { RuntimeStatus } from "./status.js";
import { delta, exit, init, replay, result, sessions, state } from "./testing.js";
import { relay, startTurn, type TurnEvent, type TurnRequest } from "./turn.js";

function request(turns: [Role, string][]): TurnRequest {
  const b = new ConversationBuilder();
  for (const [role, t] of turns) {
    b.push(role, [text(t)]);
  }
  return { requestId: "r", api: "openai", model: "haiku", conversation: b.build() };
}

async function drain(events: Channel<TurnEvent>): Promise<TurnEvent[]> {
  events.close();
  const out: TurnEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

async function run(req: TurnRequest, store: SessionStore, resuming: boolean, events: AgentEvent[]) {
  const channel = new Channel<TurnEvent>();
  const ctx = { sessions: store, status: new RuntimeStatus("test"), request: req, resuming };
  const outcome = await relay(ctx, replay(events), channel);
  return { outcome, events: await drain(channel) };
}

const modelUsage = {
  "claude-haiku-4-5-20251001": {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 50,
    cacheCreationInputTokens: 5,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
  },
  "claude-sonnet-5": {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadInputTokens: 3,
    cacheCreationInputTokens: 4,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  },
};

describe("relay", () => {
  it("streams, finishes with the whole run's usage and remembers the session", async () => {
    const req = request([["user", "hi"]]);
    const store = await sessions();
    const { outcome, events } = await run(req, store, false, [
      init(),
      delta("Hel"),
      delta("lo"),
      result({ result: "Hello", session_id: "sid-2", stop_reason: "end_turn", modelUsage }),
      exit(),
    ]);

    expect(outcome).toBe("done");
    expect(events.map((e) => e.type)).toEqual(["started", "delta", "delta", "finished"]);
    expect(events[0]).toEqual({ type: "started", model: "claude-haiku-4-5-20251001" });
    const finished = events[3] as Extract<TurnEvent, { type: "finished" }>;
    expect(finished.output.text).toBe("Hello");
    expect(finished.output.usage).toEqual({
      input_tokens: 101,
      output_tokens: 22,
      cache_read_input_tokens: 53,
      cache_creation_input_tokens: 9,
    });

    const next = request([
      ["user", "hi"],
      ["assistant", "Hello"],
      ["user", "more"],
    ]);
    expect(store.lookup(next.conversation.historyKey()!)).toBe("sid-2");
  });

  it("falls back to the main loop's usage and to the streamed text", async () => {
    const { events } = await run(request([["user", "hi"]]), await sessions(), false, [
      init(),
      delta("Streamed."),
      result({ result: "", usage: { input_tokens: 7, output_tokens: 3 } }),
      exit(),
    ]);
    const finished = events.at(-1) as Extract<TurnEvent, { type: "finished" }>;
    expect(finished.output.text).toBe("Streamed.");
    expect(finished.output.usage.input_tokens).toBe(7);
  });

  it("remembers the streamed text of all steps next to the final answer", async () => {
    const store = await sessions();
    await run(request([["user", "hi"]]), store, false, [
      init(),
      delta("Let me look."),
      delta("\n\nIt is empty."),
      result({ result: "It is empty.", session_id: "sid-3" }),
      exit(),
    ]);
    const next = request([
      ["user", "hi"],
      ["assistant", "Let me look.\n\nIt is empty."],
      ["user", "and?"],
    ]);
    expect(store.lookup(next.conversation.historyKey()!)).toBe("sid-3");
  });

  it("asks for a retry when the saved session is gone before init", async () => {
    const req = request([
      ["user", "hi"],
      ["assistant", "Hello"],
      ["user", "more"],
    ]);
    const { outcome, events } = await run(req, await sessions(), true, [
      result({ subtype: "error_during_execution", is_error: true }),
      exit("Claude Code process exited with code 1"),
    ]);
    expect(outcome).toBe("resume_failed");
    expect(events).toEqual([]);
  });

  it("reports errors of a fresh session", async () => {
    const { outcome, events } = await run(request([["user", "hi"]]), await sessions(), false, [
      result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] }),
      exit(),
    ]);
    expect(outcome).toBe("done");
    expect(events).toEqual([{ type: "failed", error: { status: 502, message: "boom" } }]);
  });

  it("keeps the status of API errors", async () => {
    const { events } = await run(request([["user", "hi"]]), await sessions(), false, [
      init(),
      result({
        is_error: true,
        api_error_status: 400,
        result: "API Error: 400 Unable to download the file.",
      }),
      exit("exited with code 1"),
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "failed",
      error: { status: 400, message: "API Error: 400 Unable to download the file." },
    });
  });

  it("turns errors after a rejected limit into 429, but not after a warning", async () => {
    const limited = (status: string) =>
      run(request([["user", "hi"]]), undefined as never, false, [
        init(),
        { type: "rate_limit", info: { status } as never },
        result({ is_error: true, result: "You've hit your limit" }),
      ]);
    expect((await limited("rejected")).events[1]).toMatchObject({ error: { status: 429 } });
    expect((await limited("allowed_warning")).events[1]).toMatchObject({ error: { status: 502 } });
  });

  it("reports an exit without a result with the SDK error and stderr", async () => {
    const { events } = await run(request([["user", "hi"]]), await sessions(), false, [
      exit("Claude Code process exited with code 1", "Invalid API key · Please run /login"),
    ]);
    expect(events).toEqual([
      {
        type: "failed",
        error: {
          status: 502,
          message:
            "claude exited without a result: Claude Code process exited with code 1: Invalid API key · Please run /login",
        },
      },
    ]);
  });

  it("turns a silent agent into a 504", async () => {
    const { events } = await run(request([["user", "hi"]]), await sessions(), false, [
      init(),
      { type: "timeout" },
    ]);
    expect(events[1]).toMatchObject({ type: "failed", error: { status: 504 } });
  });
});

describe("startTurn", () => {
  it("replays the history into a fresh session when the saved one cannot be resumed", async () => {
    const calls: AgentOptions[] = [];
    const s = await state((o) => {
      calls.push(o);
      return o.resume !== undefined
        ? replay([result({ subtype: "error_during_execution", is_error: true }), exit()])
        : replay([
            init(),
            delta("Fine."),
            result({ result: "Fine.", session_id: "sid-new" }),
            exit(),
          ]);
    });
    const first = request([["user", "hi"]]);
    await s.sessions.remember(first.conversation.keyAfterReply("Hello"), "sid-old");

    const req = request([
      ["user", "hi"],
      ["assistant", "Hello"],
      ["user", "how are you?"],
    ]);
    const events: TurnEvent[] = [];
    for await (const e of startTurn(s, req, new AbortController().signal)) {
      events.push(e);
    }

    expect(calls.map((c) => c.resume)).toEqual(["sid-old", undefined]);
    expect(calls[0].prompt).toEqual([{ type: "text", text: "how are you?" }]);
    expect(JSON.stringify(calls[1].prompt)).toContain("<conversation_history>");
    expect(events.map((e) => e.type)).toEqual(["started", "delta", "finished"]);
  });

  it("passes the host's settings to the agent", async () => {
    let seen: AgentOptions | undefined;
    const s = await state((o) => {
      seen = o;
      return replay([init(), result({ result: "ok" }), exit()]);
    });
    const b = new ConversationBuilder();
    b.system("Be brief.");
    b.push("user", [text("hi")]);
    const req: TurnRequest = {
      requestId: "r",
      api: "anthropic",
      model: "sonnet",
      conversation: b.build(),
    };
    await Array.fromAsync(startTurn(s, req, new AbortController().signal));
    expect(seen).toMatchObject({
      model: "sonnet",
      systemPrompt: "Be brief.",
      cwd: "/tmp",
      permissionMode: "default",
      executable: "/bin/claude",
      resume: undefined,
    });
  });
});
