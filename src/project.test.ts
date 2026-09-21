import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type Limits, narrowTo, PROJECT_FILE, projectSettings } from "./project.js";

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

describe("narrowTo", () => {
  const flags: Limits = {
    permissionMode: "default",
    allowMcp: ["Air", "webstorm"],
    proxyMcp: { Air: ["browser-read-page", "browser-click"] },
  };

  it("lets a project ask for a mode more careful than the flags", () => {
    expect(narrowTo({ permissionMode: "plan" }, flags).permissionMode).toBe("plan");
  });

  it("refuses a mode freer than the one the host was started with", () => {
    expect(narrowTo({ permissionMode: "acceptEdits" }, flags).permissionMode).toBeUndefined();
    expect(narrowTo({ permissionMode: "bypassPermissions" }, flags).permissionMode).toBeUndefined();
  });

  it("keeps the servers both the flags and the project name", () => {
    expect(narrowTo({ allowMcp: ["Air", "secrets"] }, flags).allowMcp).toEqual(["Air"]);
    expect(narrowTo({ allowMcp: "all" }, flags).allowMcp).toEqual(["Air", "webstorm"]);
  });

  it("lets a project cut the list down when the flags allow every server", () => {
    const open = { ...flags, allowMcp: "all" as const };
    expect(narrowTo({ allowMcp: ["Air"] }, open).allowMcp).toEqual(["Air"]);
    expect(narrowTo({ allowMcp: "all" }, open).allowMcp).toBe("all");
  });

  it("carries over only the tools --proxy-mcp already carries", () => {
    expect(narrowTo({ proxyMcp: { Air: "all" } }, flags).proxyMcp).toEqual({
      Air: ["browser-read-page", "browser-click"],
    });
    expect(narrowTo({ proxyMcp: { Air: ["browser-click", "shell"] } }, flags).proxyMcp).toEqual({
      Air: ["browser-click"],
    });
  });

  it("carries over nothing from a server the flags never named", () => {
    expect(narrowTo({ proxyMcp: { pycharm: "all" } }, flags).proxyMcp).toEqual({});
    expect(narrowTo({ proxyMcp: { Air: ["shell"] } }, flags).proxyMcp).toEqual({});
  });

  it("leaves the model alone, which is nobody's permission", () => {
    expect(narrowTo({ model: "haiku" }, flags)).toEqual({ model: "haiku" });
  });
});
