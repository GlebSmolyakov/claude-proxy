import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { methods } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { type Deps, editorFiles, editTool, insideWorkspace, readTool, writeTool } from "./files.js";
import { toolInfo } from "./tools.js";

/** An editor holding one file in a buffer that the disk knows nothing about. */
function editor(buffer = "one\ntwo\nthree\n") {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const deps: Deps = {
    sessionId: "s1",
    cwd: "/repo",
    editor: {
      notify: async () => {},
      request: (async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === methods.client.fs.readTextFile) {
          const line = typeof params.line === "number" ? params.line : 1;
          const limit = typeof params.limit === "number" ? params.limit : undefined;
          const lines = buffer
            .split("\n")
            .slice(line - 1, limit === undefined ? undefined : line - 1 + limit);
          return { content: lines.join("\n") };
        }
        buffer = params.content as string;
        return {};
      }) as Deps["editor"]["request"],
    },
  };
  return { deps, calls, buffer: () => buffer };
}

const output = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

/** The SDK types optional fields as present-and-undefined; tests pass what the model would send. */
const call = <T>(
  t: { handler: (args: never, extra: unknown) => Promise<T> },
  args: Record<string, unknown>,
) => t.handler(args as never, undefined);

describe("reading", () => {
  it("numbers the editor's lines and takes the path from the session's folder", async () => {
    const { deps, calls } = editor();
    const result = await call(readTool(deps), { file_path: "a.ts" });
    expect(output(result)).toBe("1\tone\n2\ttwo\n3\tthree");
    expect(calls[0]).toEqual({
      method: methods.client.fs.readTextFile,
      params: { sessionId: "s1", path: "/repo/a.ts" },
    });
  });

  it("asks for the range the model asked for", async () => {
    const { deps, calls } = editor();
    const result = await readTool(deps).handler(
      { file_path: "/repo/a.ts", offset: 2, limit: 1 },
      undefined,
    );
    expect(output(result)).toBe("2\ttwo");
    expect(calls[0].params).toMatchObject({ line: 2, limit: 1 });
  });

  it("says so when the file is empty", async () => {
    const { deps } = editor("");
    expect(output(await call(readTool(deps), { file_path: "/repo/a.ts" }))).toBe(
      "The file is empty.",
    );
  });

  it("reads an image from disk, since the editor has no text for it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "files-test-"));
    const path = join(dir, "dot.png");
    await writeFile(path, Buffer.from("89504e47", "hex"));
    const { deps, calls } = editor();
    const result = await call(readTool(deps), { file_path: path });
    expect(result.content[0]).toEqual({ type: "image", data: "iVBORw==", mimeType: "image/png" });
    expect(calls).toHaveLength(0);
  });
});

describe("writing", () => {
  it("replaces the file through the editor", async () => {
    const { deps, calls, buffer } = editor();
    const result = await writeTool(deps).handler(
      { file_path: "/repo/a.ts", content: "new" },
      undefined,
    );
    expect(output(result)).toContain("through the editor");
    expect(calls[0].method).toBe(methods.client.fs.writeTextFile);
    expect(buffer()).toBe("new");
  });
});

describe("editing", () => {
  const edit = (deps: Deps, args: Record<string, unknown>) => call(editTool(deps), args);

  it("replaces one occurrence and writes the whole file back", async () => {
    const { deps, buffer, calls } = editor();
    const result = await edit(deps, {
      file_path: "/repo/a.ts",
      old_string: "two",
      new_string: "2",
    });
    expect(output(result)).toContain("Replaced 1 occurrence");
    expect(buffer()).toBe("one\n2\nthree\n");
    expect(calls.map((c) => c.method)).toEqual([
      methods.client.fs.readTextFile,
      methods.client.fs.writeTextFile,
    ]);
  });

  it("keeps a dollar sign in the new text", async () => {
    const { deps, buffer } = editor("const price = 1;\n");
    await edit(deps, { file_path: "/repo/a.ts", old_string: "1", new_string: "`$${sum}`" });
    expect(buffer()).toBe("const price = `$${sum}`;\n");
  });

  it("refuses text that is missing or ambiguous, and replaces all when asked", async () => {
    const { deps: missing } = editor();
    expect(
      await edit(missing, { file_path: "/repo/a.ts", old_string: "four", new_string: "4" }),
    ).toMatchObject({
      isError: true,
    });

    const twice = editor("a\na\n");
    const ambiguous = await edit(twice.deps, {
      file_path: "/repo/a.ts",
      old_string: "a",
      new_string: "b",
    });
    expect(ambiguous.isError).toBe(true);
    expect(output(ambiguous)).toContain("appears 2 times");
    expect(twice.buffer()).toBe("a\na\n");

    await edit(twice.deps, {
      file_path: "/repo/a.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    expect(twice.buffer()).toBe("b\nb\n");
  });

  it("refuses an empty or unchanged replacement", async () => {
    const { deps } = editor();
    expect(
      await edit(deps, { file_path: "/repo/a.ts", old_string: "", new_string: "x" }),
    ).toMatchObject({ isError: true });
    expect(
      await edit(deps, { file_path: "/repo/a.ts", old_string: "one", new_string: "one" }),
    ).toMatchObject({
      isError: true,
    });
  });
});

describe("editorFiles", () => {
  const { deps } = editor();

  it("redirects what the editor can serve, and nothing when it serves nothing", () => {
    expect(editorFiles(deps, { fs: { readTextFile: true, writeTextFile: true } })).toMatchObject({
      aliases: { Read: "mcp__acp__read", Write: "mcp__acp__write", Edit: "mcp__acp__edit" },
    });
    expect(editorFiles(deps, { fs: { readTextFile: true } })?.aliases).toEqual({
      Read: "mcp__acp__read",
    });
    // Editing is a read and a write, so half a channel is not enough for it.
    expect(editorFiles(deps, { fs: { writeTextFile: true } })?.aliases).toEqual({
      Write: "mcp__acp__write",
    });
    expect(editorFiles(deps, { fs: {} })).toBeUndefined();
    expect(editorFiles(deps, undefined)).toBeUndefined();
  });

  it("tells files of the workspace from the rest", () => {
    const roots = ["/repo", "/lib"];
    expect(insideWorkspace("/repo/src/a.ts", roots)).toBe(true);
    expect(insideWorkspace("/lib/b.ts", roots)).toBe(true);
    expect(insideWorkspace("/repo", roots)).toBe(true);
    expect(insideWorkspace("/repo-other/a.ts", roots)).toBe(false);
    expect(insideWorkspace("/Users/me/.ssh/id_rsa", roots)).toBe(false);
    expect(insideWorkspace("/repo/../etc/passwd", roots)).toBe(false);
    expect(insideWorkspace(undefined, roots)).toBe(false);
  });

  it("keeps the built-in card for a redirected call", () => {
    expect(
      toolInfo(
        "mcp__acp__edit",
        { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
        "/repo",
      ),
    ).toMatchObject({
      title: "Edit a.ts",
      kind: "edit",
    });
  });
});
