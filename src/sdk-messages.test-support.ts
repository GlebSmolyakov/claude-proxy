// SDK messages for tests, with only the fields the host reads.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const sdk = (message: object) => message as unknown as SDKMessage;
const stream = (event: object, parent: string | null = null) =>
  sdk({ type: "stream_event", event, parent_tool_use_id: parent });

export const MODEL = "claude-haiku-4-5-20251001";

export const init = (sessionId = "s") =>
  sdk({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: MODEL,
    claude_code_version: "2.1.274",
    permissionMode: "default",
  });
export const messageStart = (id: string) =>
  stream({ type: "message_start", message: { id, model: MODEL } });
export const text = (t: string, parent: string | null = null) =>
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, parent);
export const thinking = (t: string) =>
  stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: t } });
export const toolStart = (id: string, name: string) =>
  stream({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id, name, input: {} },
  });
export const messageDelta = (input: number, output: number, cacheRead = 0) =>
  stream({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: 0,
    },
  });
export const toolUse = (id: string, name: string, input: object, parent: string | null = null) =>
  sdk({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { model: MODEL, content: [{ type: "tool_use", id, name, input }] },
  });
export const toolResult = (id: string, content: unknown, isError = false, structured?: unknown) =>
  sdk({
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
    ...(structured !== undefined && { tool_use_result: structured }),
  });
export const result = (fields: object = {}) =>
  sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    modelUsage: {
      [MODEL]: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 20,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    },
    ...fields,
  });
