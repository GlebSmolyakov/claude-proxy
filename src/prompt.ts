// An ACP prompt → the content of the agent's user message.

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

/**
 * Text and images go as they are. A linked or embedded file becomes an
 * `@`-mention, and the text of an embedded one follows the message as
 * context, the way the official adapter does it. Audio and binary resources
 * have no place in the prompt and are left out.
 */
export function promptContent(prompt: ContentBlock[]): ContentBlockParam[] {
  const content: ContentBlockParam[] = [];
  const context: ContentBlockParam[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "image":
        if (block.data) {
          content.push({
            type: "image",
            // The API checks the type; the editor sends what it has.
            source: { type: "base64", media_type: block.mimeType as "image/png", data: block.data },
          });
        } else if (block.uri?.startsWith("http")) {
          content.push({ type: "image", source: { type: "url", url: block.uri } });
        }
        break;
      case "resource_link":
        content.push({ type: "text", text: mention(block.uri) });
        break;
      case "resource":
        if ("text" in block.resource) {
          const { uri, text } = block.resource;
          content.push({ type: "text", text: mention(uri) });
          context.push({ type: "text", text: `\n<context ref="${uri}">\n${text}\n</context>` });
        }
        break;
      default:
        break;
    }
  }
  return [...content, ...context];
}

/** `file:///a/b.ts` → `[@b.ts](file:///a/b.ts)`; other URIs stay as they are. */
function mention(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  const path = uri.slice("file://".length);
  return `[@${path.split("/").pop() || path}](${uri})`;
}
