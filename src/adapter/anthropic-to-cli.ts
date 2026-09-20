// Anthropic Messages request → `Conversation`.

import {
  type Block,
  type Conversation,
  ConversationBuilder,
  type ImageSource,
  type Role,
  text,
} from "../conversation.js";
import { AppError } from "../errors.js";
import type { Content, ContentBlock, MessagesRequest } from "../types/anthropic.js";

export function toConversation(request: MessagesRequest): Conversation {
  const builder = new ConversationBuilder();
  if (request.system != null) {
    const system = contentBlocks(request.system, "user");
    builder.system(system.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"));
  }

  for (const message of request.messages) {
    if (message.role !== "user" && message.role !== "assistant") {
      throw AppError.badRequest(`unsupported message role '${message.role}'`);
    }
    builder.push(message.role, contentBlocks(message.content, message.role));
  }
  return builder.build();
}

function contentBlocks(content: Content, role: Role): Block[] {
  if (typeof content === "string") {
    return [text(content)];
  }
  const out: Block[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text != null) {
        out.push(text(block.text));
      }
    } else if (block.type === "image" && role === "user") {
      out.push({ type: "image", source: imageSource(block) });
    } else if (block.type === "tool_use" && role === "assistant") {
      out.push({
        type: "tool_use",
        call: {
          id: required(block.id, "tool_use block without an id"),
          name: required(block.name, "tool_use block without a name"),
          input: block.input ?? {},
        },
      });
    } else if (block.type === "tool_result" && role === "user") {
      out.push({
        type: "tool_result",
        toolUseId: required(block.tool_use_id, "tool_result block without a tool_use_id"),
        content: toolResultContent(block.content),
        isError: block.is_error ?? false,
      });
    } else if (role !== "assistant") {
      // Thinking from earlier assistant turns is not replayed.
      throw AppError.badRequest(`content block type '${block.type}' is not supported`);
    }
  }
  return out;
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw AppError.badRequest(message);
  }
  return value;
}

function imageSource(block: ContentBlock): ImageSource {
  return imageFrom(required(block.source, "image block without a source"));
}

function imageFrom(source: unknown): ImageSource {
  const record = (source ?? {}) as Record<string, unknown>;
  const field = (name: string) => (typeof record[name] === "string" ? record[name] : undefined);
  switch (record.type) {
    case "base64":
      return {
        kind: "base64",
        mediaType: required(field("media_type"), "base64 image without media_type"),
        data: required(field("data"), "base64 image without data"),
      };
    case "url":
      return { kind: "url", url: required(field("url"), "url image without url") };
    default:
      throw AppError.badRequest(
        `unsupported image source type ${JSON.stringify(record.type ?? null)}`,
      );
  }
}

/** A tool result's content is a string or a list of text and image blocks. */
function toolResultContent(content: unknown): Block[] {
  if (content == null) {
    return [];
  }
  if (typeof content === "string") {
    return [text(content)];
  }
  if (Array.isArray(content)) {
    const out: Block[] = [];
    for (const item of content as Record<string, unknown>[]) {
      if (item?.type === "text" && typeof item.text === "string") {
        out.push(text(item.text));
      } else if (item?.type === "image") {
        out.push({
          type: "image",
          source: imageFrom(required(item.source, "image block without a source")),
        });
      }
    }
    return out;
  }
  return [text(JSON.stringify(content))];
}
