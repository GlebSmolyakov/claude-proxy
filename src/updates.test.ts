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

const session = () => new Session("s", "/repo", [], {}, "default");

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
    expect(closed).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      rawOutput: "The file has been updated.",
    });
    expect(s.tools.size).toBe(0);
    expect(s.emitted.size).toBe(0);
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
        rawOutput: "exit 1",
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

  it("stays quiet about usage when no API call happened", () => {
    expect(new UpdateMapper(session()).map(result())).toEqual([]);
  });
});
