// An editor on the other end of the protocol.
//
// It speaks ACP the way a real one does: it keeps the buffers the user has
// open, opens terminals and lets their commands finish, shows permission
// dialogs and forms, and takes down every update it was sent. Tests drive
// it like a user — open a session, type a prompt, answer the dialog — and
// then read back what the user would have seen.

import {
  client as acpClient,
  type ClientCapabilities,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  methods,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

import { type ClaudeProxyAgent, createApp, type HostOptions } from "./acp-agent.js";
import type { Fake } from "./agent.test-support.js";
import { OPTION } from "./permissions.js";

/** Everything this editor serves, which is what a rich one like Air does. */
export const EVERYTHING: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  elicitation: { form: {} },
};

/** The user clicks the first button; the usual answer, so it is the default. */
export const ALLOW = (): RequestPermissionResponse => ({
  outcome: { outcome: "selected", optionId: OPTION.allow },
});
export const REJECT = (): RequestPermissionResponse => ({
  outcome: { outcome: "selected", optionId: OPTION.reject },
});

/** What a command does when the user's terminal runs it. */
export interface Command {
  output?: string;
  exitCode?: number;
  /** Settles when the command is over; it ends at once when absent. */
  ends?: Promise<void>;
}

/** A terminal the editor opened, as the user would see it. */
export interface Terminal {
  id: string;
  /** The command line itself, without the shell that runs it. */
  command: string;
  cwd: string;
  output: string;
  exitCode: number;
  killed: boolean;
  released: boolean;
}

export interface EditorOptions {
  /** Buffers the user has open: path → what is in them right now. */
  files?: Record<string, string>;
  /** What this editor serves; a fully equipped one by default. */
  capabilities?: ClientCapabilities;
  /** What each command line does in the terminal. */
  commands?: Record<string, Command>;
  /** How the user answers a permission dialog. */
  answer?: (request: RequestPermissionRequest) => RequestPermissionResponse;
  /** How the user fills in a form; closed without answering by default. */
  fill?: (request: CreateElicitationRequest) => CreateElicitationResponse;
  /** Anything about the host itself this test wants different. */
  host?: Partial<HostOptions>;
}

/** A tool call as the editor shows it, with every update folded into it. */
export interface Card {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: unknown[];
  locations?: { path: string }[];
  rawInput?: Record<string, unknown>;
}

export function openEditor(agent: Fake, options: EditorOptions = {}) {
  const updates: SessionNotification[] = [];
  const dialogs: RequestPermissionRequest[] = [];
  const forms: CreateElicitationRequest[] = [];
  const files = new Map(Object.entries(options.files ?? {}));
  const terminals: Terminal[] = [];
  const running = new Map<string, () => void>();
  let host!: ClaudeProxyAgent;

  const terminal = (id: string): Terminal => {
    const found = terminals.find((t) => t.id === id);
    if (!found) {
      throw new Error(`the agent asked about terminal ${id}, which was never opened`);
    }
    return found;
  };

  const connection = acpClient({ name: "test-editor" })
    .onNotification(methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .onRequest(methods.client.session.requestPermission, (ctx) => {
      dialogs.push(ctx.params);
      return (options.answer ?? ALLOW)(ctx.params);
    })
    .onRequest(methods.client.elicitation.create, (ctx) => {
      forms.push(ctx.params);
      return options.fill ? options.fill(ctx.params) : { action: "cancel" };
    })
    .onRequest(methods.client.fs.readTextFile, (ctx) => {
      const content = files.get(ctx.params.path);
      if (content === undefined) {
        throw new Error(`no buffer for ${ctx.params.path}`);
      }
      const from = (ctx.params.line ?? 1) - 1;
      const lines = content.split("\n");
      const taken = lines.slice(from, ctx.params.limit ? from + ctx.params.limit : undefined);
      return { content: from === 0 && ctx.params.limit == null ? content : taken.join("\n") };
    })
    .onRequest(methods.client.fs.writeTextFile, (ctx) => {
      files.set(ctx.params.path, ctx.params.content);
      return {};
    })
    .onRequest(methods.client.terminal.create, (ctx) => {
      const id = `term-${terminals.length + 1}`;
      const args = ctx.params.args ?? [];
      const line = args[args.length - 1] ?? "";
      const command = options.commands?.[line] ?? {};
      terminals.push({
        id,
        command: line,
        cwd: ctx.params.cwd ?? "",
        output: command.output ?? "",
        exitCode: command.exitCode ?? 0,
        killed: false,
        released: false,
      });
      running.set(id, () => {});
      return { terminalId: id };
    })
    .onRequest(methods.client.terminal.waitForExit, async (ctx) => {
      const line = terminal(ctx.params.terminalId).command;
      const ends = options.commands?.[line]?.ends;
      if (ends) {
        // The command runs until the test says it is over, or it is killed.
        await Promise.race([
          ends,
          new Promise<void>((resolve) => running.set(ctx.params.terminalId, resolve)),
        ]);
      }
      return { exitCode: terminal(ctx.params.terminalId).exitCode };
    })
    .onRequest(methods.client.terminal.output, (ctx) => {
      const found = terminal(ctx.params.terminalId);
      return {
        output: found.output,
        truncated: false,
        exitStatus: { exitCode: found.exitCode },
      };
    })
    .onRequest(methods.client.terminal.kill, (ctx) => {
      terminal(ctx.params.terminalId).killed = true;
      running.get(ctx.params.terminalId)?.();
      return {};
    })
    .onRequest(methods.client.terminal.release, (ctx) => {
      terminal(ctx.params.terminalId).released = true;
      running.get(ctx.params.terminalId)?.();
      return {};
    })
    .connect(
      createApp(
        {
          executable: "/bin/claude",
          permissionMode: "default",
          runQuery: agent.runQuery,
          readSession: async () => [],
          listSessions: async () => [],
          idleMs: 30 * 60_000,
          allowMcp: [],
          proxyMcp: {},
          version: "0.0.0-test",
          ...options.host,
        },
        (h) => (host = h),
      ),
    );

  const editor = connection.agent;
  let current = "";

  /** Text the agent said, as one piece, the way the user reads it. */
  const of = (kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk") =>
    updates
      .map((u) => u.update)
      .flatMap((u) =>
        u.sessionUpdate === kind && u.content.type === "text" ? [u.content.text] : [],
      )
      .join("");

  return {
    updates,
    dialogs,
    forms,
    files,
    terminals,
    host: () => host,
    connection,

    async start(capabilities = options.capabilities ?? EVERYTHING) {
      await editor.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: capabilities,
      });
      return this;
    },

    async open(cwd = "/repo", extra: Partial<{ additionalDirectories: string[] }> = {}) {
      const { sessionId } = await editor.request(methods.agent.session.new, {
        cwd,
        mcpServers: [],
        ...extra,
      });
      current = sessionId;
      return sessionId;
    },

    /** The user types a prompt and waits for the answer. */
    prompt(text: string, sessionId = current): Promise<PromptResponse> {
      return editor.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
    },

    cancel(sessionId = current) {
      return editor.notify(methods.agent.session.cancel, { sessionId });
    },

    close(sessionId = current) {
      return editor.request(methods.agent.session.close, { sessionId });
    },

    setMode(modeId: string, sessionId = current) {
      return editor.request(methods.agent.session.setMode, { sessionId, modeId });
    },

    said: () => of("agent_message_chunk"),
    thought: () => of("agent_thought_chunk"),
    kinds: () => updates.map((u) => u.update.sessionUpdate),

    /** Every tool call the user sees, with its updates folded in. */
    cards(): Card[] {
      const cards = new Map<string, Card>();
      for (const { update } of updates) {
        if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
          continue;
        }
        const seen = { ...update } as Partial<Card> & { sessionUpdate?: string };
        delete seen.sessionUpdate;
        cards.set(update.toolCallId, { ...cards.get(update.toolCallId), ...seen } as Card);
      }
      return [...cards.values()];
    },

    /** What the user has in a buffer now, saved or not. */
    file: (path: string) => files.get(path),
  };
}
