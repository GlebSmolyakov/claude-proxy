import { describe, expect, it } from "vitest";

import { text } from "../conversation.js";
import { MessagesRequest } from "../types/anthropic.js";
import { ChatCompletionRequest } from "../types/openai.js";
import { toConversation as anthropic } from "./anthropic-to-cli.js";
import { parseArguments, parseImageUrl, toConversation as openai } from "./openai-to-cli.js";

const fromOpenai = (body: unknown) => openai(ChatCompletionRequest.parse(body));
const fromAnthropic = (body: unknown) => anthropic(MessagesRequest.parse(body));

describe("OpenAI request", () => {
  it("takes a simple message", () => {
    const c = fromOpenai({ messages: [{ role: "user", content: "hi" }] });
    expect(c.system).toBe("");
    expect(c.last().blocks).toEqual([text("hi")]);
  });

  it("turns system and developer messages into the system prompt", () => {
    const c = fromOpenai({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "developer", content: [{ type: "text", text: "Use Russian." }] },
        { role: "user", content: "hi" },
      ],
    });
    expect(c.system).toBe("Be brief.\n\nUse Russian.");
    expect(c.turns).toHaveLength(1);
  });

  it("keeps images in both shapes", () => {
    const c = fromOpenai({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD", detail: "high" } },
            { type: "image_url", image_url: "https://x/y.jpg" },
          ],
        },
      ],
    });
    expect(c.last().blocks[1]).toEqual({
      type: "image",
      source: { kind: "base64", mediaType: "image/png", data: "QUJD" },
    });
    expect(c.last().blocks[2]).toEqual({
      type: "image",
      source: { kind: "url", url: "https://x/y.jpg" },
    });
  });

  it("accepts client tools without passing them on", () => {
    const c = fromOpenai({
      tools: [{ type: "function", function: { name: "read_file" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(c.last().blocks).toEqual([text("hi")]);
  });

  it("keeps tool calls and results of the history", () => {
    const c = fromOpenai({
      messages: [
        { role: "user", content: "what is in a.rs?" },
        {
          role: "assistant",
          content: "Let me look.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.rs"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "fn main() {}" },
      ],
    });
    expect(c.history()[1].blocks).toEqual([
      text("Let me look."),
      { type: "tool_use", call: { id: "call_1", name: "read_file", input: { path: "a.rs" } } },
    ]);
    expect(c.last().blocks).toEqual([
      { type: "tool_result", toolUseId: "call_1", content: [text("fn main() {}")], isError: false },
    ]);
  });

  it("keeps arguments that are not JSON as a string", () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments("not json")).toBe("not json");
    expect(parseArguments({ a: 1 })).toEqual({ a: 1 });
    expect(parseArguments(null)).toEqual({});
    expect(parseArguments("")).toEqual({});
  });

  it("rejects bad requests", () => {
    expect(() => fromOpenai({ messages: [] })).toThrow();
    expect(() => fromOpenai({})).toThrow();
    expect(() =>
      fromOpenai({
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ],
      }),
    ).toThrow();
    expect(() =>
      fromOpenai({ messages: [{ role: "user", content: [{ type: "input_audio" }] }] }),
    ).toThrow("content part type 'input_audio' is not supported");
  });

  it("parses image URLs", () => {
    expect(() => parseImageUrl("data:image/png;base64,AAAA")).not.toThrow();
    expect(() => parseImageUrl("data:image/png,AAAA")).toThrow();
    expect(() => parseImageUrl("data:text/plain;base64,AAAA")).toThrow();
    expect(() => parseImageUrl("data:image/png;base64")).toThrow();
    expect(() => parseImageUrl("file:///etc/passwd")).toThrow();
  });
});

describe("Anthropic request", () => {
  it("takes a string system prompt and joins system blocks", () => {
    expect(
      fromAnthropic({ system: "Be brief.", messages: [{ role: "user", content: "hi" }] }).system,
    ).toBe("Be brief.");
    const c = fromAnthropic({
      system: [
        { type: "text", text: "One.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Two." },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(c.system).toBe("One.\nTwo.");
  });

  it("keeps images in both source shapes", () => {
    const c = fromAnthropic({
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
            { type: "image", source: { type: "url", url: "https://x/y.png" } },
            { type: "text", text: "compare" },
          ],
        },
      ],
    });
    expect(c.last().blocks[0]).toEqual({
      type: "image",
      source: { kind: "base64", mediaType: "image/png", data: "QUJD" },
    });
    expect(c.last().blocks[1]).toEqual({
      type: "image",
      source: { kind: "url", url: "https://x/y.png" },
    });
  });

  it("keeps tool use and results of the history and drops thinking", () => {
    const c = fromAnthropic({
      tools: [{ name: "weather", input_schema: { type: "object" } }],
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hm" },
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "t", name: "weather", input: { city: "Lisbon" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: "sunny" }] },
            { type: "tool_result", tool_use_id: "u", content: "no such file", is_error: true },
          ],
        },
      ],
    });
    expect(c.history()[1].blocks).toEqual([
      text("Checking."),
      { type: "tool_use", call: { id: "t", name: "weather", input: { city: "Lisbon" } } },
    ]);
    expect(c.last().blocks).toEqual([
      { type: "tool_result", toolUseId: "t", content: [text("sunny")], isError: false },
      { type: "tool_result", toolUseId: "u", content: [text("no such file")], isError: true },
    ]);
  });

  it("rejects bad requests", () => {
    expect(() => fromAnthropic({ messages: [] })).toThrow();
    expect(() => fromAnthropic({ messages: [{ role: "system", content: "x" }] })).toThrow();
    const user = (content: unknown) => fromAnthropic({ messages: [{ role: "user", content }] });
    expect(() => user([{ type: "image", source: { type: "file", file_id: "f" } }])).toThrow();
    expect(() => user([{ type: "document", source: {} }])).toThrow();
    expect(() => user([{ type: "tool_result", content: "x" }])).toThrow("tool_use_id");
  });
});
