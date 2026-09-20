import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore, transcriptsDirFor } from "./session.js";

const tempDir = () => mkdtemp(join(tmpdir(), "claude-proxy-test-"));
const open = (dir: string) =>
  SessionStore.open(join(dir, "sessions.json"), join(dir, "transcripts"));

describe("SessionStore", () => {
  it("remembers and finds sessions", async () => {
    const s = await open(await tempDir());
    expect(s.lookup("k")).toBeUndefined();
    await s.remember("k", "sid-1");
    expect(s.lookup("k")).toBe("sid-1");
    expect(s.size).toBe(1);
  });

  it("survives a restart", async () => {
    const dir = await tempDir();
    await (await open(dir)).remember("k", "sid-1");
    expect((await open(dir)).lookup("k")).toBe("sid-1");
  });

  it("starts empty from an unreadable file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "sessions.json"), "not json");
    expect((await open(dir)).size).toBe(0);
  });

  it("deletes only unreferenced uuid transcripts", async () => {
    const dir = await tempDir();
    const transcripts = join(dir, "transcripts");
    await mkdir(transcripts);
    const old = randomUUID();
    const shared = randomUUID();
    for (const id of [old, shared]) {
      await writeFile(join(transcripts, `${id}.jsonl`), "{}");
    }

    const s = await open(dir);
    await s.remember("old", old);
    await s.remember("shared-old", shared);
    await s.remember("shared-new", shared);
    await s.remember("bogus", "../escape");
    const entries = (s as unknown as { entries: Map<string, { last_used_at: number }> }).entries;
    for (const key of ["old", "shared-old", "bogus"]) {
      entries.get(key)!.last_used_at = 0;
    }

    expect(await s.cleanupOlderThan(1)).toBe(2);
    expect(existsSync(join(transcripts, `${old}.jsonl`))).toBe(false);
    expect(existsSync(join(transcripts, `${shared}.jsonl`))).toBe(true);
    expect(s.lookup("shared-new")).toBe(shared);
    expect(s.lookup("old")).toBeUndefined();
  });

  it("finds transcripts under the CLI's slug", () => {
    expect(
      transcriptsDirFor("/Users/me/.claude-proxy/workdir").endsWith(
        "projects/-Users-me--claude-proxy-workdir",
      ),
    ).toBe(true);
  });
});
