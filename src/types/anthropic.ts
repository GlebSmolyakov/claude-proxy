// Anthropic Messages: the request as the proxy reads it, and the response
// shapes it writes.

import { z } from "zod";

// ── Request ────────────────────────────────────────────────────

/**
 * One content block. Only the fields of the block types the proxy reads are
 * declared: `text`, `image` (`source`), `tool_use` (`id`, `name`, `input`)
 * and `tool_result` (`tool_use_id`, `content`, `is_error`).
 */
const ContentBlock = z.object({
  type: z.string(),
  text: z.string().nullish(),
  source: z.unknown().optional(),
  id: z.string().nullish(),
  name: z.string().nullish(),
  input: z.unknown().optional(),
  tool_use_id: z.string().nullish(),
  content: z.unknown().optional(),
  is_error: z.boolean().nullish(),
});
export type ContentBlock = z.infer<typeof ContentBlock>;

export const Content = z.union([z.string(), z.array(ContentBlock)]);
export type Content = z.infer<typeof Content>;

/**
 * `max_tokens`, `temperature` and other sampling fields are accepted and
 * ignored: the CLI chooses them itself. `tools` are ignored too: the agent
 * works with its own.
 */
export const MessagesRequest = z.object({
  model: z.string().nullish(),
  messages: z.array(z.object({ role: z.string(), content: Content })),
  stream: z.boolean().nullish(),
  system: Content.nullish(),
  tools: z.array(z.unknown()).nullish(),
});
export type MessagesRequest = z.infer<typeof MessagesRequest>;

// ── Response ───────────────────────────────────────────────────

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface MessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: { type: "text"; text: string }[];
  model: string;
  stop_reason: string;
  stop_sequence: null;
  usage: Usage;
}
