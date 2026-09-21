// How a Claude Code tool call looks in the editor: its card (title, kind,
// content, locations), what the result adds to the card, and the plan that
// the task tools keep.

import { relative, resolve, sep } from "node:path";

import type {
  ContentBlock,
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";

import { REDIRECTED } from "./editor-tools.js";

export type Input = Record<string, unknown>;

export interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
}

/** Tools that keep the plan; they show up as the plan, not as cards. */
export const PLAN_TOOLS: ReadonlySet<string> = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

/** Tools whose card shows a diff built from the input; their result adds nothing to it. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const textContent = (text: string): ToolCallContent => ({
  type: "content",
  content: { type: "text", text },
});

/** One line of at most `limit` characters, for a title or a list. */
export function shorten(text: string, limit = 60): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one;
}

/** A path inside the working directory is shown relative to it. */
export function displayPath(path: string, cwd: string): string {
  const root = resolve(cwd);
  const full = resolve(root, path);
  return full.startsWith(root + sep) ? relative(root, full) : path;
}

export function toolInfo(rawName: string, input: Input, cwd: string): ToolInfo {
  // A file tool that runs through the editor shows the card of the built-in
  // tool the model asked for.
  const name = REDIRECTED[rawName] ?? rawName;
  // A tool this host carries over from a server of the editor keeps that
  // server's name in front: `mcp__acp__Air__browser-click` → `Air: browser-click`.
  const carried = name.startsWith("mcp__acp__") ? name.slice("mcp__acp__".length) : "";
  // The server comes first, so the first `__` is the seam; what follows is
  // the tool's own name, `__` and all.
  const seam = carried.indexOf("__");
  if (seam > 0) {
    const title = `${carried.slice(0, seam)}: ${carried.slice(seam + 2)}`;
    return { title, kind: "other", content: [], locations: [] };
  }
  const card = (
    title: string,
    kind: ToolKind,
    content: ToolCallContent[] = [],
    locations: ToolCallLocation[] = [],
  ): ToolInfo => ({ title, kind, content, locations });
  const path = str(input.file_path) ?? str(input.notebook_path);
  const shown = path && displayPath(path, cwd);
  const at = path ? [{ path }] : [];

  switch (name) {
    case "Agent":
    case "Task": {
      const prompt = str(input.prompt);
      return card(str(input.description) ?? "Task", "think", prompt ? [textContent(prompt)] : []);
    }
    case "Bash": {
      const description = str(input.description);
      return card(
        str(input.command) ?? "Terminal",
        "execute",
        description ? [textContent(description)] : [],
      );
    }
    case "Read": {
      const offset = num(input.offset);
      const limit = num(input.limit);
      const range = limit
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset
          ? ` (from line ${offset})`
          : "";
      return card(
        `Read ${shown ?? "file"}${range}`,
        "read",
        [],
        path ? [{ path, line: offset ?? 1 }] : [],
      );
    }
    case "Write": {
      const content = typeof input.content === "string" ? input.content : undefined;
      const diff: ToolCallContent[] =
        path && content !== undefined
          ? [{ type: "diff", path, oldText: null, newText: content }]
          : [];
      return card(shown ? `Write ${shown}` : "Write", "edit", diff, at);
    }
    case "Edit": {
      const oldText = typeof input.old_string === "string" ? input.old_string : "";
      const newText = typeof input.new_string === "string" ? input.new_string : "";
      const diff: ToolCallContent[] =
        path && (oldText || newText)
          ? [{ type: "diff", path, oldText: oldText || null, newText }]
          : [];
      return card(shown ? `Edit ${shown}` : "Edit", "edit", diff, at);
    }
    case "NotebookEdit":
      return card(shown ? `Edit ${shown}` : "Edit notebook", "edit", [], at);
    case "Glob": {
      const where = str(input.path);
      const title = ["Find", where && `\`${where}\``, str(input.pattern) && `\`${input.pattern}\``];
      return card(title.filter(Boolean).join(" "), "search", [], where ? [{ path: where }] : []);
    }
    case "Grep": {
      const where = str(input.path);
      return card(`grep "${str(input.pattern) ?? ""}"${where ? ` ${where}` : ""}`, "search");
    }
    case "WebFetch": {
      const prompt = str(input.prompt);
      const url = str(input.url);
      return card(url ? `Fetch ${url}` : "Fetch", "fetch", prompt ? [textContent(prompt)] : []);
    }
    case "WebSearch": {
      const query = str(input.query);
      return card(query ? `Search "${query}"` : "Web search", "fetch");
    }
    case "ExitPlanMode": {
      const plan = str(input.plan);
      return card("Approve plan", "switch_mode", plan ? [textContent(plan)] : []);
    }
    case "EnterPlanMode":
      return card("Switch to plan mode", "switch_mode");
    case "Skill": {
      const skill = str(input.skill);
      return card(skill ? `Load skill: ${skill}` : "Load skill", "other");
    }
    case "TodoWrite":
      return card("Update plan", "think");
    default:
      return card(name || "Tool", "other");
  }
}

/** What a finished call adds to its card; `undefined` leaves the card as it is. */
export function resultContent(
  name: string,
  content: unknown,
  isError: boolean,
): ToolCallContent[] | undefined {
  const blocks = resultBlocks(content);
  if (blocks.length === 0) {
    return undefined;
  }
  if (!isError && EDIT_TOOLS.has(name)) {
    return undefined;
  }
  // Errors and file contents read best verbatim, not as Markdown.
  const verbatim = isError || name === "Read";
  return blocks.map((block) =>
    block.type === "text" && verbatim
      ? textContent(fence(block.text))
      : { type: "content", content: block },
  );
}

/** Text and inline images of a tool result, which is a string or a list of blocks. */
function resultBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block): ContentBlock[] => {
    if (block?.type === "text" && typeof block.text === "string") {
      return [{ type: "text", text: block.text }];
    }
    // A picture comes either as the API writes it, or as MCP does — which is
    // how a screenshot from a server this host carries over arrives.
    if (block?.type === "image" && block.source?.type === "base64") {
      return [{ type: "image", data: block.source.data, mimeType: block.source.media_type }];
    }
    if (block?.type === "image" && typeof block.data === "string" && block.mimeType) {
      return [{ type: "image", data: block.data, mimeType: block.mimeType }];
    }
    return [];
  });
}

/** A code fence longer than any run of backticks inside. */
export function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}\n${text.replace(/\n$/, "")}\n${marks}`;
}

// ── Plan ────────────────────────────────────────────────────────

type TaskStatus = "pending" | "in_progress" | "completed";
const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

function entry(content: string, status: TaskStatus, activeForm?: string): PlanEntry {
  return {
    content: status === "in_progress" && activeForm ? activeForm : content,
    status,
    priority: "medium",
  };
}

/** The whole plan from a `TodoWrite` call, which always carries every item. */
export function todoPlan(input: Input): PlanEntry[] | undefined {
  if (!Array.isArray(input.todos)) {
    return undefined;
  }
  return (input.todos as Input[]).flatMap((todo) => {
    const content = str(todo.content);
    const status = String(todo.status);
    return content && STATUSES.has(status)
      ? [entry(content, status as TaskStatus, str(todo.activeForm))]
      : [];
  });
}

interface Task {
  subject: string;
  status: TaskStatus;
  activeForm?: string;
}

/**
 * The plan that the `Task*` tools keep. Unlike `TodoWrite`, they change one
 * task at a time, and a new task's id is known only from the result.
 */
export class TaskPlan {
  private readonly tasks = new Map<string, Task>();

  /** Apply a finished task tool call; true when the plan changed. */
  apply(name: string, input: Input, output: unknown): boolean {
    switch (name) {
      case "TaskCreate": {
        const id = createdTaskId(output);
        const subject = str(input.subject);
        if (!id || !subject) {
          return false;
        }
        this.tasks.set(id, { subject, status: "pending", activeForm: str(input.activeForm) });
        return true;
      }
      case "TaskUpdate": {
        const id = str(input.taskId);
        if (!id) {
          return false;
        }
        if (input.status === "deleted") {
          return this.tasks.delete(id);
        }
        const existing = this.tasks.get(id);
        const subject = str(input.subject) ?? existing?.subject;
        if (!subject) {
          return false;
        }
        const status = STATUSES.has(String(input.status))
          ? (input.status as TaskStatus)
          : (existing?.status ?? "pending");
        this.tasks.set(id, {
          subject,
          status,
          activeForm: str(input.activeForm) ?? existing?.activeForm,
        });
        return true;
      }
      case "TaskList": {
        const listed = listedTasks(output);
        if (!listed) {
          return false;
        }
        const previous = new Map(this.tasks);
        this.tasks.clear();
        for (const task of listed) {
          this.tasks.set(task.id, { ...task, activeForm: previous.get(task.id)?.activeForm });
        }
        return true;
      }
      default:
        return false;
    }
  }

  entries(): PlanEntry[] {
    return [...this.tasks.values()].map((t) => entry(t.subject, t.status, t.activeForm));
  }
}

/** Texts of a tool output: a string, or the text blocks of a list. */
function outputTexts(output: unknown): string[] {
  if (typeof output === "string") {
    return [output];
  }
  if (!Array.isArray(output)) {
    return [];
  }
  return output.flatMap((b) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : []));
}

/** A structured output object: given as is, or as JSON text. */
function outputObject(output: unknown): Input | undefined {
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    return output as Input;
  }
  for (const text of outputTexts(output)) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Input;
      }
    } catch {
      // not JSON
    }
  }
  return undefined;
}

function createdTaskId(output: unknown): string | undefined {
  const task = outputObject(output)?.task as Input | undefined;
  if (typeof task?.id === "string") {
    return task.id;
  }
  for (const text of outputTexts(output)) {
    const match = /^Task #(\S+) created successfully/.exec(text.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function listedTasks(output: unknown): (Task & { id: string })[] | undefined {
  const tasks = outputObject(output)?.tasks;
  if (Array.isArray(tasks)) {
    return (tasks as Input[]).flatMap((t) =>
      typeof t.id === "string" && typeof t.subject === "string" && STATUSES.has(String(t.status))
        ? [{ id: t.id, subject: t.subject, status: t.status as TaskStatus }]
        : [],
    );
  }
  for (const text of outputTexts(output)) {
    if (text.trim() === "No tasks found") {
      return [];
    }
    const lines = text.trim().split("\n");
    const parsed = lines.flatMap((line) => {
      const match = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/.exec(line);
      // A dependency note is not part of the subject.
      const subject = match?.[3].replace(/ \[blocked by #[^\]]*\]$/, "");
      return match && subject ? [{ id: match[1], subject, status: match[2] as TaskStatus }] : [];
    });
    if (parsed.length > 0 && parsed.length === lines.length) {
      return parsed;
    }
  }
  return undefined;
}
