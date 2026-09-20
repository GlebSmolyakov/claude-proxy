// HTTP handlers and streaming.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { z } from "zod";

import { toConversation as anthropicConversation } from "./adapter/anthropic-to-cli.js";
import { AnthropicStream, message, type SseEvent } from "./adapter/cli-to-anthropic.js";
import { completion, OpenAiStream } from "./adapter/cli-to-openai.js";
import { toConversation as openaiConversation } from "./adapter/openai-to-cli.js";
import { Channel, TIMEOUT } from "./channel.js";
import { AppError } from "./errors.js";
import { log } from "./log.js";
import { ALIASES, resolveModel } from "./models.js";
import type { AppState } from "./server.js";
import { type ModelLimits, unixNow } from "./status.js";
import { startTurn, type TurnEvent, type TurnOutput } from "./turn.js";
import { MessagesRequest } from "./types/anthropic.js";
import { ChatCompletionRequest, type ModelInfo } from "./types/openai.js";

/**
 * How long a streaming response may hold its headers while waiting for the
 * first token. Errors that come before it (unknown model, exhausted limit,
 * bad image) then reach the client as a real HTTP status, not as an event
 * inside a 200 stream.
 */
const HEADER_WAIT_MS = 10_000;
/** A comment line keeps the stream alive while the agent works silently. */
const KEEP_ALIVE_MS = 15_000;
/** Base64 images make request bodies large. */
const BODY_LIMIT = 32 * 1024 * 1024;

function newRequestId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

export async function health(
  state: AppState,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  sendJson(res, 200, {
    status: "ok",
    uptime: state.status.uptimeSecs(),
    cli_version: state.status.cliVersion,
    workdir: state.cwd,
    permission_mode: state.permissionMode,
    saved_sessions: state.sessions.size,
    models: state.status.aliases(),
    // What the subscription has used, as of the last turn; null before it.
    rate_limits: state.status.rateLimits(),
  });
}

/** The aliases, plus every full model id a turn has run on. Limits appear once a turn has reported them. */
export async function models(
  state: AppState,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const aliases = state.status.aliases();
  const limits = state.status.models();
  const created = unixNow();
  const info = (id: string, facts: ModelLimits | undefined): ModelInfo => ({
    id,
    object: "model",
    owned_by: "anthropic",
    created,
    ...(facts?.context_window != null && { context_window: facts.context_window }),
    ...(facts?.max_output_tokens != null && { max_tokens: facts.max_output_tokens }),
  });
  const data = [
    ...ALIASES.map((alias) => info(alias, aliases[alias] ? limits[aliases[alias]] : undefined)),
    ...Object.entries(limits).map(([id, facts]) => info(id, facts)),
  ];
  sendJson(res, 200, { object: "list", data });
}

// ── OpenAI Chat Completions ─────────────────────────────────────

export async function chatCompletions(
  state: AppState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const request = parseBody(ChatCompletionRequest, await readBody(req));
    const conversation = openaiConversation(request);
    const model = resolveModel(request.model);
    const requestId = newRequestId();
    const stream = request.stream ?? false;
    log.info(
      `[req=${requestId}] OpenAI chat model=${model} stream=${stream} turns=${conversation.turns.length}${ignoredTools(request.tools)}`,
    );

    const events = startTurn(
      state,
      { requestId, api: "openai", model, conversation },
      abortOnDisconnect(res),
    );
    if (!stream) {
      const output = await collect(requestId, events);
      sendJson(res, 200, completion(output, requestId), requestId);
      return;
    }

    const first = await firstEvents(events);
    const writer = new OpenAiStream(
      requestId,
      model,
      request.stream_options?.include_usage ?? false,
    );
    const sse = new Sse(res, requestId);
    for (const event of first) {
      sse.data(writer.onEvent(event));
    }
    for await (const event of events) {
      sse.data(writer.onEvent(event));
    }
    sse.data(writer.onEnd());
    sse.end();
  } catch (e) {
    sendError(res, e, "openai");
  }
}

// ── Anthropic Messages ──────────────────────────────────────────

/** Errors on this route use Anthropic's error shape. */
export async function messages(
  state: AppState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const request = parseBody(MessagesRequest, await readBody(req));
    const conversation = anthropicConversation(request);
    const model = resolveModel(request.model);
    const requestId = newRequestId();
    const stream = request.stream ?? false;
    log.info(
      `[req=${requestId}] Anthropic messages model=${model} stream=${stream} turns=${conversation.turns.length}${ignoredTools(request.tools)}`,
    );

    const events = startTurn(
      state,
      { requestId, api: "anthropic", model, conversation },
      abortOnDisconnect(res),
    );
    if (!stream) {
      const output = await collect(requestId, events);
      sendJson(res, 200, message(output, requestId), requestId);
      return;
    }

    const first = await firstEvents(events);
    const writer = new AnthropicStream(requestId, model);
    const sse = new Sse(res, requestId);
    for (const event of first) {
      sse.named(writer.onEvent(event));
    }
    for await (const event of events) {
      sse.named(writer.onEvent(event));
    }
    sse.named(writer.onEnd());
    sse.end();
  } catch (e) {
    sendError(res, e, "anthropic");
  }
}

// ── Shared ──────────────────────────────────────────────────────

/** The agent brings its own tools; the client's are not passed on. */
function ignoredTools(tools: unknown[] | null | undefined): string {
  return tools?.length ? ` client_tools=${tools.length} (ignored)` : "";
}

/** Wait for the end of a non-streaming turn. */
async function collect(requestId: string, events: Channel<TurnEvent>): Promise<TurnOutput> {
  const start = performance.now();
  const elapsed = () => ((performance.now() - start) / 1000).toFixed(2);
  for await (const event of events) {
    if (event.type === "finished") {
      log.info(`[req=${requestId}] Complete after ${elapsed()}s`);
      return event.output;
    }
    if (event.type === "failed") {
      log.info(`[req=${requestId}] Failed after ${elapsed()}s`);
      throw AppError.upstream(event.error);
    }
  }
  throw AppError.internal("the turn ended without a result");
}

/**
 * Events up to the first token, the end of the turn, or `HEADER_WAIT_MS`,
 * whichever comes first. A failure in that window becomes the HTTP response.
 */
async function firstEvents(events: Channel<TurnEvent>): Promise<TurnEvent[]> {
  const deadline = Date.now() + HEADER_WAIT_MS;
  const seen: TurnEvent[] = [];
  for (;;) {
    const event = await events.recvUntil(deadline);
    if (event === TIMEOUT) {
      return seen;
    }
    if (event === undefined) {
      throw AppError.internal("the turn ended without a result");
    }
    if (event.type === "failed") {
      throw AppError.upstream(event.error);
    }
    seen.push(event);
    if (event.type !== "started") {
      return seen;
    }
  }
}

/** Aborted when the client goes away before the response is complete; the turn then stops the agent. */
function abortOnDisconnect(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  return controller.signal;
}

class Sse {
  private readonly keepAlive: NodeJS.Timeout;

  constructor(
    private readonly res: ServerResponse,
    requestId: string,
  ) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-request-id": requestId,
    });
    this.keepAlive = setInterval(() => this.write(":\n\n"), KEEP_ALIVE_MS);
    res.on("close", () => clearInterval(this.keepAlive));
  }

  data(payloads: string[]): void {
    for (const payload of payloads) {
      this.write(`data: ${payload}\n\n`);
    }
  }

  named(events: SseEvent[]): void {
    for (const [name, data] of events) {
      this.write(`event: ${name}\ndata: ${data}\n\n`);
    }
  }

  end(): void {
    clearInterval(this.keepAlive);
    if (!this.res.destroyed && !this.res.writableEnded) {
      this.res.end();
    }
  }

  private write(chunk: string): void {
    if (!this.res.destroyed && !this.res.writableEnded) {
      this.res.write(chunk);
    }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) {
      throw AppError.tooLarge(`request body is larger than ${BODY_LIMIT} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody<T>(schema: z.ZodType<T>, body: string): T {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw AppError.badRequest(`Failed to parse the request body as JSON: ${(e as Error).message}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw AppError.badRequest(`Invalid request body: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

function sendError(res: ServerResponse, e: unknown, api: "openai" | "anthropic"): void {
  if (!(e instanceof AppError)) {
    throw e;
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, e.status, api === "openai" ? e.openaiBody() : e.anthropicBody());
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId?: string,
): void {
  if (res.destroyed) {
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    ...(requestId !== undefined && { "x-request-id": requestId }),
  });
  res.end(JSON.stringify(body));
}
