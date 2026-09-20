import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentEvent } from "./agent.js";
import { createServer } from "./server.js";
import { delta, exit, init, replay, result, state } from "./testing.js";

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.close();
  }
});

async function serve(events: AgentEvent[]): Promise<string> {
  const server = createServer(await state(() => replay(events)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const HELLO = [
  init(),
  delta("Hel"),
  delta("lo"),
  result({ result: "Hello", session_id: "sid", stop_reason: "end_turn" }),
  exit(),
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked field by field
const json = (res: Response): Promise<any> => res.json();

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("routes", () => {
  it("answer an OpenAI chat request", async () => {
    const base = await serve(HELLO);
    const res = await post(`${base}/v1/chat/completions`, {
      model: "haiku",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
    const body = await json(res);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(body.choices[0].message.content).toBe("Hello");
  });

  it("stream an Anthropic message", async () => {
    const base = await serve(HELLO);
    const res = await post(`${base}/v1/messages`, {
      model: "haiku",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const names = [...(await res.text()).matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(names).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  it("stream OpenAI chunks up to [DONE]", async () => {
    const base = await serve(HELLO);
    const res = await post(`${base}/v1/chat/completions`, {
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const payloads = [...(await res.text()).matchAll(/^data: (.+)$/gm)].map((m) => m[1]);
    expect(payloads.at(-1)).toBe("[DONE]");
    expect(payloads.slice(0, 2).map((p) => JSON.parse(p).choices[0].delta.content)).toEqual([
      "Hel",
      "lo",
    ]);
  });

  it("answer an early failure of a stream with its HTTP status", async () => {
    const base = await serve([
      init(),
      { type: "rate_limit", info: { status: "rejected" } as never },
      result({ is_error: true, result: "You've hit your limit" }),
      exit(),
    ]);
    const res = await post(`${base}/v1/messages`, {
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "You've hit your limit" },
    });
  });

  it("answer bad requests in the format of the endpoint", async () => {
    const base = await serve(HELLO);
    const openai = await post(`${base}/v1/chat/completions`, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(openai.status).toBe(400);
    expect((await json(openai)).error.type).toBe("invalid_request_error");

    const anthropic = await fetch(`${base}/v1/messages`, { method: "POST", body: "{" });
    expect(anthropic.status).toBe(400);
    expect((await json(anthropic)).type).toBe("error");
  });

  it("report health, models, unknown paths and wrong methods", async () => {
    const base = await serve(HELLO);
    const health = await json(await fetch(`${base}/health`));
    expect(health).toMatchObject({ status: "ok", permission_mode: "default", rate_limits: null });
    const models = await json(await fetch(`${base}/v1/models`));
    expect(models.data.map((m: { id: string }) => m.id)).toEqual([
      "fable",
      "opus",
      "sonnet",
      "haiku",
    ]);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/v1/messages`)).status).toBe(405);
  });
});
