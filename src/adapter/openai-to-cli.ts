// OpenAI chat request → `Conversation`.

import {
  type Block,
  type Conversation,
  ConversationBuilder,
  type ImageSource,
  text,
} from "../conversation.js";
import { AppError } from "../errors.js";
import type { ChatCompletionRequest, MessageContent } from "../types/openai.js";

export function toConversation(request: ChatCompletionRequest): Conversation {
  const messages = request.messages;
  if (!messages || messages.length === 0) {
    throw AppError.badRequest("messages is required and must be a non-empty array");
  }

  const builder = new ConversationBuilder();
  for (const message of messages) {
    const role = message.role;
    switch (role) {
      // `developer` is the newer name for `system`.
      case "system":
      case "developer":
        builder.system(textOf(contentBlocks(message.content, role)));
        break;
      case "assistant": {
        const blocks: Block[] = contentBlocks(message.content, role).filter(
          (b) => b.type === "text",
        );
        for (const call of message.tool_calls ?? []) {
          blocks.push({
            type: "tool_use",
            call: {
              id: call.id,
              name: call.function.name,
              input: parseArguments(call.function.arguments),
            },
          });
        }
        builder.push("assistant", blocks);
        break;
      }
      default:
        if (role === "tool" && message.tool_call_id != null) {
          builder.push("user", [
            {
              type: "tool_result",
              toolUseId: message.tool_call_id,
              content: contentBlocks(message.content, role),
              isError: false,
            },
          ]);
        } else {
          // `user`, and the legacy `function` role, which reads best as user text.
          builder.push("user", contentBlocks(message.content, role));
        }
    }
  }
  return builder.build();
}

/** Arguments arrive as a JSON string; a string that is not JSON is kept as is. */
export function parseArguments(args: unknown): unknown {
  if (typeof args === "string") {
    if (args.trim() === "") {
      return {};
    }
    try {
      return JSON.parse(args);
    } catch {
      return args;
    }
  }
  return args ?? {};
}

function contentBlocks(content: MessageContent | null | undefined, role: string): Block[] {
  if (content == null) {
    return [];
  }
  if (typeof content === "string") {
    return [text(content)];
  }
  const blocks: Block[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text != null) {
      blocks.push(text(part.text));
    } else if (part.type === "image_url" && part.image_url != null) {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url.url;
      blocks.push({ type: "image", source: parseImageUrl(url) });
    } else if (role !== "assistant") {
      // Assistant parts like `refusal` carry nothing to replay.
      throw AppError.badRequest(`content part type '${part.type}' is not supported`);
    }
  }
  return blocks;
}

function textOf(blocks: Block[]): string {
  return blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

/**
 * `data:image/png;base64,...` becomes an inline image; `http(s)://` URLs are
 * passed on for the API to download.
 */
export function parseImageUrl(url: string): ImageSource {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) {
      throw AppError.badRequest("malformed image data URL");
    }
    const meta = url.slice("data:".length, comma);
    if (!meta.endsWith(";base64")) {
      throw AppError.badRequest("image data URLs must be base64-encoded");
    }
    const mediaType = meta.slice(0, -";base64".length);
    if (!mediaType.startsWith("image/")) {
      throw AppError.badRequest(`unsupported image media type '${mediaType}'`);
    }
    return { kind: "base64", mediaType, data: url.slice(comma + 1) };
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return { kind: "url", url };
  }
  throw AppError.badRequest("image_url must be a data: URL or an http(s) URL");
}
