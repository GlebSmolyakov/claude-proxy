// Tools of another MCP server, offered to the agent as the host's own.
//
// The editor and the CLI never meet: the host is the one that connects to
// the server, picks which of its tools are worth having, and re-exposes
// them through its own in-process server. That way their names, their
// descriptions and what lands on a card all stay under this host's hand.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { log } from "./log.js";

/** How long one proxied call may take before the agent is told it failed. */
const CALL_TIMEOUT_MS = 120_000;

/** How long a server has to answer when the host first reaches for it. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Which tools of a server to take: every one of them, or these by name. */
export type Wanted = "all" | readonly string[];

/** A server to proxy and the tools wanted from it. */
export type Wishes = Record<string, Wanted>;

export interface Upstream {
  tools: SdkMcpToolDefinition[];
  close: () => Promise<void>;
}

/** A connected MCP server, as the proxy uses it; tests put a fake here. */
export interface UpstreamClient {
  listTools: () => Promise<{ tools: UpstreamTool[] }>;
  callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
}

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type Connect = (name: string, config: McpServerConfig) => Promise<UpstreamClient>;

/**
 * What to proxy, as the flag and the project file write it: servers apart by
 * semicolons, the tools of one apart by commas. `Air` takes everything it
 * has, `Air:browser-read-page,browser-screenshot` takes those two.
 */
export function parseWishes(value: string): Wishes {
  const wishes: Wishes = {};
  for (const entry of value.split(";").map((part) => part.trim())) {
    if (entry === "") {
      continue;
    }
    const colon = entry.indexOf(":");
    if (colon < 0) {
      wishes[entry] = "all";
      continue;
    }
    const server = entry.slice(0, colon).trim();
    const tools = entry
      .slice(colon + 1)
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (server !== "" && tools.length > 0) {
      wishes[server] = tools;
    }
  }
  return wishes;
}

/** The name the model sees for a proxied tool: the server it came from, then its own. */
export function proxiedName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Connect to the servers a session wants proxied and turn their tools into
 * tools of this host. A server that will not answer is left out with a line
 * in the log, since a missing tool is better than a broken session.
 */
export async function proxyTools(
  servers: Record<string, McpServerConfig>,
  wishes: Wishes,
  connect: Connect = connectTo,
): Promise<Upstream> {
  const tools: SdkMcpToolDefinition[] = [];
  const clients: UpstreamClient[] = [];
  const taken = new Set<string>();
  for (const [name, wanted] of Object.entries(wishes)) {
    const config = servers[name];
    if (!config) {
      log.warn(`Nothing to proxy under '${name}': the editor offered no such server`);
      continue;
    }
    let client: UpstreamClient;
    try {
      client = await withTimeout(connect(name, config), name, CONNECT_TIMEOUT_MS);
    } catch (e) {
      log.warn(`Could not reach '${name}': ${(e as Error).message}`);
      continue;
    }
    // Remembered before its tools are read: a stdio server that fails to
    // answer has still started a process, and `close` is what ends it.
    clients.push(client);
    let listed: UpstreamTool[];
    try {
      listed = (await withTimeout(client.listTools(), name, CONNECT_TIMEOUT_MS)).tools;
    } catch (e) {
      log.warn(`Could not read the tools of '${name}': ${(e as Error).message}`);
      continue;
    }
    const wants = listed.filter((upstream) => wanted === "all" || wanted.includes(upstream.name));
    for (const upstream of wants) {
      tools.push(proxied(name, upstream, unique(proxiedName(name, upstream.name), taken), client));
    }
    log.info(
      `Proxying ${wants.length} of ${listed.length} tools of '${name}': ${wants.map((t) => t.name).join(", ")}`,
    );
  }
  return {
    tools,
    close: async () => {
      for (const client of clients) {
        await client.close().catch(() => {});
      }
    },
  };
}

/**
 * Sanitising names can bring two of them together, as `Air-1` and `Air_1`
 * do. The second one to arrive is numbered rather than lost.
 */
function unique(name: string, taken: Set<string>): string {
  let free = name;
  for (let n = 2; taken.has(free); n++) {
    free = `${name}_${n}`;
  }
  if (free !== name) {
    log.warn(`Two proxied tools are both called '${name}'; the second is '${free}'`);
  }
  taken.add(free);
  return free;
}

function proxied(
  server: string,
  upstream: UpstreamTool,
  name: string,
  client: UpstreamClient,
): SdkMcpToolDefinition {
  const description = upstream.description?.trim() || `The ${upstream.name} tool of ${server}.`;
  // The shape comes from a schema read at runtime, so its type is only known then.
  const run = async (args: Record<string, unknown>): Promise<CallToolResult> => {
    const call = client.callTool({ name: upstream.name, arguments: args });
    try {
      return (await withTimeout(call, upstream.name)) as CallToolResult;
    } catch (e) {
      return {
        content: [{ type: "text", text: `${server} could not run this: ${(e as Error).message}` }],
        isError: true,
      };
    }
  };
  return tool(name, description, shapeOf(upstream), (args) =>
    run((args ?? {}) as Record<string, unknown>),
  ) as SdkMcpToolDefinition;
}

/**
 * The tool's own schema, as zod, which is what an in-process tool takes. A
 * schema that will not convert becomes a loose object: the model still gets
 * the tool, and the server upstream does its own checking anyway.
 */
export function shapeOf(upstream: UpstreamTool): z.ZodRawShape {
  const schema = upstream.inputSchema;
  if (!schema || typeof schema !== "object") {
    return {};
  }
  try {
    const converted = z.fromJSONSchema(schema as never);
    if (converted instanceof z.ZodObject) {
      return converted.shape as z.ZodRawShape;
    }
  } catch (e) {
    log.warn(
      `Passing the input of '${upstream.name}' through as it comes: ${(e as Error).message}`,
    );
  }
  const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  return Object.fromEntries(Object.keys(properties).map((key) => [key, z.unknown()]));
}

async function withTimeout<T>(call: Promise<T>, name: string, ms = CALL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not answer in ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A real connection to a server the editor described. */
async function connectTo(name: string, config: McpServerConfig): Promise<UpstreamClient> {
  const client = new Client({ name: "claude-proxy", version: "0" }, { capabilities: {} });
  await client.connect(transportFor(name, config));
  return {
    listTools: () => client.listTools() as Promise<{ tools: UpstreamTool[] }>,
    callTool: (params) => client.callTool(params),
    close: () => client.close(),
  };
}

function transportFor(name: string, config: McpServerConfig) {
  if ("url" in config && config.type === "sse") {
    return new SSEClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }
  if ("url" in config) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers },
    });
  }
  if ("command" in config) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...(process.env as Record<string, string>), ...config.env },
    });
  }
  throw new Error(`'${name}' is a kind of server this host cannot reach`);
}
