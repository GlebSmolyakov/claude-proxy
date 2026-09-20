// The ACP side of the host: session methods from the editor, updates and
// permission requests back to it.

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  agent as acpAgent,
  type AgentApp,
  type AuthenticateResponse,
  type ClientCapabilities,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type SessionUpdate,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type {
  CanUseTool,
  McpServerConfig,
  PermissionMode,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

import { buildOptions, Pushable, type RunQuery, userMessage } from "./agent.js";
import { type Editor, editorFiles, insideWorkspace, READ_TOOL } from "./files.js";
import { log } from "./log.js";
import { availableModes, CANCELLED, decide, isMode, permissionOptions } from "./permissions.js";
import { promptContent } from "./prompt.js";
import { type LiveQuery, type RunningPrompt, Session } from "./session.js";
import { toolInfo } from "./tools.js";
import { UpdateMapper } from "./updates.js";

/** After an interrupt, how long a prompt may take to wind down before its process is stopped. */
const CANCEL_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 5;

export interface HostOptions {
  /** The Claude Code binary. */
  executable: string;
  /** Mode of new sessions. */
  permissionMode: PermissionMode;
  /** Model of every session; the CLI's own default when absent. */
  model?: string;
  runQuery: RunQuery;
  version: string;
}

interface Run {
  result?: SDKResultMessage;
  /** The agent ended without finishing the turn. */
  died: boolean;
  cancelled: boolean;
  error?: string;
  stderr: string;
}

/**
 * The ACP app. Each connection gets its own host, created before the
 * connection reads its first message; `onHost` hands it to the caller.
 */
export function createApp(
  options: HostOptions,
  onHost: (host: ClaudeProxyAgent) => void = () => {},
): AgentApp {
  let host!: ClaudeProxyAgent;
  return acpAgent({ name: "claude-proxy" })
    .onConnect((connection) => {
      host = new ClaudeProxyAgent(connection.client, options);
      onHost(host);
    })
    .onRequest(methods.agent.initialize, (ctx) => host.initialize(ctx.params))
    .onRequest(methods.agent.authenticate, () => host.authenticate())
    .onRequest(methods.agent.session.new, (ctx) => host.newSession(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => host.prompt(ctx.params, ctx.signal))
    .onRequest(methods.agent.session.setMode, (ctx) => host.setSessionMode(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) => host.cancel(ctx.params));
}

export class ClaudeProxyAgent {
  private readonly sessions = new Map<string, Session>();
  /** What the editor said it can do, from `initialize`. */
  private capabilities: ClientCapabilities | undefined;

  constructor(
    private readonly editor: Editor,
    private readonly options: HostOptions,
  ) {}

  initialize(params: InitializeRequest): InitializeResponse {
    this.capabilities = params.clientCapabilities;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      // The agent uses the login of the local Claude Code; there is nothing to sign in to here.
      authMethods: [],
      agentInfo: { name: "claude-proxy", title: "Claude Code", version: this.options.version },
    };
  }

  authenticate(): AuthenticateResponse {
    return {};
  }

  newSession(params: NewSessionRequest): NewSessionResponse {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    }
    const session = new Session(
      randomUUID(),
      params.cwd,
      params.additionalDirectories ?? [],
      mcpServers(params.mcpServers),
      this.options.permissionMode,
    );
    this.sessions.set(session.id, session);
    log.info(`[${session.id}] New session in ${session.cwd}, mode ${session.mode}`);
    return {
      sessionId: session.id,
      modes: { currentModeId: session.mode, availableModes: availableModes() },
    };
  }

  async prompt(params: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
    const session = this.session(params.sessionId);
    // One prompt at a time; an editor cancels the old one before sending the next.
    while (session.running) {
      await session.running.done;
    }
    const content = promptContent(params.prompt);
    if (content.length === 0) {
      throw RequestError.invalidParams(undefined, "the prompt has nothing the agent can read");
    }

    const onAbort = () => void this.cancel({ sessionId: session.id });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let run = await this.turn(session, content);
      if (run.died && !run.cancelled) {
        // The agent died mid-conversation; a new one picks its session up.
        log.warn(`[${session.id}] The agent ended without a result, starting it again`);
        run = await this.turn(session, content);
      }
      return response(session, run);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const running = this.sessions.get(params.sessionId)?.running;
    if (!running || running.cancelled) {
      return;
    }
    running.cancelled = true;
    log.info(`[${params.sessionId}] Cancelling the prompt`);
    const stop = setTimeout(() => running.query.close(), CANCEL_GRACE_MS);
    void running.done.then(() => clearTimeout(stop));
    try {
      await running.query.interrupt();
    } catch (e) {
      log.warn(`[${params.sessionId}] Interrupt failed, stopping claude: ${(e as Error).message}`);
      running.query.close();
    }
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.session(params.sessionId);
    if (!isMode(params.modeId)) {
      throw RequestError.invalidParams(undefined, `unknown mode '${params.modeId}'`);
    }
    session.mode = params.modeId;
    log.info(`[${session.id}] Mode ${session.mode}`);
    await session.live?.query.setPermissionMode(session.mode);
    return {};
  }

  /** The editor went away: stop every agent. */
  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.live?.query.close();
      session.live = undefined;
    }
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw RequestError.invalidParams(undefined, `unknown session '${id}'`);
    }
    return session;
  }

  /**
   * The session's agent, started on its first prompt. It keeps running
   * between prompts, so the conversation, its compaction and its context
   * live in the CLI, not in anything this host rebuilds.
   */
  private start(session: Session): LiveQuery {
    if (session.live) {
      return session.live;
    }
    const stderrTail: string[] = [];
    const stderr = (data: string) => {
      for (const line of data.split("\n").filter((l) => l.trim() !== "")) {
        log.debug(`[${session.id}] stderr: ${line}`);
        stderrTail.push(line);
        stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
      }
    };
    const files = editorFiles(
      { sessionId: session.id, cwd: session.cwd, editor: this.editor },
      this.capabilities,
    );
    const input = new Pushable<SDKUserMessage>();
    const query = this.options.runQuery({
      prompt: input,
      options: buildOptions({
        session,
        // A session whose agent died is picked up where the CLI saved it.
        resume: session.started,
        model: this.options.model,
        executable: this.options.executable,
        canUseTool: this.canUseTool(session),
        files,
        stderr,
      }),
    });
    log.info(
      `[${session.id}] Starting claude, ${session.started ? "resuming the session" : "new session"}, files ${files ? "through the editor" : "on disk"}`,
    );
    session.live = { query, input, messages: query[Symbol.asyncIterator](), stderrTail };
    return session.live;
  }

  /** One prompt: hand it to the agent and relay what it says until the turn ends. */
  private async turn(session: Session, content: ContentBlockParam[]): Promise<Run> {
    const live = this.start(session);
    let finish!: () => void;
    const running: RunningPrompt = {
      query: live.query,
      cancelled: false,
      done: new Promise((resolve) => (finish = resolve)),
    };
    session.running = running;
    live.input.push(userMessage(content));

    const mapper = new UpdateMapper(session);
    const run: Run = { died: false, cancelled: false, stderr: "" };
    try {
      for (;;) {
        const next = await live.messages.next();
        if (next.done === true) {
          run.died = true;
          break;
        }
        const message = next.value;
        if (message.type === "system" && message.subtype === "init") {
          // The CLI announces itself on every turn; the first one is the news.
          if (!session.started) {
            log.info(
              `[${session.id}] Claude Code ${message.claude_code_version} on ${message.model}`,
            );
          }
          session.started = true;
        }
        for (const update of mapper.map(message)) {
          await this.update(session, update);
        }
        if (message.type === "result") {
          run.result = message;
          break;
        }
      }
    } catch (e) {
      run.error = (e as Error).message ?? String(e);
      run.died = true;
    } finally {
      session.running = undefined;
      finish();
    }
    run.cancelled = running.cancelled;
    run.stderr = live.stderrTail.join("\n");
    // A dead agent leaves nothing to push the next prompt into.
    if (run.died) {
      session.live = undefined;
    }
    return run;
  }

  /** Every action the mode and settings leave to a human goes to the editor's dialog. */
  private canUseTool(session: Session): CanUseTool {
    return async (toolName, input, { signal, suggestions, toolUseID }) => {
      if (session.running?.cancelled) {
        return CANCELLED;
      }
      // Reading inside the session's folders is what the built-in Read does
      // without asking; the redirect must not turn it into a dialog.
      if (
        toolName === READ_TOOL &&
        insideWorkspace(input.file_path, [session.cwd, ...session.additionalDirectories])
      ) {
        return { behavior: "allow", updatedInput: input };
      }
      // The call may reach this point before its message reached the editor.
      if (!session.emitted.has(toolUseID)) {
        await this.update(session, session.card(toolUseID, toolName, input, null));
      }
      const info = toolInfo(toolName, input, session.displayRoot);
      let outcome;
      try {
        ({ outcome } = await this.editor.request(
          methods.client.session.requestPermission,
          {
            sessionId: session.id,
            toolCall: { toolCallId: toolUseID, ...info, rawInput: input },
            options: permissionOptions(toolName, suggestions),
          },
          { cancellationSignal: signal },
        ));
      } catch (e) {
        log.warn(
          `[${session.id}] Permission request for ${toolName} failed: ${(e as Error).message}`,
        );
        return CANCELLED;
      }
      const decision = decide(toolName, outcome, input, suggestions);
      log.info(
        `[${session.id}] ${toolName}: ${outcome.outcome === "selected" ? outcome.optionId : "cancelled"}`,
      );
      if (decision.mode) {
        session.mode = decision.mode;
        await this.update(session, {
          sessionUpdate: "current_mode_update",
          currentModeId: decision.mode,
        });
      }
      return decision.result;
    };
  }

  private async update(session: Session, update: SessionUpdate): Promise<void> {
    await this.editor.notify(methods.client.session.update, { sessionId: session.id, update });
  }
}

/** How the prompt ended, or the error the editor shows. */
function response(session: Session, run: Run): PromptResponse {
  if (run.cancelled) {
    return { stopReason: "cancelled" };
  }
  const result = run.result;
  if (!result) {
    const parts = ["claude exited without a result", run.error, run.stderr].filter(Boolean);
    log.warn(`[${session.id}] ${parts.join(": ")}`);
    throw RequestError.internalError(undefined, parts.join(": "));
  }
  if (result.subtype === "error_max_turns") {
    return { stopReason: "max_turn_requests", usage: usageOf(result) };
  }
  if (result.is_error) {
    const text = result.subtype === "success" ? result.result : result.errors?.join("; ");
    const message = text?.trim() ? text : `claude reported an error (${result.subtype})`;
    log.warn(`[${session.id}] ${message}`);
    throw RequestError.internalError(undefined, message);
  }
  return { stopReason: stopReason(result.stop_reason), usage: usageOf(result) };
}

function stopReason(reason: string | null): StopReason {
  return reason === "max_tokens" || reason === "refusal" ? reason : "end_turn";
}

/** Tokens of the whole prompt: every model it called, subagents included. */
function usageOf(result: SDKResultMessage): PromptResponse["usage"] {
  const total = { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 };
  for (const m of Object.values(result.modelUsage ?? {})) {
    total.inputTokens += m.inputTokens;
    total.outputTokens += m.outputTokens;
    total.cachedReadTokens += m.cacheReadInputTokens;
    total.cachedWriteTokens += m.cacheCreationInputTokens;
  }
  const totalTokens =
    total.inputTokens + total.outputTokens + total.cachedReadTokens + total.cachedWriteTokens;
  return { ...total, totalTokens };
}

/** The editor's MCP servers in the SDK's shape. Servers over ACP itself are not supported. */
export function mcpServers(servers: McpServer[]): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    const pairs = (list: { name: string; value: string }[]) =>
      Object.fromEntries(list.map((p) => [p.name, p.value]));
    if (!("type" in server)) {
      configs[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: pairs(server.env),
      };
    } else if (server.type === "http" || server.type === "sse") {
      configs[server.name] = { type: server.type, url: server.url, headers: pairs(server.headers) };
    } else {
      log.warn(`Skipping MCP server '${server.name}': transport '${server.type}' is not supported`);
    }
  }
  return configs;
}
