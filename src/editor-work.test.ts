// A day's work through the editor, end to end.
//
// Both ends here are real: the editor speaks ACP over a connection, and the
// tools the host serves run their real handlers against the editor's
// buffers and terminals. Only the model's decisions are written down in
// advance, as a script of what the CLI would print.

import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { type Controls, fakeQuery, type Script } from "./agent.test-support.js";
import { openEditor, REJECT } from "./editor.test-support.js";
import { init, messageDelta, messageStart, result, text } from "./sdk-messages.test-support.js";

/** One thing the agent does in a turn: say a line, or use a tool. */
type Step = (controls: Controls) => AsyncGenerator<SDKMessage> | SDKMessage[];

/** A turn: the agent says something, uses tools, and finishes. */
const turn = (...steps: Step[]): Script =>
  async function* (_options, controls) {
    yield init();
    yield messageStart("msg_1");
    for (const step of steps) {
      yield* step(controls);
      if (controls.stopped) {
        // The user stopped it mid-tool; the CLI ends the turn where it is.
        yield result({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["Interrupted"],
        });
        return;
      }
    }
    yield messageDelta(100, 20);
    yield result();
  };

const says =
  (what: string): Step =>
  () => [text(what)];
const uses =
  (name: string, input: Record<string, unknown>, answer?: unknown): Step =>
  (controls) =>
    controls.use(name, input, answer);

/** An editor with one file open, already handshaken. */
async function editing(script: Script, files: Record<string, string> = { "/repo/a.ts": "one\n" }) {
  const agent = fakeQuery(script);
  const editor = openEditor(agent, { files });
  await editor.start();
  await editor.open("/repo");
  return { editor, agent };
}

describe("editing a file the user has open", () => {
  it("changes the buffer, not the disk, and shows it as one card", async () => {
    const { editor, agent } = await editing(
      turn(
        says("Renaming it."),
        uses("Edit", { file_path: "/repo/a.ts", old_string: "one", new_string: "two" }),
        says("Done."),
      ),
    );

    await expect(editor.prompt("rename one to two")).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect(editor.file("/repo/a.ts")).toBe("two\n");
    expect(editor.said()).toBe("Renaming it.Done.");

    const [card] = editor.cards();
    expect(card).toMatchObject({
      title: "Edit a.ts",
      kind: "edit",
      status: "completed",
      locations: [{ path: "/repo/a.ts" }],
    });
    // The agent was told it went through the editor, not through the disk.
    expect(JSON.stringify(agent.used[0].answer)).toContain("through the editor");
  });

  it("leaves the buffer alone when the user says no", async () => {
    const agent = fakeQuery(
      turn(uses("Edit", { file_path: "/repo/a.ts", old_string: "one", new_string: "two" })),
    );
    const editor = openEditor(agent, { files: { "/repo/a.ts": "one\n" }, answer: REJECT });
    await editor.start();
    await editor.open("/repo");

    await editor.prompt("rename one to two");
    expect(editor.file("/repo/a.ts")).toBe("one\n");
    expect(agent.used[0].allowed).toBe(false);
    expect(String(agent.used[0].answer)).toContain("rejected");
    expect(editor.cards()[0]).toMatchObject({ status: "failed" });
  });

  it("asks before touching a file outside the project", async () => {
    const { editor } = await editing(
      turn(uses("Edit", { file_path: "/etc/hosts", old_string: "one", new_string: "two" })),
      { "/repo/a.ts": "one\n", "/etc/hosts": "one\n" },
    );
    await editor.prompt("edit the hosts file");
    expect(editor.dialogs).toHaveLength(1);
    expect(editor.dialogs[0].toolCall).toMatchObject({ title: "Edit /etc/hosts" });
  });
});

describe("reading", () => {
  it("goes straight to the buffer inside the project, with no dialog", async () => {
    const { editor, agent } = await editing(turn(uses("Read", { file_path: "/repo/a.ts" })));
    await editor.prompt("what is in a.ts?");

    expect(editor.dialogs).toEqual([]);
    expect(JSON.stringify(agent.used[0].answer)).toContain("1\\tone");
    expect(editor.cards()[0]).toMatchObject({ title: "Read a.ts", kind: "read" });
  });

  it("asks about a file outside it", async () => {
    const { editor } = await editing(turn(uses("Read", { file_path: "/etc/hosts" })), {
      "/etc/hosts": "hosts\n",
    });
    await editor.prompt("read /etc/hosts");
    expect(editor.dialogs).toHaveLength(1);
  });

  it("is the CLI's own business when the editor serves no files", async () => {
    const agent = fakeQuery(turn(uses("Read", { file_path: "/repo/a.ts" }, "from disk")));
    const editor = openEditor(agent, { capabilities: {} });
    await editor.start();
    await editor.open("/repo");
    await editor.prompt("what is in a.ts?");

    // Nothing was redirected, so the CLI read it itself — and a read it does
    // on its own is not one this host lets through without asking.
    expect(agent.starts[0].mcpServers).toBeUndefined();
    expect(agent.used[0].name).toBe("Read");
    expect(editor.dialogs).toHaveLength(1);
  });
});

describe("running a command", () => {
  it("opens a terminal in the project, hangs it on the card, and hands back the output", async () => {
    const agent = fakeQuery(turn(uses("Bash", { command: "pnpm test", description: "Run tests" })));
    const editor = openEditor(agent, {
      commands: { "pnpm test": { output: "147 passed\n", exitCode: 0 } },
    });
    await editor.start();
    await editor.open("/repo");
    await editor.prompt("run the tests");

    expect(editor.terminals[0]).toMatchObject({
      command: "pnpm test",
      cwd: "/repo",
      released: true,
    });
    expect(JSON.stringify(agent.used[0].answer)).toContain("147 passed");
    // The card shows the terminal itself, so the user watched it run.
    expect(JSON.stringify(editor.cards()[0].content)).toContain("term-1");
  });

  it("hands the terminal back when the user closes the session", async () => {
    let over!: () => void;
    const running = new Promise<void>((resolve) => (over = resolve));
    const agent = fakeQuery(
      turn(uses("Bash", { command: "pnpm dev", run_in_background: true }), says("It runs.")),
    );
    const editor = openEditor(agent, { commands: { "pnpm dev": { ends: running } } });
    await editor.start();
    await editor.open("/repo");
    await editor.prompt("start the dev server");

    // A background command stays in the terminal the user is watching.
    expect(editor.terminals[0].released).toBe(false);
    await editor.close();
    expect(editor.terminals[0].released).toBe(true);
    over();
  });
});

describe("the user changes their mind", () => {
  it("cancels a turn while the command is still running", async () => {
    const never = new Promise<void>(() => {});
    const agent = fakeQuery(
      turn(says("Building."), uses("Bash", { command: "pnpm build" }), says("Never said.")),
    );
    const editor = openEditor(agent, { commands: { "pnpm build": { ends: never } } });
    await editor.start();
    await editor.open("/repo");

    const answer = editor.prompt("build it");
    await vi.waitFor(() => expect(editor.said()).toBe("Building."));
    await editor.cancel();

    await expect(answer).resolves.toEqual({ stopReason: "cancelled" });
    expect(agent.interrupts).toBe(1);
  });
});

describe("the agent asks the user something", () => {
  it("shows a form and takes the answer back into the tool's own input", async () => {
    const agent = fakeQuery(
      turn(
        uses("AskUserQuestion", {
          questions: [
            {
              question: "Which database?",
              header: "Database",
              options: [{ label: "Postgres" }, { label: "SQLite" }],
              multiSelect: false,
            },
          ],
        }),
      ),
    );
    const editor = openEditor(agent, {
      fill: () => ({ action: "accept", content: { question_0: "Postgres" } }),
    });
    await editor.start();
    await editor.open("/repo");
    await editor.prompt("pick a database");

    expect(editor.forms[0]).toMatchObject({ mode: "form", message: "Which database?" });
    // The question was never a permission dialog; it came back as an answer.
    expect(editor.dialogs).toEqual([]);
    expect(agent.used[0].input.answers).toEqual({ "Which database?": "Postgres" });
  });
});

/** The choices a form put in front of the user. */
const offered = (request: CreateElicitationRequest) =>
  (
    request as unknown as {
      requestedSchema: { properties: { choice: { oneOf: { const: string }[] } } };
    }
  ).requestedSchema.properties.choice.oneOf;

describe("undoing what the agent did", () => {
  const edited = turn(
    says("Editing."),
    uses("Edit", { file_path: "/repo/a.ts", old_string: "one", new_string: "two" }),
  );

  it("offers the earlier prompts and puts the files back", async () => {
    const agent = fakeQuery(edited, edited);
    const editor = openEditor(agent, {
      files: { "/repo/a.ts": "one\n" },
      // The user picks the first prompt offered.
      fill: (request) => ({
        action: "accept",
        content: {
          choice: String(offered(request)[0].const),
        },
      }),
    });
    await editor.start();
    await editor.open("/repo");

    await editor.prompt("rename one to two");
    await expect(editor.prompt("/rewind")).resolves.toEqual({ stopReason: "end_turn" });

    // The command never reached the agent: still one turn, not two.
    expect(agent.prompts).toHaveLength(1);
    expect(editor.forms[0]).toMatchObject({ message: expect.stringContaining("Undo") });
    expect(agent.rewinds).toEqual([expect.any(String)]);
    expect(editor.said()).toContain("Put 1 file back");
    expect(editor.said()).toContain("rename one to two");
  });

  it("takes a number when the user already knows which prompt", async () => {
    const agent = fakeQuery(edited, edited, edited);
    const editor = openEditor(agent, { files: { "/repo/a.ts": "one\n" } });
    await editor.start();
    await editor.open("/repo");

    await editor.prompt("first change");
    await editor.prompt("second change");
    await editor.prompt("/rewind 2");

    // Two prompts back is the first one, and no form was needed.
    expect(editor.forms).toEqual([]);
    expect(agent.rewinds).toEqual([expect.any(String)]);
    expect(editor.said()).toContain("first change");
  });

  it("says so when there is nothing to undo, and when the CLI cannot", async () => {
    const agent = fakeQuery(edited);
    const editor = openEditor(agent, { files: { "/repo/a.ts": "one\n" } });
    await editor.start();
    await editor.open("/repo");

    await editor.prompt("/rewind");
    expect(editor.said()).toContain("Nothing to rewind");
    expect(agent.rewinds).toEqual([]);

    agent.rewound = { canRewind: false, error: "checkpointing is off" };
    await editor.prompt("change something");
    await editor.prompt("/rewind 1");
    expect(editor.said()).toContain("checkpointing is off");
  });
});
