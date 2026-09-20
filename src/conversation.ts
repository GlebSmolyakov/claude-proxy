// Provider-neutral view of a chat request.
//
// Both adapters (OpenAI and Anthropic) turn their request into a
// `Conversation`: one system prompt and alternating user and assistant
// turns. From it the turn runner builds the agent's prompt, and the session
// store derives the keys that tie a conversation prefix to a saved session.

import { createHash } from "node:crypto";

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

import { AppError } from "./errors.js";

export type Role = "user" | "assistant";

export type ImageSource =
  { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string };

/** A tool call from the conversation's history. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  /** In an assistant turn: a tool call the model made. */
  | { type: "tool_use"; call: ToolCall }
  /** In a user turn: what the tool returned, as text and images. */
  | { type: "tool_result"; toolUseId: string; content: Block[]; isError: boolean };

export interface Turn {
  role: Role;
  blocks: Block[];
}

export const text = (s: string): Block => ({ type: "text", text: s });

/**
 * Collects messages in request order. Consecutive messages with the same
 * role merge into one turn, because the CLI, like the Messages API, expects
 * user and assistant turns to alternate.
 */
export class ConversationBuilder {
  private readonly systemParts: string[] = [];
  private readonly turns: Turn[] = [];

  system(s: string): void {
    if (s.trim() !== "") {
      this.systemParts.push(s);
    }
  }

  push(role: Role, blocks: Block[]): void {
    const kept = blocks.filter((b) => !(b.type === "text" && b.text.trim() === ""));
    if (kept.length === 0) {
      return;
    }
    const last = this.turns.at(-1);
    if (last?.role === role) {
      last.blocks.push(...kept);
    } else {
      this.turns.push({ role, blocks: kept });
    }
  }

  build(): Conversation {
    const last = this.turns.at(-1);
    if (!last) {
      throw AppError.badRequest("messages must contain at least one non-empty message");
    }
    if (last.role !== "user") {
      throw AppError.badRequest("the last message must come from the user");
    }
    return new Conversation(this.systemParts.join("\n\n"), this.turns);
  }
}

/**
 * A validated conversation: at least one turn, and the last turn comes from
 * the user.
 */
export class Conversation {
  constructor(
    readonly system: string,
    readonly turns: readonly Turn[],
  ) {}

  /** Everything before the new user message. */
  history(): readonly Turn[] {
    return this.turns.slice(0, -1);
  }

  /** The new user message. */
  last(): Turn {
    return this.turns[this.turns.length - 1];
  }

  /** Key of the history, or `undefined` when this is the first message. */
  historyKey(): string | undefined {
    const history = this.history();
    return history.length === 0 ? undefined : keyOf(this.system, history);
  }

  /**
   * The key the next request's history will hash to once the client has
   * received `reply` and sends it back as the assistant turn.
   */
  keyAfterReply(reply: string): string {
    return keyOf(this.system, [...this.turns, { role: "assistant", blocks: [text(reply)] }]);
  }

  /** The prompt when a saved session already holds the history: only the new message. */
  continuationInput(): ContentBlockParam[] {
    return render(this.last().blocks).map(blockParam);
  }

  /**
   * The prompt for a fresh session. Without history this is the message
   * itself. With history, the earlier turns are replayed as a transcript
   * inside one message, because the CLI cannot be handed prior assistant
   * turns directly. Images keep their place; tool calls and results become
   * tagged text.
   */
  freshInput(): ContentBlockParam[] {
    const history = this.history();
    if (history.length === 0) {
      return this.continuationInput();
    }
    const blocks: Block[] = [];
    pushText(blocks, "The conversation so far, for context:\n\n<conversation_history>");
    for (const turn of history) {
      pushText(blocks, `\n<${turn.role}>\n`);
      appendRendered(blocks, turn.blocks);
      pushText(blocks, `\n</${turn.role}>`);
    }
    pushText(blocks, "\n</conversation_history>\n\nReply to the latest user message:\n\n");
    appendRendered(blocks, this.last().blocks);
    return blocks.map(blockParam);
  }
}

/** Text and image blocks, with tool blocks written out as tagged text. */
function render(blocks: readonly Block[]): Block[] {
  const out: Block[] = [];
  appendRendered(out, blocks);
  return out;
}

function appendRendered(out: Block[], blocks: readonly Block[]): void {
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        pushText(out, block.text);
        break;
      case "image":
        out.push(block);
        break;
      case "tool_use":
        pushText(
          out,
          `\n<tool_call name="${block.call.name}" id="${block.call.id}">${JSON.stringify(block.call.input) ?? "null"}</tool_call>`,
        );
        break;
      case "tool_result":
        pushText(
          out,
          `\n<tool_result id="${block.toolUseId}"${block.isError ? ' error="true"' : ""}>\n`,
        );
        appendRendered(out, block.content);
        pushText(out, "\n</tool_result>");
        break;
    }
  }
}

/** Append text to the last block when it is text, so text runs stay one block between images. */
function pushText(blocks: Block[], s: string): void {
  const last = blocks.at(-1);
  if (last?.type === "text") {
    last.text += s;
  } else {
    blocks.push(text(s));
  }
}

/** A Messages API content block. Expects rendered blocks: text and images only. */
export function blockParam(block: Block): ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return block.source.kind === "base64"
        ? {
            type: "image",
            source: {
              type: "base64",
              // The API checks the type; the proxy only requires `image/`.
              media_type: block.source.mediaType as "image/png",
              data: block.source.data,
            },
          }
        : { type: "image", source: { type: "url", url: block.source.url } };
    default:
      throw new Error(`a ${block.type} block must be rendered as text first`);
  }
}

/**
 * Hash of a system prompt plus turns. Text is trimmed and assistant turns
 * are reduced to their text and tool calls, so a client that strips
 * whitespace from a reply or wraps it differently still lands on the same key.
 */
function keyOf(system: string, turns: readonly Turn[]): string {
  return hexDigest(canonicalJson({ v: 1, system: system.trim(), turns: turns.map(canonicalTurn) }));
}

function canonicalTurn(turn: Turn): unknown {
  if (turn.role === "user") {
    return { user: canonicalBlocks(turn.blocks) };
  }
  const reply = turn.blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const calls = turn.blocks.flatMap((b) =>
    b.type === "tool_use" ? [{ id: b.call.id, name: b.call.name, input: b.call.input }] : [],
  );
  return calls.length === 0 ? { assistant: reply } : { assistant: reply, tool_calls: calls };
}

function canonicalBlocks(blocks: readonly Block[]): unknown[] {
  return blocks.map((b) => {
    switch (b.type) {
      case "text":
        return { text: b.text.trim() };
      case "image":
        return b.source.kind === "base64"
          ? { image: hexDigest(b.source.data) }
          : { image_url: b.source.url };
      case "tool_use":
        return { tool_call: b.call.id };
      case "tool_result":
        return { tool_result: b.toolUseId, error: b.isError, content: canonicalBlocks(b.content) };
    }
  });
}

/** JSON with object keys sorted, so the same content always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function hexDigest(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
