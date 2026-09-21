// The ACP side of the host: session methods from the editor, updates and
// permission requests back to it.

import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  agent as acpAgent,
  type AgentApp,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type ClientCapabilities,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type McpServer,
  methods,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type SessionUpdate,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type {
  AccountInfo,
  CanUseTool,
  OnElicitation,
  McpServerConfig,
  PermissionResult,
  SDKMessage,
  SDKSessionInfo,
  SessionMessage,
  PermissionMode,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";

import { buildOptions, Pushable, type RunQuery, userMessage } from "./agent.js";
import {
  configOptions,
  DEFAULT_MODEL,
  EFFORT_CONFIG_ID,
  effortLevels,
  MODEL_CONFIG_ID,
  modelOptions,
  THINKING_CONFIG_ID,
} from "./config.js";
import { type Editor, editorTools, insideWorkspace, READ_TOOL } from "./editor-tools.js";
import { log } from "./log.js";
import { availableModes, CANCELLED, decide, isMode, permissionOptions } from "./permissions.js";
import { narrowTo, type ProjectSettings, projectSettings } from "./project.js";
import { type Connect, proxyTools, type Wishes } from "./proxy.js";
import { promptContent } from "./prompt.js";
import { answersFrom, mcpForm, mcpResult, questionForm, questionsOf } from "./questions.js";
import { type LiveQuery, type RunningPrompt, Session } from "./session.js";
import { type Input, toolInfo } from "./tools.js";
import { UpdateMapper } from "./updates.js";

/** After an interrupt, how long a prompt may take to wind down before its process is stopped. */
const CANCEL_GRACE_MS = 5_000;
/** How often idle agents are looked for. */
const SWEEP_EVERY_MS = 60_000;
/** How many saved conversations one `session/list` answers with. */
const PAGE = 50;
const STDERR_TAIL_LINES = 5;

/** Which MCP servers of an editor are allowed through to the CLI. */
export type Allowed = "all" | readonly string[];

export interface HostOptions {
  /** The Claude Code binary. */
  executable: string;
  /** Reads a saved conversation back; tests put a fake here. */
  readSession: (sessionId: string, options: { dir: string }) => Promise<SessionMessage[]>;
  /** Lists the conversations the CLI has saved. */
  listSessions: (options: {
    dir?: string;
    limit?: number;
    offset?: number;
  }) => Promise<SDKSessionInfo[]>;
  /** Mode of new sessions. */
  permissionMode: PermissionMode;
  /** Model of every session; the CLI's own default when absent. */
  model?: string;
  /** Stop an agent nobody has used for this long; 0 keeps every agent running. */
  idleMs: number;
  /** MCP servers of the editor the CLI may run: their names, or every one of them. */
  allowMcp: Allowed;
  /** Servers of the editor whose tools this host carries over itself. */
  proxyMcp: Wishes;
  /** Connects to a server this host proxies; tests put a fake here. */
  connectMcp?: Connect;
  runQuery: RunQuery;
  version: string;
}

/** What the user is told when the CLI has no credential to work with. */
const LOGIN_MESSAGE =
  "Claude Code is not logged in. Sign in from the editor, run `claude auth login` in a terminal, or give it an API key through ANTHROPIC_API_KEY.";

/**
 * Signing in where the client can run this program itself: it starts the
 * agent again with `--login`, which hands the terminal to the CLI's own
 * sign-in. A zero exit means it worked.
 */
export const LOGIN_METHOD = {
  type: "terminal" as const,
  id: "claude-login",
  name: "Log in to Claude Code",
  description: "Signs in to your Anthropic account, as `claude auth login` does",
  args: ["--login"],
};

interface Run {
  result?: SDKResultMessage;
  /** The agent ended without finishing the turn. */
  died: boolean;
  /** The CLI has nothing to authenticate with, so the turn never started. */
  loggedOut: boolean;
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
    .onRequest(methods.agent.authenticate, (ctx) => host.authenticate(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => host.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => host.loadSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => host.listSessions(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) => host.prompt(ctx.params, ctx.signal))
    .onRequest(methods.agent.session.setMode, (ctx) => host.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      host.setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.session.close, (ctx) => host.closeSession(ctx.params))
    .onNotification(methods.agent.session.cancel, (ctx) => host.cancel(ctx.params));
}

export class ClaudeProxyAgent {
  private readonly sessions = new Map<string, Session>();
  /** What the editor said it can do, from `initialize`. */
  private capabilities: ClientCapabilities | undefined;
  /** The editor can show a form, so the agent may ask its questions. */
  private forms = false;

  private readonly sweep: NodeJS.Timeout;

  constructor(
    private readonly editor: Editor,
    private readonly options: HostOptions,
  ) {
    // A short idle limit deserves a short look; a long one costs nothing to wait for.
    const every = Math.max(1_000, Math.min(SWEEP_EVERY_MS, options.idleMs || SWEEP_EVERY_MS));
    this.sweep = setInterval(() => this.closeIdle(), every);
    // An idle agent is worth stopping, not worth keeping the host alive for.
    this.sweep.unref();
  }

  initialize(params: InitializeRequest): InitializeResponse {
    this.capabilities = params.clientCapabilities;
    this.forms = params.clientCapabilities?.elicitation?.form != null;
    const has = (value: unknown) =>
      value === true || (value != null && value !== false) ? "yes" : "no";
    const fs = params.clientCapabilities?.fs;
    log.debug(`Editor capabilities: ${JSON.stringify(params.clientCapabilities ?? null)}`);
    log.info(
      `Editor ${params.clientInfo?.name ?? "unknown"}: reads files ${has(fs?.readTextFile)}, writes files ${has(fs?.writeTextFile)}, ` +
        `terminal ${has(params.clientCapabilities?.terminal)}, forms ${has(params.clientCapabilities?.elicitation?.form)}, ` +
        `terminal sign-in ${has(params.clientCapabilities?.auth?.terminal)}`,
    );
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {}, list: {} },
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
      },
      // Signing in is the CLI's own flow; the client can run it in a terminal.
      authMethods: params.clientCapabilities?.auth?.terminal === true ? [LOGIN_METHOD] : [],
      agentInfo: { name: "claude-proxy", title: "Claude Code", version: this.options.version },
    };
  }

  authenticate(params: AuthenticateRequest): AuthenticateResponse {
    // The only method is a terminal one, which the client runs itself.
    throw RequestError.invalidParams(
      undefined,
      params.methodId === LOGIN_METHOD.id
        ? `${LOGIN_METHOD.name} runs in a terminal; start this program with --login there`
        : `unknown authentication method '${params.methodId}'`,
    );
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    }
    const project = this.settingsFor(params.cwd);
    const session = new Session(
      randomUUID(),
      params.cwd,
      params.additionalDirectories ?? [],
      mcpServers(params.mcpServers, project.allowMcp ?? this.options.allowMcp),
      project.permissionMode ?? this.options.permissionMode,
      project.model ?? this.options.model,
    );
    this.sessions.set(session.id, session);
    log.info(`[${session.id}] New session in ${session.cwd}, mode ${session.mode}`);
    this.willProxy(session, params.mcpServers, project.proxyMcp);
    const broad = [session.cwd, ...session.additionalDirectories].filter(
      (root) => !session.readable.includes(root),
    );
    if (broad.length > 0) {
      log.warn(
        `[${session.id}] Too broad to read without asking: ${broad.join(", ")}; every read there goes to the dialog`,
      );
    }
    return {
      sessionId: session.id,
      modes: { currentModeId: session.mode, availableModes: availableModes() },
      configOptions: configOptions(session),
    };
  }

  /** The conversations the CLI saved, newest first, a page at a time. */
  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const from = Number(params.cursor ?? 0);
    if (!Number.isInteger(from) || from < 0) {
      throw RequestError.invalidParams(undefined, `'${String(params.cursor)}' is not a cursor`);
    }
    let found: SDKSessionInfo[];
    try {
      // One more than a page, to learn whether another page follows.
      found = await this.options.listSessions({
        ...(params.cwd != null && { dir: params.cwd }),
        limit: PAGE + 1,
        offset: from,
      });
    } catch (e) {
      throw RequestError.internalError(
        undefined,
        `could not list the sessions: ${(e as Error).message}`,
      );
    }
    const page = found.slice(0, PAGE);
    return {
      sessions: page.flatMap((info) => {
        // A session without a folder is one this host could not reopen.
        const cwd = info.cwd ?? params.cwd;
        return cwd == null
          ? []
          : [{ sessionId: info.sessionId, cwd, ...titleOf(info), ...when(info.lastModified) }];
      }),
      ...(found.length > PAGE && { nextCursor: String(from + PAGE) }),
    };
  }

  /**
   * A session the editor knew before: the CLI still has its transcript, so
   * the conversation is replayed to the editor and the next prompt picks the
   * session up where it stopped.
   */
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(undefined, "cwd must be an absolute path");
    }
    let messages: SessionMessage[];
    try {
      messages = await this.options.readSession(params.sessionId, { dir: params.cwd });
    } catch (e) {
      throw RequestError.internalError(
        undefined,
        `could not read the session: ${(e as Error).message}`,
      );
    }
    if (messages.length === 0) {
      throw RequestError.resourceNotFound(params.sessionId);
    }
    const project = this.settingsFor(params.cwd);
    const session = new Session(
      params.sessionId,
      params.cwd,
      params.additionalDirectories ?? [],
      mcpServers(params.mcpServers, project.allowMcp ?? this.options.allowMcp),
      project.permissionMode ?? this.options.permissionMode,
      project.model ?? this.options.model,
    );
    // The CLI holds the conversation; the next prompt resumes it.
    session.started = true;
    const open = this.sessions.get(params.sessionId);
    if (open) {
      log.info(`[${session.id}] Loaded over a session already open; letting the old agent go`);
      await this.retire(open);
    }
    this.sessions.set(session.id, session);
    this.willProxy(session, params.mcpServers, project.proxyMcp);
    log.info(`[${session.id}] Loading ${messages.length} saved messages`);

    const mapper = new UpdateMapper(session, { replay: true });
    for (const message of messages) {
      const replayed = {
        type: message.type,
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id,
      } as unknown as SDKMessage;
      for (const update of mapper.map(replayed)) {
        await this.update(session, update);
      }
    }
    return {
      modes: { currentModeId: session.mode, availableModes: availableModes() },
      configOptions: configOptions(session),
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
      if (run.died && !run.cancelled && !run.loggedOut) {
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

  /** The editor is done with this session: stop its agent and forget it. */
  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    await this.retire(this.session(params.sessionId));
    log.info(`[${params.sessionId}] Closed`);
    return {};
  }

  /** Stop a session's agent, let go of what it held, and forget it. */
  private async retire(session: Session): Promise<void> {
    const running = session.running;
    if (running) {
      await this.cancel({ sessionId: session.id });
      await running.done;
    }
    session.live?.query.close();
    session.live = undefined;
    session.toProxy = undefined;
    await this.dropProxy(session);
    await this.releaseTerminals(session);
    this.sessions.delete(session.id);
  }

  /**
   * What the project asks for, as far as the flags allow it: a repository is
   * content this host was pointed at, not the one who started it.
   */
  private settingsFor(cwd: string): ProjectSettings {
    return narrowTo(projectSettings(cwd), this.options);
  }

  /** Note which servers this session carries over; `start` is what connects. */
  private willProxy(session: Session, offered: McpServer[], wishes: Wishes | undefined): void {
    const wanted = wishes ?? this.options.proxyMcp;
    if (Object.keys(wanted).length === 0) {
      return;
    }
    session.toProxy = { servers: serverConfigs(offered), wishes: wanted };
  }

  /**
   * Connect to the servers this session proxies, so their tools become tools
   * of this host and the editor still never meets the CLI. Done once per
   * agent: an agent stopped for idling lets its servers go with it.
   */
  private async connectProxy(session: Session): Promise<void> {
    if (session.upstream || !session.toProxy) {
      return;
    }
    const { servers, wishes } = session.toProxy;
    session.upstream = await proxyTools(servers, wishes, this.options.connectMcp);
  }

  /** Let go of the proxied servers, so the processes behind them end too. */
  private async dropProxy(session: Session): Promise<void> {
    const upstream = session.upstream;
    session.upstream = undefined;
    try {
      await upstream?.close();
    } catch (e) {
      log.warn(`[${session.id}] Could not close a proxied server: ${(e as Error).message}`);
    }
  }

  /** Hand back the terminals the editor opened for a session, including any still running. */
  private async releaseTerminals(session: Session): Promise<void> {
    for (const terminalId of session.terminals) {
      try {
        await this.editor.request(methods.client.terminal.release, {
          sessionId: session.id,
          terminalId,
        });
      } catch (e) {
        log.warn(
          `[${session.id}] Could not release terminal ${terminalId}: ${(e as Error).message}`,
        );
      }
    }
    session.terminals.clear();
  }

  /**
   * Stop agents nobody has talked to for a while. The session stays: the CLI
   * keeps the conversation, and the next prompt starts an agent that resumes
   * it.
   */
  closeIdle(now = Date.now()): void {
    if (this.options.idleMs <= 0) {
      return;
    }
    for (const session of this.sessions.values()) {
      const idle = now - session.lastUsedAt;
      if (!session.live || session.running || idle < this.options.idleMs) {
        continue;
      }
      const since =
        idle >= 60_000 ? `${Math.round(idle / 60_000)} min` : `${Math.round(idle / 1000)} s`;
      log.info(`[${session.id}] Idle for ${since}, stopping its agent`);
      session.live.query.close();
      session.live = undefined;
      // The next prompt connects to them again.
      void this.dropProxy(session);
    }
  }

  /** The editor went away: stop every agent and every server it reached through. */
  async closeAll(): Promise<void> {
    clearInterval(this.sweep);
    const closing: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      session.live?.query.close();
      session.live = undefined;
      session.toProxy = undefined;
      closing.push(this.dropProxy(session));
    }
    await Promise.all(closing);
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
  private async start(session: Session): Promise<LiveQuery> {
    if (session.live) {
      return session.live;
    }
    await this.connectProxy(session);
    const stderrTail: string[] = [];
    const stderr = (data: string) => {
      for (const line of data.split("\n").filter((l) => l.trim() !== "")) {
        log.debug(`[${session.id}] stderr: ${line}`);
        stderrTail.push(line);
        stderrTail.splice(0, stderrTail.length - STDERR_TAIL_LINES);
      }
    };
    const tools = editorTools(
      { sessionId: session.id, cwd: session.cwd, editor: this.editor },
      this.capabilities,
      {
        terminals: session.terminals,
        attach: (toolCallId, terminalId) => {
          session.terminalCalls.add(toolCallId);
          return this.update(session, {
            sessionUpdate: "tool_call_update",
            toolCallId,
            content: [{ type: "terminal", terminalId }],
          });
        },
      },
      session.upstream?.tools ?? [],
    );
    const input = new Pushable<SDKUserMessage>();
    const query = this.options.runQuery({
      prompt: input,
      options: buildOptions({
        session,
        // A session whose agent died is picked up where the CLI saved it.
        resume: session.started,
        executable: this.options.executable,
        canUseTool: this.canUseTool(session),
        editorTools: tools,
        questions: this.forms,
        ...(this.forms && { elicit: this.elicit(session) }),
        stderr,
      }),
    });
    log.info(
      `[${session.id}] Starting claude, ${session.started ? "resuming the session" : "new session"}, ${tools ? `tools of the editor: ${Object.keys(tools.aliases).join(", ")}` : "its own tools"}`,
    );
    session.live = { query, input, messages: query[Symbol.asyncIterator](), stderrTail };
    return session.live;
  }

  /** One prompt: hand it to the agent and relay what it says until the turn ends. */
  private async turn(session: Session, content: ContentBlockParam[]): Promise<Run> {
    const live = await this.start(session);
    let finish!: () => void;
    const running: RunningPrompt = {
      query: live.query,
      cancelled: false,
      done: new Promise((resolve) => (finish = resolve)),
    };
    session.running = running;
    session.lastUsedAt = Date.now();
    live.input.push(userMessage(content));

    const mapper = new UpdateMapper(session);
    const run: Run = { died: false, cancelled: false, loggedOut: false, stderr: "" };
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
          // A loaded session is resumed rather than new, and still hears it.
          if (!session.introduced) {
            const servers = (message.mcp_servers ?? [])
              .map((server) => `${server.name}=${server.status}`)
              .join(", ");
            log.info(
              `[${session.id}] Claude Code ${message.claude_code_version} on ${message.model}` +
                (servers === "" ? "" : `, MCP: ${servers}`),
            );
            session.started = true;
            if (await loggedOut(live)) {
              log.warn(`[${session.id}] The CLI is not logged in`);
              run.loggedOut = true;
              break;
            }
            // Only now: a user who signs in and prompts again still hears it.
            session.introduced = true;
            await this.offerModels(session, live, message.model);
            await this.offerCommands(session, live);
          }
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
      session.lastUsedAt = Date.now();
      finish();
    }
    run.cancelled = running.cancelled;
    run.stderr = live.stderrTail.join("\n");
    // A dead agent leaves nothing to push the next prompt into, and a
    // logged-out one is worth replacing once its user has signed in. The
    // session itself stays: the CLI saved it and the next agent resumes it.
    if (run.died || run.loggedOut) {
      session.live?.query.close();
      session.live = undefined;
    }
    return run;
  }

  /** Replace the picker's guesses with the models the account really has. */
  private async offerModels(session: Session, live: LiveQuery, resolved: string): Promise<void> {
    try {
      const models = await live.query.supportedModels();
      session.models = modelOptions(models);
      session.effortLevels = effortLevels(models, resolved);
    } catch (e) {
      log.warn(`[${session.id}] Could not read the model list: ${(e as Error).message}`);
      return;
    }
    await this.update(session, {
      sessionUpdate: "config_option_update",
      configOptions: configOptions(session),
    });
  }

  /** Tell the editor which slash commands the CLI knows, so it can offer them. */
  private async offerCommands(session: Session, live: LiveQuery): Promise<void> {
    let commands;
    try {
      commands = await live.query.supportedCommands();
    } catch (e) {
      log.warn(`[${session.id}] Could not read the command list: ${(e as Error).message}`);
      return;
    }
    await this.update(session, {
      sessionUpdate: "available_commands_update",
      availableCommands: commands.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint !== "" && { input: { hint: command.argumentHint } }),
      })),
    });
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.session(params.sessionId);
    if (typeof params.value !== "string") {
      throw RequestError.invalidParams(undefined, `option '${params.configId}' takes a value id`);
    }
    const chosen = params.value === DEFAULT_MODEL ? undefined : params.value;
    switch (params.configId) {
      case MODEL_CONFIG_ID:
        session.model = chosen;
        await session.live?.query.setModel(session.model);
        break;
      case EFFORT_CONFIG_ID:
        session.effort = chosen;
        await this.restart(session);
        break;
      case THINKING_CONFIG_ID:
        session.thinking = chosen;
        await this.restart(session);
        break;
      default:
        throw RequestError.invalidParams(undefined, `unknown option '${params.configId}'`);
    }
    log.info(`[${session.id}] ${params.configId} ${chosen ?? DEFAULT_MODEL}`);
    return { configOptions: configOptions(session) };
  }

  /**
   * Some settings only take hold when an agent starts. An idle one is
   * stopped so the next prompt gets an agent that has them, resuming the
   * conversation; a busy one keeps working and the change waits for it.
   */
  private async restart(session: Session): Promise<void> {
    if (session.running || !session.live) {
      return;
    }
    session.live.query.close();
    session.live = undefined;
  }

  /** Every action the mode and settings leave to a human goes to the editor's dialog. */
  private canUseTool(session: Session): CanUseTool {
    return async (toolName, input, { signal, suggestions, toolUseID }) => {
      if (session.running?.cancelled) {
        return CANCELLED;
      }
      // A question is not an action to approve: the editor shows it as a
      // form and the answers go back as the tool's own input.
      if (toolName === "AskUserQuestion" && this.forms) {
        return this.askQuestions(session, input, toolUseID, signal);
      }
      // Reading inside the session's folders is what the built-in Read does
      // without asking; the redirect must not turn it into a dialog.
      if (toolName === READ_TOOL && insideWorkspace(input.file_path, session.readable)) {
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

  /** Carry an MCP server's request for input to the editor and back. */
  private elicit(session: Session): OnElicitation {
    return async (request, { signal }) => {
      const form = mcpForm(request, session.id);
      if (!form) {
        log.info(
          `[${session.id}] Declined a ${request.mode} elicitation from ${request.serverName}`,
        );
        return { action: "decline" };
      }
      try {
        const response = await this.editor.request(methods.client.elicitation.create, form, {
          cancellationSignal: signal,
        });
        return mcpResult(response);
      } catch (e) {
        log.warn(`[${session.id}] Could not show the elicitation: ${(e as Error).message}`);
        return { action: "cancel" };
      }
    };
  }

  /** Put the agent's questions to the user and hand back what they answered. */
  private async askQuestions(
    session: Session,
    input: Input,
    toolUseID: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = questionsOf(input);
    if (!questions) {
      return { behavior: "deny", message: "AskUserQuestion was called without any question." };
    }
    let response;
    try {
      response = await this.editor.request(
        methods.client.elicitation.create,
        questionForm(questions, session.id, toolUseID),
        { cancellationSignal: signal },
      );
    } catch (e) {
      log.warn(`[${session.id}] Could not put the question to the user: ${(e as Error).message}`);
      return CANCELLED;
    }
    const answers = answersFrom(response, input, questions);
    if (!answers.answered) {
      return { behavior: "deny", message: "The user closed the question without answering." };
    }
    log.info(`[${session.id}] Answered ${questions.length} question(s)`);
    return { behavior: "allow", updatedInput: answers.input };
  }

  private async update(session: Session, update: SessionUpdate): Promise<void> {
    await this.editor.notify(methods.client.session.update, { sessionId: session.id, update });
  }
}

/**
 * Whether the CLI has no credential at all. A third-party backend carries
 * its own (AWS keys, gcloud), so only a first-party account can be empty in
 * a way the user can fix by signing in.
 */
async function loggedOut(live: LiveQuery): Promise<boolean> {
  let account: AccountInfo;
  try {
    account = await live.query.accountInfo();
  } catch {
    // An older CLI without the request is not a reason to refuse the turn.
    return false;
  }
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    return false;
  }
  return !account.email && !account.organization && !account.apiKeySource && !account.tokenSource;
}

/** What a saved conversation is called: the user's own name for it, else what the CLI made of it. */
function titleOf(info: SDKSessionInfo): { title?: string } {
  const title = info.customTitle?.trim() || info.summary?.trim() || info.firstPrompt?.trim();
  return title ? { title: title.length > 120 ? `${title.slice(0, 117)}...` : title } : {};
}

/** When it was last written, as a timestamp the editor can read. */
function when(lastModified: number | undefined): { updatedAt?: string } {
  if (lastModified === undefined || !Number.isFinite(lastModified)) {
    return {};
  }
  // Older CLIs count in seconds, newer ones in milliseconds.
  const ms = lastModified < 1e12 ? lastModified * 1000 : lastModified;
  return { updatedAt: new Date(ms).toISOString() };
}

/** How the prompt ended, or the error the editor shows. */
function response(session: Session, run: Run): PromptResponse {
  if (run.cancelled) {
    return { stopReason: "cancelled" };
  }
  if (run.loggedOut) {
    throw RequestError.authRequired(undefined, LOGIN_MESSAGE);
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
  if (result.subtype === "success" && result.api_error_status === 401) {
    log.warn(`[${session.id}] The API refused the credential`);
    throw RequestError.authRequired(undefined, LOGIN_MESSAGE);
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

/**
 * Every server the editor described, in the SDK's shape, with nothing left
 * out. This is what the host itself may connect to when it proxies; what
 * the CLI is allowed to run goes through `mcpServers`.
 */
export function serverConfigs(servers: McpServer[]): Record<string, McpServerConfig> {
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
    }
  }
  return configs;
}

/**
 * The MCP servers an editor asks for, as far as they are allowed.
 *
 * A stdio server is a command the CLI runs, so passing one on is running a
 * program the editor named. Nothing is passed on unless `--allow-mcp` says
 * so, which also keeps the editor and the CLI from meeting each other
 * behind this host's back.
 */
export function mcpServers(
  servers: McpServer[],
  allowed: Allowed,
): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    const pairs = (list: { name: string; value: string }[]) =>
      Object.fromEntries(list.map((p) => [p.name, p.value]));
    let config: McpServerConfig | undefined;
    let what: string;
    if (!("type" in server)) {
      config = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: pairs(server.env),
      };
      what = `stdio ${[server.command, ...server.args].join(" ")}`;
    } else if (server.type === "http" || server.type === "sse") {
      config = { type: server.type, url: server.url, headers: pairs(server.headers) };
      what = `${server.type} ${server.url}`;
    } else {
      what = `transport '${server.type}', which this host does not speak`;
    }
    // Secrets live in the values of env and headers; only their names are logged.
    const carried = !("type" in server)
      ? server.env.map((variable) => variable.name)
      : server.type === "http" || server.type === "sse"
        ? server.headers.map((header) => header.name)
        : [];
    const named = carried.length === 0 ? "" : `, carrying ${carried.join(", ")}`;
    if (config && (allowed === "all" || allowed.includes(server.name))) {
      configs[server.name] = config;
      log.info(`MCP server '${server.name}' of the editor: ${what}${named}`);
    } else {
      log.info(
        `MCP server '${server.name}' of the editor left out: ${what}${named}` +
          (config ? `; --allow-mcp ${server.name} passes it to the CLI` : ""),
      );
    }
  }
  return configs;
}
