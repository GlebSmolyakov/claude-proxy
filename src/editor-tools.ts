// The tools the editor serves for the agent: its file buffers and its
// terminal.
//
// Whatever the client says it can do, the matching built-in tool is
// redirected to a tool here. Files go through ACP's `fs/read_text_file` and
// `fs/write_text_file`, so the agent sees changes the user has not saved and
// its own edits land where they can be seen and undone; a command goes into
// a terminal the user watches.

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import { type AgentContext, type ClientCapabilities, methods } from "@agentclientprotocol/sdk";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { bashTool } from "./terminal.js";

/** The part of the connection the host talks to the editor through. */
export type Editor = Pick<AgentContext, "request" | "notify">;

/** Name of the in-process MCP server that carries the tools. */
export const SERVER = "acp";

const named = (name: string) => `mcp__${SERVER}__${name}`;

/** Reading is redirected to this tool, which the host approves inside the workspace. */
export const READ_TOOL = named("read");

/** A redirected call keeps the card of the built-in tool it stands for. */
export const REDIRECTED: Record<string, string> = {
  [named("read")]: "Read",
  [named("write")]: "Write",
  [named("edit")]: "Edit",
  [named("bash")]: "Bash",
};

/** Images have no text to fetch; they are read from disk as the built-in Read does. */
const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** What an in-process server takes, whatever shapes its tools were built from. */
export type Tools = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>;

export interface EditorTools {
  server: McpSdkServerConfigWithInstance;
  /** Built-in names the model emits → the tool that runs instead. */
  aliases: Record<string, string>;
}

export interface Deps {
  sessionId: string;
  cwd: string;
  editor: Editor;
}

/** What a session needs from the editor beyond reading and writing files. */
export interface TerminalSupport {
  attach: (toolCallId: string, terminalId: string) => Promise<void>;
  terminals: Set<string>;
  /** Where the session's commands run from; a `cd` moves it. */
  shell?: { cwd: string };
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const failure = (s: string) => ({ ...text(s), isError: true });

/**
 * The tools for a session, or `undefined` when the editor serves nothing and
 * the agent works on its own, as it does in a terminal.
 */
export function editorTools(
  deps: Deps,
  capabilities: ClientCapabilities | undefined,
  terminals: TerminalSupport,
  proxied: Tools = [],
): EditorTools | undefined {
  const canRead = capabilities?.fs?.readTextFile === true;
  const canWrite = capabilities?.fs?.writeTextFile === true;
  const canRun = capabilities?.terminal === true;
  if (!canRead && !canWrite && !canRun && proxied.length === 0) {
    return undefined;
  }

  const tools: Tools = [...proxied];
  const aliases: Record<string, string> = {};
  if (canRead) {
    tools.push(readTool(deps));
    aliases.Read = READ_TOOL;
  }
  if (canWrite) {
    tools.push(writeTool(deps));
    aliases.Write = named("write");
  }
  // An edit is a read and a write, so it needs both ends of the channel.
  if (canRead && canWrite) {
    tools.push(editTool(deps));
    aliases.Edit = named("edit");
  }
  if (canRun) {
    tools.push(bashTool({ ...deps, ...terminals }));
    aliases.Bash = named("bash");
  }
  return { server: createSdkMcpServer({ name: SERVER, tools, alwaysLoad: true }), aliases };
}

export function readTool(deps: Deps) {
  return tool(
    "read",
    "Read a file as the user sees it in the editor, including changes they have not saved.",
    {
      file_path: z.string().describe("Absolute path of the file to read."),
      offset: z.number().optional().describe("The line to start from, counting from 1."),
      limit: z.number().optional().describe("How many lines to read."),
    },
    async (args) => {
      const path = absolute(args.file_path, deps.cwd);
      const image = IMAGES[extname(path).toLowerCase()];
      if (image) {
        const data = await readFile(path);
        return {
          content: [{ type: "image" as const, data: data.toString("base64"), mimeType: image }],
        };
      }
      const content = await read(deps, path, args.offset, args.limit);
      return content === ""
        ? text("The file is empty.")
        : text(numbered(content, args.offset ?? 1));
    },
  );
}

export function writeTool(deps: Deps) {
  return tool(
    "write",
    "Write a file through the editor, replacing everything in it.",
    {
      file_path: z.string().describe("Absolute path of the file to write."),
      content: z.string().describe("The full new contents of the file."),
    },
    async (args) => {
      const path = absolute(args.file_path, deps.cwd);
      await write(deps, path, args.content);
      return text(`Wrote ${path} through the editor.`);
    },
  );
}

export function editTool(deps: Deps) {
  return tool(
    "edit",
    "Replace text in a file through the editor.",
    {
      file_path: z.string().describe("Absolute path of the file to edit."),
      old_string: z.string().describe("The text to replace."),
      new_string: z.string().describe("The text to replace it with."),
      replace_all: z.boolean().optional().describe("Replace every occurrence, not just one."),
    },
    async (args) => {
      const path = absolute(args.file_path, deps.cwd);
      if (args.old_string === "") {
        return failure("old_string must not be empty; use write to create a file.");
      }
      if (args.old_string === args.new_string) {
        return failure("old_string and new_string are the same, so there is nothing to change.");
      }
      const content = await read(deps, path);
      const found = content.split(args.old_string).length - 1;
      if (found === 0) {
        return failure(`The text to replace is not in ${path}.`);
      }
      if (found > 1 && args.replace_all !== true) {
        return failure(
          `The text to replace appears ${found} times in ${path}. Include more of what surrounds it, or pass replace_all.`,
        );
      }
      // A function replacement keeps `$` in the new text literal.
      const updated = args.replace_all
        ? content.split(args.old_string).join(args.new_string)
        : content.replace(args.old_string, () => args.new_string);
      await write(deps, path, updated);
      const times = args.replace_all
        ? `${found} occurrence${found === 1 ? "" : "s"}`
        : "1 occurrence";
      return text(`Replaced ${times} in ${path} through the editor.`);
    },
  );
}

async function read(deps: Deps, path: string, offset?: number, limit?: number): Promise<string> {
  const { content } = await deps.editor.request(methods.client.fs.readTextFile, {
    sessionId: deps.sessionId,
    path,
    ...(offset !== undefined && { line: offset }),
    ...(limit !== undefined && { limit }),
  });
  return content;
}

async function write(deps: Deps, path: string, content: string): Promise<void> {
  await deps.editor.request(methods.client.fs.writeTextFile, {
    sessionId: deps.sessionId,
    path,
    content,
  });
}

/**
 * Folders narrow enough to read from without asking. A home directory, the
 * filesystem root or anything above a home is too much to hand over on the
 * editor's word alone: reads there go to the dialog like anywhere else.
 */
export function narrowRoots(roots: string[], home: string): string[] {
  const inHome = resolve(home);
  return roots.filter((root) => {
    const full = resolve(root);
    // The root itself, a home directory, and every folder a home sits in.
    const broad = full === sep || full === inHome || inHome.startsWith(`${full}${sep}`);
    return !broad;
  });
}

/**
 * Whether a file belongs to the session's folders. Reading one of those is
 * the agent's daily work and asks for no approval, as the built-in Read does
 * not ask; anything outside still goes to the editor's dialog.
 */
export function insideWorkspace(path: unknown, roots: string[]): boolean {
  if (typeof path !== "string" || path === "") {
    return false;
  }
  const full = resolve(path);
  return roots.some((root) => {
    const from = relative(resolve(root), full);
    return from === "" || (!from.startsWith(`..${sep}`) && from !== ".." && !isAbsolute(from));
  });
}

/** ACP paths are absolute; a relative one is taken from the session's folder. */
function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Lines numbered from `start`, the way the built-in Read numbers them. */
function numbered(content: string, start: number): string {
  return content
    .replace(/\n$/, "")
    .split("\n")
    .map((line, i) => `${start + i}\t${line}`)
    .join("\n");
}
