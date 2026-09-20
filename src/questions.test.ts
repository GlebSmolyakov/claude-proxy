import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  answersFrom,
  mcpForm,
  mcpResult,
  type Question,
  questionForm,
  questionsOf,
} from "./questions.js";

const COLOUR: Question = {
  question: "Which colour?",
  header: "Colour",
  options: [{ label: "Teal", description: "Blue-green" }, { label: "Red" }],
  multiSelect: false,
};
const TOOLS: Question = {
  question: "Which tools?",
  options: [{ label: "Vitest" }, { label: "ESLint" }],
  multiSelect: true,
};

const accept = (content: Record<string, unknown>): CreateElicitationResponse =>
  ({ action: "accept", content }) as CreateElicitationResponse;

describe("questionsOf", () => {
  it("takes the questions of a call and drops what it cannot show", () => {
    expect(
      questionsOf({
        questions: [
          {
            question: "Which colour?",
            header: "Colour",
            multiSelect: false,
            options: [{ label: "Teal", description: "Blue-green" }, { label: "Red" }],
          },
          { header: "no question text", options: [] },
        ],
      }),
    ).toEqual([COLOUR]);
    expect(questionsOf({})).toBeUndefined();
    expect(questionsOf({ questions: [] })).toBeUndefined();
  });
});

describe("questionForm", () => {
  it("asks one question in the message and offers its options", () => {
    const form = questionForm([COLOUR], "s1", "t1");
    expect(form).toMatchObject({
      mode: "form",
      sessionId: "s1",
      toolCallId: "t1",
      message: "Which colour?",
    });
    const properties = form.requestedSchema.properties!;
    expect(properties.question_0).toMatchObject({
      type: "string",
      title: "Colour",
      oneOf: [
        { const: "Teal", title: "Teal", description: "Blue-green" },
        { const: "Red", title: "Red" },
      ],
    });
    // Nothing is required, so the user can skip, and can always answer in their own words.
    expect(form.requestedSchema.required).toBeUndefined();
    expect(properties.question_0_other).toMatchObject({ type: "string", title: "Other" });
  });

  it("names every question when there are several, and lets one take many answers", () => {
    const form = questionForm([COLOUR, TOOLS], "s1", "t1");
    expect(form.message).toBe("Please answer these questions.");
    const properties = form.requestedSchema.properties!;
    expect(properties.question_0).toMatchObject({ description: "Which colour?" });
    expect(properties.question_1).toMatchObject({
      type: "array",
      description: "Which tools?",
      items: { anyOf: [{ const: "Vitest" }, { const: "ESLint" }] },
    });
  });
});

describe("answersFrom", () => {
  const input = { questions: [] };

  it("gives the tool the answer under its own question", () => {
    expect(answersFrom(accept({ question_0: "Teal" }), input, [COLOUR])).toEqual({
      answered: true,
      input: { questions: [], answers: { "Which colour?": "Teal" } },
    });
  });

  it("keeps a typed answer, and a typed note beside a pick", () => {
    expect(answersFrom(accept({ question_0_other: "Mauve" }), input, [COLOUR])).toMatchObject({
      input: { answers: { "Which colour?": "Mauve" } },
    });
    expect(
      answersFrom(accept({ question_0: "Teal", question_0_other: "but lighter" }), input, [COLOUR]),
    ).toMatchObject({
      input: {
        answers: { "Which colour?": "Teal" },
        annotations: { "Which colour?": { notes: "but lighter" } },
      },
    });
  });

  it("joins what was picked when a question takes many answers", () => {
    expect(
      answersFrom(
        accept({ question_0: ["Vitest", "ESLint"], question_0_other: "Prettier" }),
        input,
        [TOOLS],
      ),
    ).toMatchObject({ input: { answers: { "Which tools?": "Vitest, ESLint, Prettier" } } });
  });

  it("leaves an unanswered question out", () => {
    expect(answersFrom(accept({}), input, [COLOUR])).toEqual({
      answered: true,
      input: { questions: [], answers: {} },
    });
  });

  it("treats declining as skipping, and closing as no answer at all", () => {
    expect(answersFrom({ action: "decline" }, input, [COLOUR])).toEqual({
      answered: true,
      input: { questions: [], answers: {} },
    });
    expect(answersFrom({ action: "cancel" }, input, [COLOUR])).toEqual({ answered: false });
  });
});

describe("an MCP server's own request", () => {
  const request = {
    serverName: "tickets",
    message: "Which ticket?",
    mode: "form" as const,
    requestedSchema: {
      type: "object",
      properties: { ticket: { type: "string", title: "Ticket" } },
      required: ["ticket"],
    },
  };

  it("travels to the editor as the form it already is", () => {
    expect(mcpForm(request, "s1")).toEqual({
      mode: "form",
      sessionId: "s1",
      message: "Which ticket?",
      requestedSchema: {
        type: "object",
        properties: { ticket: { type: "string", title: "Ticket" } },
        required: ["ticket"],
      },
    });
  });

  it("names the server when the request carries no message, and keeps a bare schema usable", () => {
    const bare = mcpForm({ serverName: "tickets", message: "" }, "s1");
    expect(bare?.message).toBe("tickets is asking for input.");
    expect(bare?.requestedSchema).toEqual({ type: "object", properties: {} });
  });

  it("stays behind when it asks for something other than a form", () => {
    expect(mcpForm({ ...request, mode: "url", url: "https://example.com" }, "s1")).toBeUndefined();
  });

  it("carries the answer back in the shape the server expects", () => {
    expect(mcpResult({ action: "accept", content: { ticket: "AB-1" } })).toEqual({
      action: "accept",
      content: { ticket: "AB-1" },
    });
    expect(mcpResult({ action: "decline" })).toEqual({ action: "decline" });
    expect(mcpResult({ action: "cancel" })).toEqual({ action: "cancel" });
  });
});
