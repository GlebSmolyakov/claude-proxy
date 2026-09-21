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
