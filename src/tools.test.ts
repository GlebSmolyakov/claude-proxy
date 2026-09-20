import { describe, expect, it } from "vitest";

import { displayPath, fence, resultContent, TaskPlan, todoPlan, toolInfo } from "./tools.js";

describe("toolInfo", () => {
  const cwd = "/repo";

  it("shows edits as diffs with the file's location", () => {
    expect(
      toolInfo("Edit", { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" }, cwd),
    ).toEqual({
      title: "Edit src/a.ts",
      kind: "edit",
      content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "a", newText: "b" }],
      locations: [{ path: "/repo/src/a.ts" }],
    });
    expect(toolInfo("Write", { file_path: "/repo/new.ts", content: "x" }, cwd).content).toEqual([
      { type: "diff", path: "/repo/new.ts", oldText: null, newText: "x" },
    ]);
  });

  it("names reads with their range and commands with the command", () => {
    const read = toolInfo("Read", { file_path: "/repo/a.ts", offset: 10, limit: 5 }, cwd);
    expect(read).toMatchObject({
      title: "Read a.ts (10 - 14)",
      kind: "read",
      locations: [{ path: "/repo/a.ts", line: 10 }],
    });
    expect(toolInfo("Bash", { command: "ls", description: "List files" }, cwd)).toMatchObject({
      title: "ls",
      kind: "execute",
      content: [{ type: "content", content: { type: "text", text: "List files" } }],
    });
  });

  it("has placeholders before the input is known", () => {
    expect(toolInfo("Write", {}, cwd)).toEqual({
      title: "Write",
      kind: "edit",
      content: [],
      locations: [],
    });
    expect(toolInfo("mcp__github__create_issue", {}, cwd)).toMatchObject({
      title: "mcp__github__create_issue",
      kind: "other",
    });
  });

  it("shows the plan when leaving plan mode", () => {
    expect(toolInfo("ExitPlanMode", { plan: "1. Do it" }, cwd)).toMatchObject({
      kind: "switch_mode",
      content: [{ type: "content", content: { type: "text", text: "1. Do it" } }],
    });
  });

  it("keeps paths outside the working directory absolute", () => {
    expect(displayPath("/etc/hosts", "/repo")).toBe("/etc/hosts");
    expect(displayPath("/repo-other/a", "/repo")).toBe("/repo-other/a");
  });
});

describe("resultContent", () => {
  it("leaves the diff of a successful edit alone", () => {
    expect(resultContent("Edit", "The file has been updated.", false)).toBeUndefined();
  });

  it("fences errors and file contents, and passes other output", () => {
    expect(resultContent("Edit", "String not found", true)).toEqual([
      { type: "content", content: { type: "text", text: "```\nString not found\n```" } },
    ]);
    expect(resultContent("Read", [{ type: "text", text: "1\tconst a = 1;\n" }], false)).toEqual([
      { type: "content", content: { type: "text", text: "```\n1\tconst a = 1;\n```" } },
    ]);
    expect(resultContent("Grep", "a.ts:1", false)).toEqual([
      { type: "content", content: { type: "text", text: "a.ts:1" } },
    ]);
    expect(resultContent("Grep", "", false)).toBeUndefined();
  });

  it("fences past backticks inside", () => {
    expect(fence("a ``` b")).toBe("````\na ``` b\n````");
  });
});

describe("plan", () => {
  it("takes TodoWrite's whole list, showing the active form of the running item", () => {
    expect(
      todoPlan({
        todos: [
          { content: "Write tests", status: "completed", activeForm: "Writing tests" },
          { content: "Fix bug", status: "in_progress", activeForm: "Fixing bug" },
        ],
      }),
    ).toEqual([
      { content: "Write tests", status: "completed", priority: "medium" },
      { content: "Fixing bug", status: "in_progress", priority: "medium" },
    ]);
    expect(todoPlan({})).toBeUndefined();
  });

  it("follows Task tools, taking new ids from structured or text output", () => {
    const plan = new TaskPlan();
    expect(
      plan.apply(
        "TaskCreate",
        { subject: "Read code", activeForm: "Reading code" },
        { task: { id: "1" } },
      ),
    ).toBe(true);
    expect(
      plan.apply("TaskCreate", { subject: "Fix bug" }, [
        { type: "text", text: "Task #2 created successfully: Fix bug" },
      ]),
    ).toBe(true);
    expect(plan.apply("TaskUpdate", { taskId: "1", status: "in_progress" }, "ok")).toBe(true);
    expect(plan.entries()).toEqual([
      { content: "Reading code", status: "in_progress", priority: "medium" },
      { content: "Fix bug", status: "pending", priority: "medium" },
    ]);
    expect(plan.apply("TaskUpdate", { taskId: "2", status: "deleted" }, "ok")).toBe(true);
    expect(plan.entries()).toHaveLength(1);
    expect(plan.apply("TaskGet", { taskId: "1" }, "{}")).toBe(false);
  });

  it("rebuilds the list from TaskList", () => {
    const plan = new TaskPlan();
    plan.apply("TaskCreate", { subject: "Old", activeForm: "Doing old" }, { task: { id: "1" } });
    const listed = "#1 [in_progress] Old\n#3 [pending] New [blocked by #1]";
    expect(plan.apply("TaskList", {}, listed)).toBe(true);
    expect(plan.entries()).toEqual([
      { content: "Doing old", status: "in_progress", priority: "medium" },
      { content: "New", status: "pending", priority: "medium" },
    ]);
    expect(plan.apply("TaskList", {}, "not a list")).toBe(false);
  });
});
