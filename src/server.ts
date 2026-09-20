// Router and shared state, on plain `node:http`.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import type { AgentEvent, AgentOptions } from "./agent.js";
import { AppError } from "./errors.js";
import { log } from "./log.js";
import * as routes from "./routes.js";
import type { SessionStore } from "./session.js";
import type { RuntimeStatus } from "./status.js";

export interface AppState {
  /** Working directory of the agent; its sessions are saved under it. */
  cwd: string;
  sessions: SessionStore;
  status: RuntimeStatus;
  /** How the agent treats actions that need approval. */
  permissionMode: PermissionMode;
  /** The Claude Code binary. */
  executable: string;
  /** Starts the agent; tests put a fake here. */
  runAgent: (options: AgentOptions) => AsyncIterable<AgentEvent>;
}

type Handler = (state: AppState, req: IncomingMessage, res: ServerResponse) => Promise<void>;

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/health": { GET: routes.health },
  "/v1/models": { GET: routes.models },
  "/v1/chat/completions": { POST: routes.chatCompletions },
  "/v1/messages": { POST: routes.messages },
};

export function createServer(state: AppState): Server {
  return createHttpServer((req, res) => {
    route(state, req, res).catch((e: unknown) => {
      log.error(`Unhandled error on ${req.method} ${req.url}: ${(e as Error).stack ?? String(e)}`);
      if (!res.headersSent) {
        routes.sendJson(res, 500, AppError.internal("internal error").openaiBody());
      } else {
        res.end();
      }
    });
  });
}

async function route(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Any origin, as tower-http's permissive CORS layer did.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-expose-headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-methods": "*",
      "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "*",
    });
    res.end();
    return;
  }

  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const methods = ROUTES[path];
  if (!methods) {
    const error = AppError.notFound("The requested endpoint does not exist");
    routes.sendJson(res, error.status, error.openaiBody());
    return;
  }
  const handler = methods[req.method ?? ""];
  if (!handler) {
    res.writeHead(405, { allow: Object.keys(methods).join(", ") });
    res.end();
    return;
  }
  await handler(state, req, res);
}
