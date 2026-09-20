// One chat turn from start to finish: continue a saved session or start a
// fresh one, run the agent, relay what it says, and remember the session for
// the next turn. Routes only format the resulting `TurnEvent`s.
//
// The agent runs its tool loop itself, so a turn is one HTTP request from
// the prompt to the final answer; nothing waits between requests.

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentEvent } from "./agent.js";
import { Channel } from "./channel.js";
import type { Conversation } from "./conversation.js";
import type { TurnError } from "./errors.js";
import { log } from "./log.js";
import type { AppState } from "./server.js";
import type { SessionStore } from "./session.js";
import type { RuntimeStatus } from "./status.js";

export type TurnEvent =
  /** The agent started; `model` is the real model id. */
  | { type: "started"; model: string }
  | { type: "delta"; text: string }
  | { type: "finished"; output: TurnOutput }
  | { type: "failed"; error: TurnError };

/** Token counts in the Messages API's own snake_case shape. */
export interface TurnUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface TurnOutput {
  text: string;
  model: string;
  /** Messages API stop reason of the last call: `end_turn`, `max_tokens`, … */
  stopReason: string;
  /** Tokens of the whole run: every API call, subagents included. */
  usage: TurnUsage;
}

export interface TurnRequest {
  requestId: string;
  api: "openai" | "anthropic";
  /** An alias or a full model id. */
  model: string;
  conversation: Conversation;
}

/** Start the turn in the background and return its events. */
export function startTurn(
  state: AppState,
  request: TurnRequest,
  signal: AbortSignal,
): Channel<TurnEvent> {
  const events = new Channel<TurnEvent>();
  drive(state, request, events, signal)
    .catch((e: unknown) => {
      const error = {
        status: 500,
        message: `the turn failed: ${(e as Error).message ?? String(e)}`,
      };
      logFailure(request.requestId, error);
      events.send({ type: "failed", error });
    })
    .finally(() => events.close());
  return events;
}

async function drive(
  state: AppState,
  request: TurnRequest,
  events: Channel<TurnEvent>,
  signal: AbortSignal,
): Promise<void> {
  const rid = request.requestId;
  const conversation = request.conversation;
  const key = conversation.historyKey();
  let resume = key !== undefined ? state.sessions.lookup(key) : undefined;
  if (key !== undefined && resume === undefined) {
    log.info(`[req=${rid}] History not seen before, replaying it into a fresh session`);
  }

  for (;;) {
    const run = state.runAgent({
      requestId: rid,
      api: request.api,
      model: request.model,
      systemPrompt: conversation.system,
      resume,
      cwd: state.cwd,
      permissionMode: state.permissionMode,
      executable: state.executable,
      prompt: resume !== undefined ? conversation.continuationInput() : conversation.freshInput(),
      signal,
    });
    const ctx = {
      sessions: state.sessions,
      status: state.status,
      request,
      resuming: resume !== undefined,
    };
    if ((await relay(ctx, run, events)) === "done") {
      return;
    }
    log.warn(`[req=${rid}] Saved session could not be resumed, replaying the history instead`);
    resume = undefined;
  }
}

export interface RelayCtx {
  sessions: SessionStore;
  status: RuntimeStatus;
  request: TurnRequest;
  resuming: boolean;
}

/** `resume_failed`: the saved session is gone, and nothing reached the client yet. */
export async function relay(
  ctx: RelayCtx,
  run: AsyncIterable<AgentEvent>,
  events: Channel<TurnEvent>,
): Promise<"done" | "resume_failed"> {
  const rid = ctx.request.requestId;
  let model = ctx.request.model;
  let started = false;
  let answered = false;
  let limitRejected = false;
  let streamed = "";
  const fail = (error: TurnError) => {
    logFailure(rid, error);
    events.send({ type: "failed", error });
    answered = true;
  };

  for await (const event of run) {
    switch (event.type) {
      case "init":
        log.info(`[req=${rid}] Session ${event.sessionId} on ${event.model}`);
        if (event.model !== "") {
          ctx.status.recordModel(ctx.request.model, event.model);
          model = event.model;
        }
        started = true;
        events.send({ type: "started", model });
        break;
      case "text_delta":
        streamed += event.text;
        events.send({ type: "delta", text: event.text });
        break;
      case "rate_limit":
        limitRejected = event.info.status === "rejected";
        ctx.status.recordRateLimit(event.info);
        break;
      case "result": {
        const result = event.result;
        ctx.status.recordModelUsage(result.modelUsage ?? {});
        if (result.is_error) {
          if (ctx.resuming && !started) {
            return "resume_failed";
          }
          fail(errorFromResult(result, limitRejected));
          break;
        }
        const output: TurnOutput = {
          text: (result.subtype === "success" && result.result) || streamed,
          model,
          stopReason: result.stop_reason ?? "end_turn",
          usage: usageOf(result),
        };
        if (result.session_id) {
          await remember(
            ctx.sessions,
            ctx.request.conversation,
            output.text,
            streamed,
            result.session_id,
          );
        }
        events.send({ type: "finished", output });
        answered = true;
        break;
      }
      case "timeout":
        if (!answered) {
          fail({ status: 504, message: "claude produced no output for 30 minutes" });
        }
        break;
      case "exit":
        if (!answered) {
          if (ctx.resuming && !started) {
            return "resume_failed";
          }
          const parts = ["claude exited without a result", event.error, event.stderrTail].filter(
            Boolean,
          );
          fail({ status: 502, message: parts.join(": ") });
        }
        return "done";
    }
  }
  return "done";
}

/**
 * Remember the session under the key the client's next request will carry.
 * Streaming clients rebuild the reply from deltas, and those carry the text
 * of every step, while the result holds only the last one; when the two
 * differ, both are registered.
 */
async function remember(
  sessions: SessionStore,
  conversation: Conversation,
  reply: string,
  streamed: string,
  sessionId: string,
): Promise<void> {
  await sessions.remember(conversation.keyAfterReply(reply), sessionId);
  if (streamed.trim() !== "" && streamed.trim() !== reply.trim()) {
    await sessions.remember(conversation.keyAfterReply(streamed), sessionId);
  }
}

/** Every model the run called, from `modelUsage`; `usage` covers the main loop only. */
function usageOf(result: SDKResultMessage): TurnUsage {
  const models = Object.values(result.modelUsage ?? {});
  if (models.length === 0) {
    return {
      input_tokens: result.usage?.input_tokens ?? 0,
      cache_creation_input_tokens: result.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: result.usage?.cache_read_input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
    };
  }
  const total: TurnUsage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  for (const m of models) {
    total.input_tokens += m.inputTokens;
    total.cache_creation_input_tokens += m.cacheCreationInputTokens;
    total.cache_read_input_tokens += m.cacheReadInputTokens;
    total.output_tokens += m.outputTokens;
  }
  return total;
}

/**
 * Every failure reaches the log with its message: a streaming client gets
 * it inside the stream, where it would otherwise be seen by no one else.
 */
function logFailure(requestId: string, error: TurnError): void {
  log.warn(`[req=${requestId}] Failed with ${error.status}: ${error.message}`);
}

export function errorFromResult(result: SDKResultMessage, limitRejected: boolean): TurnError {
  const reported = result.subtype === "success" ? result.result : result.errors?.join("; ");
  const message = reported?.trim()
    ? reported
    : `claude reported an error (${result.subtype ?? "unknown"})`;
  const apiStatus = result.subtype === "success" ? result.api_error_status : undefined;
  const status =
    apiStatus != null && apiStatus >= 400 && apiStatus < 600
      ? apiStatus
      : limitRejected
        ? 429
        : 502;
  return { status, message };
}
