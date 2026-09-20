import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { AGENT_ENV, type AgentOptions, buildOptions, REFUSAL, Translator } from "./agent.js";

function options(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    requestId: "r",
    api: "openai",
    model: "haiku",
    systemPrompt: "Be brief.",
    cwd: "/tmp",
    permissionMode: "default",
    executable: "/bin/claude",
    prompt: [{ type: "text", text: "hi" }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

const build = (overrides: Partial<AgentOptions> = {}) => buildOptions(options(overrides), () => {});

describe("agent options", () => {
  it("run Claude Code as a full agent", () => {
    const o = build();
    expect(o.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(o.settingSources).toEqual(["user", "project", "local"]);
    expect(o.strictMcpConfig).toBeUndefined();
    expect(o.env).toMatchObject(AGENT_ENV);
    expect(o.env?.PATH).toBe(process.env.PATH);
    expect(o.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined();
    expect(o.env?.ENABLE_TOOL_SEARCH).toBeUndefined();
  });

  it("stream partial messages and keep the model and cwd", () => {
    const o = build();
    expect(o.includePartialMessages).toBe(true);
    expect(o.model).toBe("haiku");
    expect(o.cwd).toBe("/tmp");
    expect(o.pathToClaudeCodeExecutable).toBe("/bin/claude");
  });

  it("append the client's system prompt to Claude Code's own", () => {
    expect(build().systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Be brief.",
    });
    expect(build({ systemPrompt: "" }).systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("resume by forking", () => {
    expect(build().resume).toBeUndefined();
    const o = build({ resume: "abc" });
    expect(o.resume).toBe("abc");
    expect(o.forkSession).toBe(true);
  });

  it("carry the permission mode and allow bypassing only when asked", () => {
    expect(build().permissionMode).toBe("default");
    expect(build().allowDangerouslySkipPermissions).toBe(false);
    const bypass = build({ permissionMode: "bypassPermissions" });
    expect(bypass.permissionMode).toBe("bypassPermissions");
    expect(bypass.allowDangerouslySkipPermissions).toBe(true);
    expect(build().disallowedTools).toEqual(["AskUserQuestion"]);
  });

  it("refuse actions nobody can approve and tell the model why", async () => {
    const decision = await build().canUseTool!(
      "Bash",
      { command: "rm -rf build" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_1",
        requestId: "q",
      },
    );
    expect(decision).toEqual({ behavior: "deny", message: REFUSAL });
  });
});

const stream = (event: object, parent: string | null = null) =>
  ({ type: "stream_event", event, parent_tool_use_id: parent }) as unknown as SDKMessage;
const textDelta = (t: string, parent: string | null = null) =>
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }, parent);
const blockStart = (type: string) =>
  stream({ type: "content_block_start", index: 0, content_block: { type } });

describe("Translator", () => {
  it("names the session and the model on init", () => {
    const init = {
      type: "system",
      subtype: "init",
      session_id: "s1",
      model: "claude-haiku-4-5-20251001",
    } as unknown as SDKMessage;
    expect(new Translator().push(init)).toEqual([
      { type: "init", sessionId: "s1", model: "claude-haiku-4-5-20251001" },
    ]);
    expect(
      new Translator().push({ type: "system", subtype: "status" } as unknown as SDKMessage),
    ).toEqual([]);
  });

  it("forwards text of the main agent only", () => {
    const t = new Translator();
    expect(t.push(textDelta("Hi"))).toEqual([{ type: "text_delta", text: "Hi" }]);
    expect(t.push(textDelta("sub", "toolu_9"))).toEqual([]);
    const thinking = stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hm" },
    });
    expect(t.push(thinking)).toEqual([]);
  });

  it("sets text blocks of later steps off with a blank line", () => {
    const t = new Translator();
    const events = [
      blockStart("text"),
      textDelta("Let me look."),
      blockStart("tool_use"),
      blockStart("text"),
      textDelta("It is "),
      textDelta("empty."),
    ].flatMap((m) => t.push(m));
    expect(events.map((e) => (e.type === "text_delta" ? e.text : e.type))).toEqual([
      "Let me look.",
      "\n\nIt is ",
      "empty.",
    ]);
  });

  it("forwards rate limits and results and ignores the rest", () => {
    const t = new Translator();
    const info = { status: "allowed" };
    expect(
      t.push({ type: "rate_limit_event", rate_limit_info: info } as unknown as SDKMessage),
    ).toEqual([{ type: "rate_limit", info }]);
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Hi",
    } as unknown as SDKMessage;
    expect(t.push(result)).toEqual([{ type: "result", result }]);
    const assistant = { type: "assistant", message: { content: [{ type: "text", text: "Hi" }] } };
    expect(t.push(assistant as unknown as SDKMessage)).toEqual([]);
  });
});
