import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PROJECT_FILE, projectSettings } from "./project.js";

/** A project folder holding exactly what the test wrote into its settings. */
async function project(contents?: string) {
  const dir = await mkdtemp(join(tmpdir(), "project-test-"));
  if (contents !== undefined) {
    await writeFile(join(dir, PROJECT_FILE), contents);
  }
  return dir;
}

describe("projectSettings", () => {
  it("take the model, the mode and the servers a project asks for", async () => {
    const dir = await project(
      JSON.stringify({ model: "haiku", permissionMode: "acceptEdits", allowMcp: ["Air"] }),
    );
    expect(projectSettings(dir)).toEqual({
      model: "haiku",
      permissionMode: "acceptEdits",
      allowMcp: ["Air"],
    });
  });

  it("leave out what a project does not mention", async () => {
    expect(projectSettings(await project(JSON.stringify({ model: "claude-sonnet-5" })))).toEqual({
      model: "claude-sonnet-5",
    });
    expect(projectSettings(await project(JSON.stringify({ allowMcp: "all" })))).toEqual({
      allowMcp: "all",
    });
  });

  it("are empty when a project says nothing", async () => {
    expect(projectSettings(await project())).toEqual({});
    expect(projectSettings("/no/such/folder")).toEqual({});
  });

  it("drop a field the host cannot use and keep the rest", async () => {
    const dir = await project(
      JSON.stringify({ model: "gpt-4o", permissionMode: "yolo", allowMcp: 7, idleMinutes: 5 }),
    );
    expect(projectSettings(dir)).toEqual({});

    const half = await project(JSON.stringify({ model: "opus", permissionMode: "yolo" }));
    expect(projectSettings(half)).toEqual({ model: "opus" });
  });

  it("survive a file that is not settings at all", async () => {
    expect(projectSettings(await project("{ broken"))).toEqual({});
    expect(projectSettings(await project("[]"))).toEqual({});
    expect(projectSettings(await project("null"))).toEqual({});
  });
});
