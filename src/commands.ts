// Slash commands this host answers itself.
//
// The CLI has its own, and the editor gets them from it; these are added to
// that list. A prompt that is one of them never reaches the model: the host
// does the work and says what happened, which is how an editor gets things
// the protocol has no method for.

import type { ContentBlock } from "@agentclientprotocol/sdk";

import type { AgentQuery } from "./agent.js";
import type { Session } from "./session.js";
import { shorten } from "./tools.js";

/** One choice offered to the user when a command needs them to pick. */
export interface Choice {
  id: string;
  name: string;
  description?: string;
}

export interface CommandContext {
  session: Session;
  /** Whatever followed the command's name. */
  args: string;
  /** The session's agent, started if it was not running. */
  agent: () => Promise<AgentQuery>;
  /**
   * Ask the user to pick one, where the editor can show a form. Absent when
   * it cannot, and then a command says what to type instead.
   */
  choose?: (title: string, choices: Choice[]) => Promise<string | undefined>;
}

export interface HostCommand {
  name: string;
  description: string;
  argumentHint?: string;
  /** Does the work and answers with what to tell the user. */
  run: (context: CommandContext) => Promise<string>;
}

/** How many past prompts `/rewind` offers to go back to. */
const REWIND_CHOICES = 10;

export const HOST_COMMANDS: HostCommand[] = [
  {
    name: "rewind",
    description: "Undo the file changes since one of your earlier prompts",
    argumentHint: "[number]",
    run: rewind,
  },
  {
    name: "usage",
    description: "What the subscription and the context have left",
    run: usage,
  },
  {
    name: "mcp",
    description: "MCP servers of this session, and turning one off or back on",
    argumentHint: "[on|off|reconnect <server>]",
    run: mcp,
  },
];

/** The command a prompt is, when it is one of this host's own. */
export function hostCommand(prompt: ContentBlock[]): { command: HostCommand; args: string } | null {
  const spoken = prompt
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .trim();
  if (!spoken.startsWith("/")) {
    return null;
  }
  const space = spoken.search(/\s/);
  const name = (space < 0 ? spoken.slice(1) : spoken.slice(1, space)).trim();
  const command = HOST_COMMANDS.find((c) => c.name === name);
  return command ? { command, args: space < 0 ? "" : spoken.slice(space).trim() } : null;
}

/**
 * Put the files back as they were when a prompt was sent. The CLI keeps the
 * backups; this only has to say which prompt to go back to, and a prompt is
 * something the user recognises by what they typed.
 */
async function rewind({ session, args, agent, choose }: CommandContext): Promise<string> {
  // A command of this host's own is not one of the session's prompts, so
  // everything remembered here is something the agent worked on.
  const past = session.prompts.slice(-REWIND_CHOICES).reverse();
  if (past.length === 0) {
    return "Nothing to rewind: this session has not changed any files yet.";
  }

  const numbered = past.map((prompt, i) => `${i + 1}. ${shorten(prompt.text)}`);
  let chosen = past[0];
  if (args !== "") {
    const which = Number(args);
    if (!Number.isInteger(which) || which < 1 || which > past.length) {
      return [`'${args}' is not one of these prompts:`, ...numbered].join("\n");
    }
    chosen = past[which - 1];
  } else if (choose) {
    const picked = await choose(
      "Undo the file changes made since which prompt?",
      past.map((prompt, i) => ({ id: prompt.uuid, name: `${i + 1}. ${shorten(prompt.text)}` })),
    );
    if (picked === undefined) {
      return "Left everything as it is.";
    }
    chosen = past.find((prompt) => prompt.uuid === picked) ?? chosen;
  } else {
    // No form to show, so the user picks by number in a second go.
    return ["Rewind to which prompt? Send `/rewind <number>`:", ...numbered].join("\n");
  }

  const done = await (await agent()).rewindFiles(chosen.uuid);
  if (!done.canRewind) {
    return `Could not rewind: ${done.error ?? "the CLI kept no backups for this session"}.`;
  }
  const files = done.filesChanged ?? [];
  if (files.length === 0) {
    return `Nothing to undo since "${shorten(chosen.text)}": no tracked file has changed.`;
  }
  const counted = `${files.length} file${files.length === 1 ? "" : "s"}`;
  const lines = `+${done.insertions ?? 0}/-${done.deletions ?? 0}`;
  const skipped = done.skippedLinks
    ? ` ${done.skippedLinks} were left alone as links or moved files.`
    : "";
  return [
    `Put ${counted} back as they were before "${shorten(chosen.text)}" (${lines}).${skipped}`,
    ...files.map((file) => `- ${file}`),
  ].join("\n");
}

/**
 * Where the subscription and the context stand right now. The CLI reports
 * its limits only when one moves, so a user who wants to know before
 * starting something long has nothing to look at otherwise.
 */
async function usage({ session, agent }: CommandContext): Promise<string> {
  const query = await agent();
  const lines: string[] = [];

  try {
    const spent = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
    const plan = spent.subscription_type ? `${spent.subscription_type} plan` : "This account";
    if (!spent.rate_limits_available || !spent.rate_limits) {
      lines.push(`${plan}: no plan limits apply to it.`);
    } else {
      const windows = Object.entries(spent.rate_limits).flatMap(([name, window]) =>
        window !== null && typeof window === "object" && "utilization" in window
          ? [[name, window as Window] as const]
          : [],
      );
      const said = windows.flatMap(([name, window]) =>
        window.utilization === null ? [] : [`${WINDOWS[name] ?? name} ${percent(window)}`],
      );
      lines.push(
        said.length === 0 ? `${plan}: nothing spent yet.` : `${plan}: ${said.join(", ")}.`,
      );
    }
  } catch (e) {
    lines.push(`The subscription did not answer: ${(e as Error).message}`);
  }

  try {
    const context = await query.getContextUsage({ detail: "summary" });
    const used = context.categories
      .filter((category) => category.kind === "used")
      .reduce((sum, category) => sum + category.tokens, 0);
    lines.push(
      `Context: ${Math.round(context.percentage)}% of ${thousands(context.maxTokens)} tokens, ${thousands(used)} of it this conversation.`,
    );
  } catch {
    // An older CLI without the request; the window size the turns report is
    // all this session knows.
    lines.push(`Context window: ${thousands(session.contextWindow)} tokens.`);
  }
  return lines.join("\n");
}

interface Window {
  utilization: number | null;
  resets_at?: string | null;
}

/** The names of the windows, as a person would say them. */
const WINDOWS: Record<string, string> = {
  five_hour: "five-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_oauth_apps: "weekly apps",
  seven_day_overage_included: "weekly with overage",
  overage: "overage",
};

/** These windows count in whole percent, unlike the ones a turn reports. */
function percent(window: Window): string {
  const at = `${Math.round(window.utilization ?? 0)}%`;
  if (!window.resets_at) {
    return at;
  }
  const when = new Date(window.resets_at);
  return Number.isNaN(when.getTime()) ? at : `${at} until ${when.toLocaleString()}`;
}

const thousands = (n: number) => n.toLocaleString("en-US");

/**
 * The MCP servers of a session: the CLI's own, which it can be told to turn
 * off or reconnect, and the ones this host carries over itself, which are
 * its own business and the flags' choice.
 */
async function mcp({ session, args, agent }: CommandContext): Promise<string> {
  const query = await agent();
  const [verb, ...rest] = args.split(/\s+/).filter(Boolean);
  const server = rest.join(" ");

  if (verb !== undefined) {
    if (!["on", "off", "reconnect"].includes(verb) || server === "") {
      return "Say `/mcp`, or `/mcp off <server>`, `/mcp on <server>`, `/mcp reconnect <server>`.";
    }
    if (session.upstream?.tools.some((tool) => tool.name.startsWith(`${server}__`))) {
      return `'${server}' is carried over by this host, not run by the CLI; --proxy-mcp is what decides it.`;
    }
    try {
      if (verb === "reconnect") {
        await query.reconnectMcpServer(server);
        return `Reconnected '${server}'.`;
      }
      await query.toggleMcpServer(server, verb === "on");
      return `Turned '${server}' ${verb}.`;
    } catch (e) {
      return `Could not do that to '${server}': ${(e as Error).message}`;
    }
  }

  const lines: string[] = [];
  const status = await query.mcpServerStatus();
  lines.push(
    status.length === 0 ? "The CLI runs no MCP servers in this session." : "The CLI's servers:",
    ...status.map(
      (server) =>
        `- ${server.name}: ${server.status}${server.serverInfo ? ` (${server.serverInfo.name} ${server.serverInfo.version})` : ""}`,
    ),
  );
  const carried = session.upstream?.tools ?? [];
  if (carried.length > 0) {
    lines.push(
      `Carried over by this host: ${carried.length} tool${carried.length === 1 ? "" : "s"}.`,
      ...carried.map((tool) => `- ${tool.name}`),
    );
  }
  return lines.join("\n");
}
