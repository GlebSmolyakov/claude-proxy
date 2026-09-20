// Turn results → OpenAI chat completion responses and stream chunks.

import { AppError } from "../errors.js";
import { unixNow } from "../status.js";
import type { TurnEvent, TurnOutput, TurnUsage } from "../turn.js";
import type { ChatCompletionChunk, ChatCompletionResponse, Usage } from "../types/openai.js";

export function completion(output: TurnOutput, requestId: string): ChatCompletionResponse {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: unixNow(),
    model: output.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: output.text },
        finish_reason: finishReason(output.stopReason),
      },
    ],
    usage: usage(output.usage),
  };
}

/** Messages API stop reason → OpenAI finish reason. */
export function finishReason(stopReason: string): string {
  switch (stopReason) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

/**
 * OpenAI counts cached input inside `prompt_tokens` and reports it again
 * under `prompt_tokens_details.cached_tokens`.
 */
export function usage(u: TurnUsage): Usage {
  const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output_tokens,
    total_tokens: prompt + u.output_tokens,
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens },
  };
}

/** Turns `TurnEvent`s into the `data:` payloads of an OpenAI SSE stream. */
export class OpenAiStream {
  private readonly id: string;
  private readonly created = unixNow();
  private sentRole = false;
  private closed = false;

  constructor(
    requestId: string,
    private model: string,
    private readonly includeUsage: boolean,
  ) {
    this.id = `chatcmpl-${requestId}`;
  }

  onEvent(event: TurnEvent): string[] {
    if (this.closed) {
      return [];
    }
    switch (event.type) {
      case "started":
        this.model = event.model;
        return [];
      case "delta":
        return [this.delta(event.text)];
      case "finished": {
        const output = event.output;
        const out: string[] = [];
        this.model = output.model;
        if (!this.sentRole && output.text !== "") {
          out.push(this.delta(output.text));
        }
        out.push(
          this.chunk([
            {
              index: 0,
              delta: this.sentRole ? {} : { role: "assistant" },
              finish_reason: finishReason(output.stopReason),
            },
          ]),
        );
        if (this.includeUsage) {
          out.push(this.chunk([], usage(output.usage)));
        }
        out.push("[DONE]");
        this.closed = true;
        return out;
      }
      case "failed":
        this.closed = true;
        return [JSON.stringify(AppError.upstream(event.error).openaiBody()), "[DONE]"];
    }
  }

  /** Called when the events run out; closes a stream that never finished. */
  onEnd(): string[] {
    if (this.closed) {
      return [];
    }
    this.closed = true;
    const error = AppError.internal("the turn ended without a result");
    return [JSON.stringify(error.openaiBody()), "[DONE]"];
  }

  private delta(content: string): string {
    const role = this.sentRole ? {} : { role: "assistant" as const };
    this.sentRole = true;
    return this.chunk([{ index: 0, delta: { ...role, content }, finish_reason: null }]);
  }

  private chunk(choices: ChatCompletionChunk["choices"], u?: Usage): string {
    const chunk: ChatCompletionChunk = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices,
      ...(u && { usage: u }),
    };
    return JSON.stringify(chunk);
  }
}
