import { describe, expect, it } from "vitest";

import {
  init,
  messageDelta,
  messageStart,
  result,
  text,
  thinking,
  toolResult,
  toolStart,
  toolUse,
} from "./sdk-messages.test-support.js";
import { Session } from "./session.js";
import { UpdateMapper } from "./updates.js";

const session = () => new Session("s", "/repo", [], {}, "default", undefined);

describe("UpdateMapper", () => {
  it("streams text and thinking as chunks of one message", () => {
    const m = new UpdateMapper(session());
    expect(m.map(init())).toEqual([]);
    expect(m.map(messageStart("msg_1"))).toEqual([]);
    expect(m.map(thinking("hm"))).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hm" },
        messageId: "msg_1",
      },
    ]);
    expect(m.map(text("Hi"))).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hi" },
        messageId: "msg_1",
      },
    ]);
    expect(m.map(text("sub", "toolu_parent"))).toEqual([]);
  });

  it("opens a card at the start of a call, fills it with the input, closes it with the result", () => {
    const s = session();
    const m = new UpdateMapper(s);
    const [opened] = m.map(toolStart("t1", "Edit"));
    expect(opened).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Edit",
      kind: "edit",
      status: "pending",
    });

    const [filled] = m.map(
      toolUse("t1", "Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }),
    );
    expect(filled).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "Edit a.ts",
      content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }],
      _meta: { claudeCode: { toolName: "Edit" } },
    });

    const [closed] = m.map(toolResult("t1", "The file has been updated."));
    // An edit keeps its diff on the card, so the raw result is what it adds.
    expect(closed).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: "The file has been updated.",
    });
    expect(s.tools.size).toBe(0);
    expect(s.emitted.size).toBe(0);
  });

  it("says text the agent never streamed, such as a slash command's answer", () => {
    const m = new UpdateMapper(session());
    m.map(messageStart("msg_1"));
    m.map(text("Streamed."));
    const complete = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "msg_1", content: [{ type: "text", text: "Streamed." }] },
    } as unknown as Parameters<UpdateMapper["map"]>[0];
    expect(m.map(complete)).toEqual([]);

    const synthetic = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_2",
        model: "<synthetic>",
        content: [{ type: "text", text: "Total cost: $0.10" }],
      },
    } as unknown as Parameters<UpdateMapper["map"]>[0];
    expect(m.map(synthetic)).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Total cost: $0.10" },
        messageId: "msg_2",
      },
    ]);
  });

  it("leaves the terminal of a command on its card", () => {
    const s = session();
    const m = new UpdateMapper(s);
    m.map(toolUse("t1", "Bash", { command: "ls" }));
    s.terminalCalls.add("t1");
    expect(m.map(toolResult("t1", "a.ts\n"))).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: "a.ts\n",
      },
    ]);
  });

  it("marks failed calls and shows their error", () => {
    const m = new UpdateMapper(session());
    m.map(toolUse("t1", "Bash", { command: "false" }));
    expect(m.map(toolResult("t1", "exit 1", true))).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "```\nexit 1\n```" } }],
      },
    ]);
  });

  it("shows the calls of subagents under their parent", () => {
    const [card] = new UpdateMapper(session()).map(
      toolUse("t2", "Read", { file_path: "/repo/a.ts" }, "t1"),
    );
    expect(card).toMatchObject({
      sessionUpdate: "tool_call",
      _meta: { claudeCode: { parentToolUseId: "t1" } },
    });
  });

  it("turns TodoWrite and Task tools into the plan instead of cards", () => {
    const m = new UpdateMapper(session());
    expect(m.map(toolStart("t1", "TodoWrite"))).toEqual([]);
    expect(
      m.map(toolUse("t1", "TodoWrite", { todos: [{ content: "A", status: "pending" }] })),
    ).toEqual([
      { sessionUpdate: "plan", entries: [{ content: "A", status: "pending", priority: "medium" }] },
    ]);
    expect(m.map(toolResult("t1", "ok"))).toEqual([]);

    expect(m.map(toolUse("t2", "TaskCreate", { subject: "B" }))).toEqual([]);
    expect(
      m.map(toolResult("t2", "Task #7 created successfully: B", false, { task: { id: "7" } })),
    ).toEqual([
      { sessionUpdate: "plan", entries: [{ content: "B", status: "pending", priority: "medium" }] },
    ]);
  });

  it("reports the context after every API call and the cost at the end", () => {
    const s = session();
    const m = new UpdateMapper(s);
    m.map(messageStart("msg_1"));
    expect(m.map(messageDelta(100, 20, 1000))).toEqual([
      { sessionUpdate: "usage_update", used: 1120, size: 200_000 },
    ]);
    const window = {
      contextWindow: 1_000_000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    expect(
      m.map(result({ modelUsage: { "claude-haiku-4-5-20251001": window }, total_cost_usd: 0.02 })),
    ).toEqual([
      {
        sessionUpdate: "usage_update",
        used: 1120,
        size: 1_000_000,
        cost: { amount: 0.02, currency: "USD" },
      },
    ]);
    expect(s.contextWindow).toBe(1_000_000);
  });

  it("reports the smaller context left after compaction", () => {
    const s = session();
    const m = new UpdateMapper(s);
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 190_000, post_tokens: 40_000 },
    } as unknown as Parameters<UpdateMapper["map"]>[0];
    expect(m.map(boundary)).toEqual([
      { sessionUpdate: "usage_update", used: 40_000, size: 200_000 },
    ]);
    // The turn's result then reports the same context, now with its cost.
    expect(m.map(result())).toMatchObject([
      { used: 40_000, cost: { amount: 0.01, currency: "USD" } },
    ]);
  });

  it("carries the text of complete messages when replaying a saved conversation", () => {
    const m = new UpdateMapper(session(), { replay: true });
    const user = {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    } as unknown as Parameters<UpdateMapper["map"]>[0];
    const assistant = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "msg_1",
        content: [
          { type: "thinking", thinking: "hm" },
          { type: "text", text: "Hello" },
        ],
      },
    } as unknown as Parameters<UpdateMapper["map"]>[0];
    expect(m.map(user)).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
    ]);
    expect(m.map(assistant)).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "hm" },
        messageId: "msg_1",
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" },
        messageId: "msg_1",
      },
    ]);
  });

  it("rebuilds the plan while replaying a saved conversation", () => {
    const s = session();
    const m = new UpdateMapper(s, { replay: true });
    m.map(toolUse("t1", "TaskCreate", { subject: "Read code", activeForm: "Reading code" }));
    m.map(toolResult("t1", "Task #1 created successfully: Read code"));
    m.map(toolUse("t2", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    const last = m.map(toolResult("t2", "ok"));
    expect(last).toEqual([
      {
        sessionUpdate: "plan",
        entries: [{ content: "Reading code", status: "in_progress", priority: "medium" }],
      },
    ]);
    expect(s.plan.entries()).toHaveLength(1);
  });

  it("says how much of the subscription is spent, once per threshold", () => {
    const m = new UpdateMapper(session());
    const limit = (used: number) =>
      ({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: { five_hour: { utilization: used } },
        },
      }) as unknown as Parameters<UpdateMapper["map"]>[0];

    expect(m.map(limit(0.4))).toEqual([]);
    const [said] = m.map(limit(0.84));
    // A message of its own, so it does not run into the agent's words.
    expect(said).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      messageId: "quota-five_hour-84",
    });
    expect((said as { content: { text: string } }).content.text).toContain(
      "five-hour limit is 84% used",
    );
    expect(m.map(limit(0.9))).toEqual([]);
  });

  it("leaves a message being streamed alone when the subscription speaks", () => {
    const m = new UpdateMapper(session());
    m.map(messageStart("msg_1"));
    m.map({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.85 } } },
    } as unknown as Parameters<UpdateMapper["map"]>[0]);

    const [chunk] = m.map(text("Hello"));
    expect(chunk).toMatchObject({ messageId: "msg_1" });
    // The streamed text is not said a second time when the whole message arrives.
    const complete = {
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: "msg_1", content: [{ type: "text", text: "Hello" }] },
    } as unknown as Parameters<UpdateMapper["map"]>[0];
    expect(m.map(complete)).toEqual([]);
  });

  it("does not let a replayed user message join the answer before it", () => {
    const m = new UpdateMapper(session(), { replay: true });
    const assistant = (id: string, said: string) =>
      ({
        type: "assistant",
        parent_tool_use_id: null,
        message: { id, content: [{ type: "text", text: said }] },
      }) as unknown as Parameters<UpdateMapper["map"]>[0];
    const user = (said: string) =>
      ({
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: said },
      }) as unknown as Parameters<UpdateMapper["map"]>[0];

    m.map(user("what is in a.ts?"));
    expect(m.map(assistant("msg_1", "An empty module."))[0]).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      messageId: "msg_1",
    });
    const [said] = m.map(user("and b.ts?"));
    expect(said).toEqual({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "and b.ts?" },
    });
    // The answer that follows is a message of its own, not more of msg_1.
    expect(m.map(assistant("msg_2", "Also empty."))[0]).toMatchObject({ messageId: "msg_2" });
  });

  it("marks where the conversation was compacted, for an editor that keeps room for it", () => {
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 20_000 },
    } as unknown as Parameters<UpdateMapper["map"]>[0];

    expect(new UpdateMapper(session(), { compaction: true }).map(boundary)).toEqual([
      { sessionUpdate: "compaction_update", compactionId: expect.any(String), status: "completed" },
      { sessionUpdate: "usage_update", used: 20_000, size: 200_000 },
    ]);
    // Compaction is an extension; an editor that did not ask hears only how
    // much smaller the context became.
    expect(new UpdateMapper(session()).map(boundary)).toEqual([
      { sessionUpdate: "usage_update", used: 20_000, size: 200_000 },
    ]);
  });

  it("stays quiet about usage when no API call happened", () => {
    expect(new UpdateMapper(session()).map(result())).toEqual([]);
  });
});
