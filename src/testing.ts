// Fakes shared by the tests.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentEvent, AgentOptions } from "./agent.js";
import type { AppState } from "./server.js";
import { SessionStore } from "./session.js";
import { RuntimeStatus } from "./status.js";

export async function* replay(events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) {
    yield event;
  }
}

export const init = (): AgentEvent => ({
  type: "init",
  sessionId: "s",
  model: "claude-haiku-4-5-20251001",
});
export const delta = (text: string): AgentEvent => ({ type: "text_delta", text });
export const exit = (error?: string, stderrTail = ""): AgentEvent => ({
  type: "exit",
  ...(error !== undefined && { error }),
  stderrTail,
});
export const result = (fields: object): AgentEvent => ({
  type: "result",
  result: { type: "result", subtype: "success", is_error: false, ...fields } as SDKResultMessage,
});

export async function sessions(): Promise<SessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "claude-proxy-test-"));
  return SessionStore.open(join(dir, "sessions.json"), join(dir, "t"));
}

export async function state(
  runAgent: (o: AgentOptions) => AsyncIterable<AgentEvent>,
): Promise<AppState> {
  return {
    cwd: "/tmp",
    sessions: await sessions(),
    status: new RuntimeStatus("2.1.0 (Claude Code)"),
    permissionMode: "default",
    executable: "/bin/claude",
    runAgent,
  };
}
