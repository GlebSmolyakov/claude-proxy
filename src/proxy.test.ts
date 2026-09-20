import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  type Connect,
  parseWishes,
  proxiedName,
  proxyTools,
  shapeOf,
  type UpstreamClient,
  type UpstreamTool,
} from "./proxy.js";

const SEARCH: UpstreamTool = {
  name: "browser-read-page",
  description: "Reads the previewed page as text.",
  inputSchema: {
    type: "object",
    properties: { format: { type: "string", enum: ["text", "html"] } },
    required: ["format"],
  },
};
const CLICK: UpstreamTool = { name: "browser-click", description: "Clicks an element." };

/** A server that answers with whatever the test gave it. */
function upstream(
  tools: UpstreamTool[],
  result: unknown = { content: [{ type: "text", text: "ok" }] },
) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const closed = vi.fn();
  const client: UpstreamClient = {
    listTools: async () => ({ tools }),
    callTool: async (params) => {
      calls.push(params);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    close: async () => closed(),
  };
  const connect: Connect = async () => client;
  return { connect, calls, closed };
}

const AIR: Record<string, McpServerConfig> = { Air: { type: "stdio", command: "mcp-proxy" } };

describe("parseWishes", () => {
  it("takes a whole server, named tools, and several servers at once", () => {
    expect(parseWishes("Air")).toEqual({ Air: "all" });
    expect(parseWishes("Air:browser-read-page,browser-screenshot")).toEqual({
      Air: ["browser-read-page", "browser-screenshot"],
    });
    expect(parseWishes("Air:browser-click; node_repl")).toEqual({
      Air: ["browser-click"],
      node_repl: "all",
    });
    expect(parseWishes("")).toEqual({});
    expect(parseWishes("Air:")).toEqual({});
  });
});

describe("proxiedName", () => {
  it("keeps the server in the name and drops what a tool name cannot hold", () => {
    expect(proxiedName("Air", "browser-read-page")).toBe("Air__browser-read-page");
    expect(proxiedName("my server", "read:page")).toBe("my_server__read_page");
  });
});

describe("shapeOf", () => {
  it("carries the tool's own schema across", () => {
    const shape = shapeOf(SEARCH);
    expect(Object.keys(shape)).toEqual(["format"]);
    const format = shape.format as z.ZodType;
    expect(format.safeParse("html").success).toBe(true);
    expect(format.safeParse("pdf").success).toBe(false);
  });

  it("asks for nothing when the tool asks for nothing, and passes an odd schema through", () => {
    expect(shapeOf(CLICK)).toEqual({});
    const odd = shapeOf({ name: "x", inputSchema: { type: "object", properties: { any: {} } } });
    expect(Object.keys(odd)).toEqual(["any"]);
  });
});

describe("proxyTools", () => {
  it("takes the tools a session asked for and leaves the rest", async () => {
    const { connect } = upstream([SEARCH, CLICK]);
    const proxied = await proxyTools(AIR, { Air: ["browser-read-page"] }, connect);
    expect(proxied.tools.map((t) => t.name)).toEqual(["Air__browser-read-page"]);
    expect(proxied.tools[0].description).toBe("Reads the previewed page as text.");

    const everything = await proxyTools(AIR, { Air: "all" }, connect);
    expect(everything.tools.map((t) => t.name)).toEqual([
      "Air__browser-read-page",
      "Air__browser-click",
    ]);
  });

  it("runs a call on the server it came from and hands the answer back", async () => {
    const { connect, calls } = upstream([SEARCH]);
    const proxied = await proxyTools(AIR, { Air: "all" }, connect);
    const result = await proxied.tools[0].handler({ format: "text" } as never, undefined);
    expect(calls).toEqual([{ name: "browser-read-page", arguments: { format: "text" } }]);
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("turns a failed call into an error the agent can read", async () => {
    const { connect } = upstream([CLICK], new Error("the preview is closed"));
    const proxied = await proxyTools(AIR, { Air: "all" }, connect);
    const result = await proxied.tools[0].handler({} as never, undefined);
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("the preview is closed");
  });

  it("carries on when a server is missing or will not answer", async () => {
    const missing = await proxyTools(AIR, { Other: "all" }, upstream([SEARCH]).connect);
    expect(missing.tools).toEqual([]);

    const broken: Connect = async () => {
      throw new Error("connection refused");
    };
    const failed = await proxyTools(AIR, { Air: "all" }, broken);
    expect(failed.tools).toEqual([]);
  });

  it("lets go of every server it opened", async () => {
    const { connect, closed } = upstream([SEARCH]);
    const proxied = await proxyTools(AIR, { Air: "all" }, connect);
    await proxied.close();
    expect(closed).toHaveBeenCalledOnce();
  });
});
