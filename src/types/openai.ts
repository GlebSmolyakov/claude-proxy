// OpenAI Chat Completions: the request as the proxy reads it, and the
// response shapes it writes.

import { z } from "zod";

// ── Request ────────────────────────────────────────────────────

/** `{"url": "..."}` per the spec; some clients send the URL as a bare string. */
const ImageUrl = z.union([z.string(), z.object({ url: z.string() })]);

const ContentPart = z.object({
  type: z.string(),
  text: z.string().nullish(),
  image_url: ImageUrl.nullish(),
});

/** Message content is a plain string or an array of parts. */
export const MessageContent = z.union([z.string(), z.array(ContentPart)]);
export type MessageContent = z.infer<typeof MessageContent>;

const Message = z.object({
  role: z.string(),
  content: MessageContent.nullish(),
  /** On assistant messages: tools the model called. */
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        function: z.object({
          name: z.string(),
          /** A JSON string per the spec; some clients send the object itself. */
          arguments: z.unknown().optional(),
        }),
      }),
    )
    .nullish(),
  /** On `tool` messages: the call this result answers. */
  tool_call_id: z.string().nullish(),
});

/**
 * `max_tokens`, `temperature` and other sampling fields are accepted and
 * ignored: the CLI chooses them itself. `tools` are ignored too: the agent
 * works with its own.
 */
export const ChatCompletionRequest = z.object({
  model: z.string().nullish(),
  messages: z.array(Message).nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.object({ include_usage: z.boolean().nullish() }).nullish(),
  tools: z.array(z.unknown()).nullish(),
});
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

// ── Response ───────────────────────────────────────────────────

export interface Usage {
  /** All input tokens, cached or not, as OpenAI counts them. */
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }[];
  usage: Usage;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: "assistant"; content?: string };
    finish_reason: string | null;
  }[];
  /** Only on the extra last chunk requested with `stream_options.include_usage`. */
  usage?: Usage;
}

export interface ModelInfo {
  id: string;
  object: "model";
  owned_by: "anthropic";
  created: number;
  /** Known once a turn has used the model. */
  context_window?: number;
  max_tokens?: number;
}
