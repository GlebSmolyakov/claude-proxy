// Agent SDK messages → ACP `session/update` events.
//
//   text and thinking deltas  → agent_message_chunk, agent_thought_chunk
//   start of a tool call      → tool_call
//   its full input and result → tool_call_update (status, diff, output)
//   TodoWrite and Task* tools → plan
//   token counts              → usage_update

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { Session } from "./session.js";
import { type Input, PLAN_TOOLS, resultContent, todoPlan } from "./tools.js";

const TOOL_USE_TYPES: ReadonlySet<string> = new Set([
  "tool_use",
  "server_tool_use",
  "mcp_tool_use",
]);

type Block = { type: string } & Record<string, unknown>;

/** One per prompt; the session carries what outlives it. */
export class UpdateMapper {
  /**
   * Replaying a saved conversation, where the text arrives inside complete
   * messages because there are no stream events to carry it.
   */
  private readonly replay: boolean;
  /** Id of the API message being streamed; chunks of one message share it. */
  private messageId: string | undefined;
  /** Model of the main agent's last message, whose context window counts. */
  private model: string | undefined;
  /** Tokens in the context after the main agent's last API call. */
  private context: number | undefined;

  constructor(
    private readonly session: Session,
    options: { replay?: boolean } = {},
  ) {
    this.replay = options.replay === true;
  }

  map(message: SDKMessage): SessionUpdate[] {
    switch (message.type) {
      case "system":
        // Compaction leaves a smaller context behind; say so without waiting
        // for the next API call to report it.
        return message.subtype === "compact_boundary"
          ? this.used(message.compact_metadata.post_tokens)
          : [];
      case "stream_event":
        return this.streamEvent(message);
      case "assistant":
        return this.assistant(message);
      case "user":
        return this.results(message.message.content, message.tool_use_result, "user");
      case "result":
        return this.result(message);
      default:
        return [];
    }
  }

  /** Streamed pieces of the main agent's messages; subagents only show their tool calls. */
  private streamEvent(message: SDKPartialAssistantMessage): SessionUpdate[] {
    if (message.parent_tool_use_id !== null) {
      return [];
    }
    const event = message.event;
    switch (event.type) {
      case "message_start":
        this.messageId = event.message.id;
        this.model = event.message.model;
        return [];
      case "content_block_start": {
        const block = event.content_block as unknown as Block;
        const id = block.id as string;
        const name = block.name as string;
        if (
          TOOL_USE_TYPES.has(block.type) &&
          !PLAN_TOOLS.has(name) &&
          !this.session.emitted.has(id)
        ) {
          return [this.session.card(id, name, {}, null)];
        }
        return [];
      }
      case "content_block_delta":
        if (event.delta.type === "text_delta" && event.delta.text !== "") {
          return [this.chunk("agent_message_chunk", event.delta.text)];
        }
        if (event.delta.type === "thinking_delta" && event.delta.thinking !== "") {
          return [this.chunk("agent_thought_chunk", event.delta.thinking)];
        }
        return [];
      case "message_delta": {
        const u = event.usage;
        if (u.input_tokens == null) {
          return [];
        }
        return this.used(
          u.input_tokens +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            u.output_tokens,
        );
      }
      default:
        return [];
    }
  }

  /** How full the context is now. */
  private used(tokens: number | undefined): SessionUpdate[] {
    if (tokens === undefined) {
      return [];
    }
    this.context = tokens;
    return [{ sessionUpdate: "usage_update", used: tokens, size: this.session.contextWindow }];
  }

  private chunk(
    kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk",
    text: string,
  ): SessionUpdate {
    return {
      sessionUpdate: kind,
      content: { type: "text", text },
      ...(this.messageId !== undefined && { messageId: this.messageId }),
    };
  }

  /**
   * Complete messages. Their text already came streamed; what they add is the
   * full input of each tool call, and the calls of subagents.
   */
  private assistant(message: SDKAssistantMessage): SessionUpdate[] {
    const parent = message.parent_tool_use_id;
    const updates: SessionUpdate[] = [];
    this.messageId = typeof message.message.id === "string" ? message.message.id : this.messageId;
    for (const block of message.message.content as unknown as Block[]) {
      if (!TOOL_USE_TYPES.has(block.type)) {
        if (this.replay && block.type === "text" && typeof block.text === "string" && block.text) {
          updates.push(this.chunk("agent_message_chunk", block.text));
        }
        if (this.replay && block.type === "thinking" && typeof block.thinking === "string") {
          updates.push(this.chunk("agent_thought_chunk", block.thinking));
        }
        continue;
      }
      const id = block.id as string;
      const name = block.name as string;
      const input = (block.input ?? {}) as Input;
      if (name === "TodoWrite") {
        this.session.tools.set(id, { name, input });
        const entries = todoPlan(input);
        if (entries) {
          updates.push({ sessionUpdate: "plan", entries });
        }
      } else if (PLAN_TOOLS.has(name)) {
        // The plan changes when the result confirms it.
        this.session.tools.set(id, { name, input });
      } else {
        updates.push(this.session.card(id, name, input, parent));
      }
    }
    // Server tools answer inside the assistant message itself.
    updates.push(...this.results(message.message.content, undefined, "assistant"));
    return updates;
  }

  /**
   * Tool results: the card gets its status and output; a task tool changes
   * the plan. `structured` is the tool's own output object, which the SDK
   * sends only for a message that carries a single result.
   */
  private results(
    content: unknown,
    structured: unknown,
    from: "user" | "assistant",
  ): SessionUpdate[] {
    // Only a replayed user message has text of its own to show; an assistant
    // message is here for the server tools that answer inside it.
    const spoken = this.replay && from === "user";
    if (typeof content === "string") {
      return spoken && content !== "" ? [this.chunk("user_message_chunk", content)] : [];
    }
    if (!Array.isArray(content)) {
      return [];
    }
    const updates: SessionUpdate[] = [];
    if (spoken) {
      for (const block of content as Block[]) {
        if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
          updates.push(this.chunk("user_message_chunk", block.text));
        }
      }
    }
    const results = (content as Block[]).filter((b) => typeof b.tool_use_id === "string");
    const output = results.length === 1 ? structured : undefined;
    for (const block of results) {
      const id = block.tool_use_id as string;
      const isError = block.is_error === true;
      const tool = this.session.tools.get(id);
      this.session.tools.delete(id);
      const hasCard = this.session.emitted.delete(id);

      if (tool && PLAN_TOOLS.has(tool.name)) {
        if (!isError && this.session.plan.apply(tool.name, tool.input, output ?? block.content)) {
          updates.push({ sessionUpdate: "plan", entries: this.session.plan.entries() });
        }
        if (!hasCard) {
          continue;
        }
      } else if (!tool && !hasCard) {
        continue;
      }
      const extra = tool && resultContent(tool.name, block.content, isError);
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: isError ? "failed" : "completed",
        ...(extra && { content: extra }),
        rawOutput: block.content,
      });
    }
    return updates;
  }

  /** The turn's last word on tokens: the context window of the model, and what the run cost. */
  private result(message: SDKResultMessage): SessionUpdate[] {
    const models = message.modelUsage ?? {};
    const facts = (this.model !== undefined && models[this.model]) || Object.values(models)[0];
    if (facts && facts.contextWindow > 0) {
      this.session.contextWindow = facts.contextWindow;
    }
    if (this.context === undefined) {
      return [];
    }
    return [
      {
        sessionUpdate: "usage_update",
        used: this.context,
        size: this.session.contextWindow,
        ...(typeof message.total_cost_usd === "number" && {
          cost: { amount: message.total_cost_usd, currency: "USD" },
        }),
      },
    ];
  }
}
