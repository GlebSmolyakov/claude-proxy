import { mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { insideWorkspace } from "./editor-tools.js";
import { Session } from "./session.js";

const session = (cwd: string, extra: string[] = []) =>
  new Session("s1", cwd, extra, {}, "default", undefined);

describe("the folders a session reads without asking", () => {
  it("holds the folder as the editor named it and as the disk really has it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "session-test-"));
    const real = await realpath(dir);
    const link = join(dir, "link");
    await symlink(real, link);

    // The editor opens the project through the symlink; the CLI reports the
    // path it resolved, and both are the same folder.
    const through = session(link);
    expect(insideWorkspace(join(link, "a.ts"), through.readable)).toBe(true);
    expect(insideWorkspace(join(real, "a.ts"), through.readable)).toBe(true);
    expect(insideWorkspace(join(real, "..", "elsewhere", "a.ts"), through.readable)).toBe(false);
  });
});
