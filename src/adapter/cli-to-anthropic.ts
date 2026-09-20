// Turn results → Anthropic Messages responses and stream events.

import { AppError } from "../errors.js";
import type { TurnEvent, TurnOutput, TurnUsage } from "../turn.js";
import type { MessagesResponse, Usage } from "../types/anthropic.js";

/** An SSE event name and its data. */
export type SseEvent = [name: string, data: string];

export function message(output: TurnOutput, requestId: string): MessagesResponse {
  return {
    id: `msg_${requestId}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: output.text }],
    model: output.model,
    stop_reason: output.stopReason,
    stop_sequence: null,
    usage: usage(output.usage),
  };
}

export function usage(u: TurnUsage): Usage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
  };
}

const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/**
 * Turns `TurnEvent`s into named SSE events of an Anthropic stream:
 * `message_start`, `ping`, one text block opened, filled and stopped, then
 * `message_delta` and `message_stop`.
 */
export class AnthropicStream {
  private readonly id: string;
  private started = false;
  private textOpen = false;
  private wroteText = false;
  private closed = false;

  constructor(
    requestId: string,
    private model: string,
  ) {
    this.id = `msg_${requestId}`;
  }

  onEvent(event: TurnEvent): SseEvent[] {
    if (this.closed) {
      return [];
    }
    switch (event.type) {
      case "started":
        this.model = event.model;
        return [];
      case "delta":
        return [...this.start(), ...this.text(event.text)];
      case "finished": {
        const output = event.output;
        if (!this.started) {
          this.model = output.model;
        }
        const out = this.start();
        if (!this.wroteText) {
          out.push(...this.text(output.text));
        }
        if (this.textOpen) {
          out.push(eventOf("content_block_stop", { type: "content_block_stop", index: 0 }));
          this.textOpen = false;
        }
        out.push(
          eventOf("message_delta", {
            type: "message_delta",
            delta: { stop_reason: output.stopReason, stop_sequence: null },
            usage: usage(output.usage),
          }),
          eventOf("message_stop", { type: "message_stop" }),
        );
        this.closed = true;
        return out;
      }
      case "failed":
        this.closed = true;
        return [eventOf("error", AppError.upstream(event.error).anthropicBody())];
    }
  }

  /** Called when the events run out; closes a stream that never finished. */
  onEnd(): SseEvent[] {
    if (this.closed) {
      return [];
    }
    this.closed = true;
    return [eventOf("error", AppError.internal("the turn ended without a result").anthropicBody())];
  }

  /** `message_start` and `ping`, once. */
  private start(): SseEvent[] {
    if (this.started) {
      return [];
    }
    this.started = true;
    return [
      eventOf("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          // Real counts arrive with message_delta.
          usage: ZERO_USAGE,
        },
      }),
      eventOf("ping", { type: "ping" }),
    ];
  }

  /** A text delta, opening the text block first if needed. */
  private text(s: string): SseEvent[] {
    const out: SseEvent[] = [];
    if (!this.textOpen) {
      this.textOpen = true;
      out.push(
        eventOf("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
    }
    this.wroteText = true;
    out.push(
      eventOf("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: s },
      }),
    );
    return out;
  }
}

function eventOf(name: string, data: object): SseEvent {
  return [name, JSON.stringify(data)];
}
