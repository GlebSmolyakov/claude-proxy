import { describe, expect, it } from "vitest";

import { AGENT_ENV, type AgentOptions, buildOptions, userMessage } from "./agent.js";
import { Session } from "./session.js";

function build(
  overrides: Partial<AgentOptions> = {},
  session = new Session("id-1", "/repo", [], {}, "default", undefined),
) {
  return buildOptions({
    session,
    resume: false,
    executable: "/bin/claude",
    canUseTool: async () => ({ behavior: "allow" }),
    stderr: () => {},
    ...overrides,
  });
}

describe("agent options", () => {
  it("run Claude Code as a full agent in the session's folder", () => {
    const o = build();
    expect(o.cwd).toBe("/repo");
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(o.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(o.settingSources).toEqual(["user", "project", "local"]);
    expect(o.includePartialMessages).toBe(true);
    expect(o.env).toMatchObject(AGENT_ENV);
    expect(o.env?.PATH).toBe(process.env.PATH);
    expect(o.pathToClaudeCodeExecutable).toBe("/bin/claude");
  });

  it("start the session under its ACP id and resume it later", () => {
    expect(build()).toMatchObject({ sessionId: "id-1" });
    expect(build().resume).toBeUndefined();
    const resumed = build({ resume: true });
    expect(resumed.resume).toBe("id-1");
    expect(resumed.sessionId).toBeUndefined();
    expect(resumed.forkSession).toBeUndefined();
  });

  it("carry the session's mode and send approvals to the editor", () => {
    const canUseTool = async () => ({ behavior: "deny" as const, message: "no" });
    const o = build({ canUseTool }, new Session("id", "/repo", [], {}, "plan", undefined));
    expect(o.permissionMode).toBe("plan");
    expect(o.canUseTool).toBe(canUseTool);
    expect(o.disallowedTools).toEqual(["AskUserQuestion"]);
  });

  it("pass the model, extra folders and MCP servers only when there are some", () => {
    const plain = build();
    expect(plain.model).toBeUndefined();
    expect(plain.additionalDirectories).toBeUndefined();
    expect(plain.mcpServers).toBeUndefined();
    const full = build(
      {},
      new Session(
        "id",
        "/repo",
        ["/lib"],
        { db: { type: "stdio", command: "db-mcp" } },
        "default",
        "haiku",
      ),
    );
    expect(full.model).toBe("haiku");
    expect(full.additionalDirectories).toEqual(["/lib"]);
    expect(full.mcpServers).toEqual({ db: { type: "stdio", command: "db-mcp" } });
  });

  it("send the prompt as the user's own message", () => {
    expect(userMessage([{ type: "text", text: "hi" }])).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  });
});
