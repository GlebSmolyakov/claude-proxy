import { describe, expect, it } from "vitest";

import type { TurnEvent, TurnOutput } from "../turn.js";
import { AnthropicStream, message, type SseEvent } from "./cli-to-anthropic.js";
import { completion, finishReason, OpenAiStream } from "./cli-to-openai.js";

function output(t: string): TurnOutput {
  return {
    text: t,
    model: "claude-haiku-4-5-20251001",
    stopReason: "end_turn",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 100,
      output_tokens: 7,
    },
  };
}

const started: TurnEvent = { type: "started", model: "claude-haiku-4-5-20251001" };
const delta = (t: string): TurnEvent => ({ type: "delta", text: t });
const finished = (t: string): TurnEvent => ({ type: "finished", output: output(t) });

describe("OpenAI responses", () => {
  it("report the real model and usage", () => {
    const r = completion(output("Hi"), "abc");
    expect(r.id).toBe("chatcmpl-abc");
    expect(r.model).toBe("claude-haiku-4-5-20251001");
    expect(r.choices[0].message).toEqual({ role: "assistant", content: "Hi" });
    expect(r.choices[0].finish_reason).toBe("stop");
    expect(r.usage).toEqual({
      prompt_tokens: 115,
      completion_tokens: 7,
      total_tokens: 122,
      prompt_tokens_details: { cached_tokens: 100 },
    });
  });

  it("map finish reasons", () => {
    expect(finishReason("end_turn")).toBe("stop");
    expect(finishReason("max_tokens")).toBe("length");
    expect(finishReason("refusal")).toBe("content_filter");
  });

  it("stream deltas, a finish chunk and [DONE]", () => {
    const s = new OpenAiStream("abc", "haiku", false);
    expect(s.onEvent(started)).toEqual([]);
    const first = JSON.parse(s.onEvent(delta("Hel"))[0]);
    expect(first.model).toBe("claude-haiku-4-5-20251001");
    expect(first.choices[0].delta).toEqual({ role: "assistant", content: "Hel" });
    expect(JSON.parse(s.onEvent(delta("lo"))[0]).choices[0].delta).toEqual({ content: "lo" });

    const end = s.onEvent(finished("Hello"));
    expect(end).toHaveLength(2);
    expect(JSON.parse(end[0]).choices[0].finish_reason).toBe("stop");
    expect(end[1]).toBe("[DONE]");
    expect(s.onEvent(delta("late"))).toEqual([]);
    expect(s.onEnd()).toEqual([]);
  });

  it("add a usage chunk when asked", () => {
    const s = new OpenAiStream("abc", "haiku", true);
    s.onEvent(delta("Hi"));
    const end = s.onEvent(finished("Hi"));
    const u = JSON.parse(end[1]);
    expect(u.choices).toEqual([]);
    expect(u.usage.completion_tokens).toBe(7);
    expect(end[2]).toBe("[DONE]");
  });

  it("carry the text of a turn without deltas", () => {
    const end = new OpenAiStream("abc", "haiku", false).onEvent(finished("Hi"));
    expect(JSON.parse(end[0]).choices[0].delta.content).toBe("Hi");
    expect(end).toHaveLength(3);
  });

  it("end a failed or unfinished stream with an error and [DONE]", () => {
    const failed = new OpenAiStream("abc", "haiku", false).onEvent({
      type: "failed",
      error: { status: 429, message: "limit" },
    });
    expect(JSON.parse(failed[0]).error.type).toBe("rate_limit_error");
    expect(failed[1]).toBe("[DONE]");
    const unfinished = new OpenAiStream("abc", "haiku", false);
    unfinished.onEvent(delta("Hi"));
    expect(JSON.parse(unfinished.onEnd()[0]).error.type).toBe("server_error");
  });
});

describe("Anthropic responses", () => {
  const names = (events: SseEvent[]) => events.map(([name]) => name);
  const data = (event: SseEvent) => JSON.parse(event[1]);

  it("carry model, stop reason and usage", () => {
    const m = message({ ...output("Hi"), stopReason: "max_tokens" }, "abc");
    expect(m.id).toBe("msg_abc");
    expect(m.stop_reason).toBe("max_tokens");
    expect(m.content).toEqual([{ type: "text", text: "Hi" }]);
    expect(m.usage).toEqual({
      input_tokens: 10,
      output_tokens: 7,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 100,
    });
  });

  it("stream one text block between message start and stop", () => {
    const s = new AnthropicStream("abc", "haiku");
    expect(s.onEvent(started)).toEqual([]);
    const first = s.onEvent(delta("Hel"));
    expect(names(first)).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
    ]);
    expect(data(first[0]).message.model).toBe("claude-haiku-4-5-20251001");
    expect(data(first[3]).delta.text).toBe("Hel");
    expect(names(s.onEvent(delta("lo")))).toEqual(["content_block_delta"]);

    const end = s.onEvent(finished("Hello"));
    expect(names(end)).toEqual(["content_block_stop", "message_delta", "message_stop"]);
    expect(data(end[1]).delta.stop_reason).toBe("end_turn");
    expect(data(end[1]).usage.output_tokens).toBe(7);
    expect(s.onEnd()).toEqual([]);
  });

  it("carry the text of a turn without deltas", () => {
    expect(names(new AnthropicStream("abc", "haiku").onEvent(finished("Hi")))).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("end a failed or unfinished stream with an error event", () => {
    const s = new AnthropicStream("abc", "haiku");
    s.onEvent(delta("Hi"));
    const out = s.onEvent({ type: "failed", error: { status: 529, message: "busy" } });
    expect(names(out)).toEqual(["error"]);
    expect(data(out[0]).error.type).toBe("overloaded_error");
    expect(s.onEvent(delta("late"))).toEqual([]);
    expect(names(new AnthropicStream("abc", "haiku").onEnd())).toEqual(["error"]);
  });
});
