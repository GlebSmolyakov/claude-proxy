import { describe, expect, it } from "vitest";

import {
  type Block,
  type Conversation,
  ConversationBuilder,
  type Role,
  text,
} from "./conversation.js";

function conversation(system: string, turns: [Role, string][]): Conversation {
  const b = new ConversationBuilder();
  b.system(system);
  for (const [role, t] of turns) {
    b.push(role, [text(t)]);
  }
  return b.build();
}

const call = (id: string): Block => ({
  type: "tool_use",
  call: { id, name: "read_file", input: { path: "main.rs" } },
});
const result = (id: string, out: string): Block => ({
  type: "tool_result",
  toolUseId: id,
  content: [text(out)],
  isError: false,
});

describe("ConversationBuilder", () => {
  it("merges consecutive same-role messages", () => {
    const b = new ConversationBuilder();
    b.push("user", [text("a")]);
    b.push("user", [text("b")]);
    const c = b.build();
    expect(c.turns).toHaveLength(1);
    expect(c.last().blocks).toEqual([text("a"), text("b")]);
  });

  it("drops blank messages", () => {
    const b = new ConversationBuilder();
    b.push("user", [text("hi")]);
    b.push("assistant", [text("   ")]);
    b.push("user", [text("again")]);
    expect(b.build().turns).toHaveLength(1);
  });

  it("rejects an empty conversation and an assistant turn last", () => {
    expect(() => new ConversationBuilder().build()).toThrow();
    const b = new ConversationBuilder();
    b.push("user", [text("hi")]);
    b.push("assistant", [text("hello")]);
    expect(() => b.build()).toThrow("the last message must come from the user");
  });

  it("joins system parts", () => {
    const b = new ConversationBuilder();
    b.system("one");
    b.system("  ");
    b.system("two");
    b.push("user", [text("hi")]);
    expect(b.build().system).toBe("one\n\ntwo");
  });
});

describe("history keys", () => {
  it("are absent for the first message", () => {
    expect(conversation("", [["user", "hi"]]).historyKey()).toBeUndefined();
  });

  it("match between the stored reply and the next request", () => {
    const stored = conversation("sys", [["user", "hi"]]).keyAfterReply("Hello!");
    const second = conversation("sys", [
      ["user", "hi"],
      ["assistant", "Hello!"],
      ["user", "how are you?"],
    ]);
    expect(second.historyKey()).toBe(stored);
  });

  it("match after a history with tool calls", () => {
    const build = (extra: boolean) => {
      const b = new ConversationBuilder();
      b.push("user", [text("what is in main.rs?")]);
      b.push("assistant", [text("Let me look."), call("t1")]);
      b.push("user", [result("t1", "fn main() {}")]);
      if (extra) {
        b.push("assistant", [text("An empty main.")]);
        b.push("user", [text("thanks")]);
      }
      return b.build();
    };
    expect(build(true).historyKey()).toBe(build(false).keyAfterReply("An empty main."));
  });

  it("ignore whitespace around the reply", () => {
    const first = conversation("", [["user", "hi"]]);
    const second = conversation("", [
      ["user", "hi"],
      ["assistant", "\n Hello! \n"],
      ["user", "next"],
    ]);
    expect(second.historyKey()).toBe(first.keyAfterReply("Hello!"));
  });

  it("depend on the system prompt and the content", () => {
    const a = conversation("one", [["user", "hi"]]).keyAfterReply("x");
    expect(conversation("two", [["user", "hi"]]).keyAfterReply("x")).not.toBe(a);
    expect(conversation("one", [["user", "hi"]]).keyAfterReply("y")).not.toBe(a);
  });

  it("do not depend on the key order of tool inputs", () => {
    const withInput = (input: unknown) => {
      const b = new ConversationBuilder();
      b.push("user", [text("go")]);
      b.push("assistant", [{ type: "tool_use", call: { id: "t", name: "x", input } }]);
      b.push("user", [result("t", "ok")]);
      return b.build().keyAfterReply("done");
    };
    expect(withInput({ a: 1, b: 2 })).toBe(withInput({ b: 2, a: 1 }));
  });

  it("tell images apart", () => {
    const withImage = (data: string) => {
      const b = new ConversationBuilder();
      b.push("user", [
        text("what is this?"),
        { type: "image", source: { kind: "base64", mediaType: "image/png", data } },
      ]);
      return b.build().keyAfterReply("a square");
    };
    expect(withImage("AAAA")).not.toBe(withImage("BBBB"));
  });
});

describe("agent input", () => {
  it("continues with only the new message", () => {
    const c = conversation("", [
      ["user", "hi"],
      ["assistant", "hello"],
      ["user", "next"],
    ]);
    expect(c.continuationInput()).toEqual([{ type: "text", text: "next" }]);
  });

  it("is the message itself without history", () => {
    const c = conversation("", [["user", "hi"]]);
    expect(c.freshInput()).toEqual(c.continuationInput());
  });

  it("replays history with images in place", () => {
    const b = new ConversationBuilder();
    b.push("user", [
      text("look"),
      { type: "image", source: { kind: "url", url: "https://example.com/cat.png" } },
    ]);
    b.push("assistant", [text("a cat")]);
    b.push("user", [text("what color?")]);
    const content = b.build().freshInput();

    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({ type: "text" });
    expect((content[0] as { text: string }).text).toContain("<conversation_history>\n<user>\nlook");
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    });
    const after = (content[2] as { text: string }).text;
    expect(after).toContain("<assistant>\na cat\n</assistant>");
    expect(after.endsWith("Reply to the latest user message:\n\nwhat color?")).toBe(true);
  });

  it("writes tool calls and results as text", () => {
    const b = new ConversationBuilder();
    b.push("user", [text("what is in main.rs?")]);
    b.push("assistant", [call("t1")]);
    b.push("user", [result("t1", "fn main() {}")]);
    const content = b.build().freshInput();
    expect(content).toHaveLength(1);
    const t = (content[0] as { text: string }).text;
    expect(t).toContain('<tool_call name="read_file" id="t1">{"path":"main.rs"}</tool_call>');
    expect(t.endsWith('<tool_result id="t1">\nfn main() {}\n</tool_result>')).toBe(true);
  });

  it("gives base64 images their API shape", () => {
    const b = new ConversationBuilder();
    b.push("user", [
      { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "QUJD" } },
    ]);
    expect(b.build().continuationInput()).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ]);
  });
});
