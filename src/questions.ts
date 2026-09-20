// What the agent asks the user, shown as a form in the editor.
//
// Two things ask. The built-in AskUserQuestion tool asks through the
// permission callback, so the host turns its questions into an ACP form and
// hands the answers back as the tool's own input. An MCP server asks through
// the SDK's elicitation callback, and its request is already a form: it only
// needs carrying across.

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationPropertySchema,
  ElicitationSchema,
  EnumOption,
} from "@agentclientprotocol/sdk";
import type { ElicitationRequest, ElicitationResult } from "@anthropic-ai/claude-agent-sdk";

import type { Input } from "./tools.js";

export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

const field = (index: number) => `question_${index}`;
const otherField = (index: number) => `question_${index}_other`;

/** The questions of a call, or `undefined` when it carries none the editor could show. */
export function questionsOf(input: Input): Question[] | undefined {
  if (!Array.isArray(input.questions)) {
    return undefined;
  }
  const questions = (input.questions as Input[]).flatMap((q): Question[] => {
    const text = typeof q.question === "string" ? q.question : "";
    const options = Array.isArray(q.options) ? (q.options as Input[]) : [];
    const labelled = options.flatMap((o) =>
      typeof o.label === "string"
        ? [
            {
              label: o.label,
              ...(typeof o.description === "string" && { description: o.description }),
            },
          ]
        : [],
    );
    return text === ""
      ? []
      : [
          {
            question: text,
            ...(typeof q.header === "string" && { header: q.header }),
            options: labelled,
            multiSelect: q.multiSelect === true,
          },
        ];
  });
  return questions.length === 0 ? undefined : questions;
}

/**
 * One field per question, plus a free-text box beside it: the built-in tool
 * always lets the user answer in their own words, and skipping is allowed
 * because nothing is required.
 */
export function questionForm(
  questions: Question[],
  sessionId: string,
  toolCallId: string,
): Extract<CreateElicitationRequest, { mode: "form" }> {
  const single = questions.length === 1;
  const properties: Record<string, ElicitationPropertySchema> = {};
  questions.forEach((question, index) => {
    const options: EnumOption[] = question.options.map((option) => ({
      const: option.label,
      title: option.label,
      ...(option.description !== undefined && { description: option.description }),
    }));
    // With one question the prompt is the message; with several each field says its own.
    const description = single ? undefined : question.question;
    const title = question.header;
    properties[field(index)] = question.multiSelect
      ? { type: "array", title, description, items: { anyOf: options } }
      : { type: "string", title, description, oneOf: options };
    properties[otherField(index)] = {
      type: "string",
      title: "Other",
      description: question.multiSelect
        ? "Your own answer, added to what you picked above (optional)."
        : "Your own answer, or a note on the option you picked above (optional).",
    };
  });

  return {
    mode: "form",
    sessionId,
    toolCallId,
    message: single ? questions[0].question : "Please answer these questions.",
    requestedSchema: { type: "object", properties },
  };
}

export type Answers =
  | { answered: true; input: Input }
  /** The dialog was closed instead of answered; the tool call is off. */
  | { answered: false };

/** The form's answers, in the shape the tool reads them back from its input. */
export function answersFrom(
  response: CreateElicitationResponse,
  input: Input,
  questions: Question[],
): Answers {
  if (response.action === "decline") {
    // Declining is the tool's own "skip": the model hears that nothing was chosen.
    return { answered: true, input: { ...input, answers: {} } };
  }
  if (response.action !== "accept") {
    return { answered: false };
  }

  // Only the accepted branch of the union carries content.
  const content = ((response as { content?: Record<string, unknown> }).content ?? {}) as Record<
    string,
    unknown
  >;
  const answers: Record<string, string> = {};
  const notes: Record<string, { notes: string }> = {};
  questions.forEach((question, index) => {
    const value = content[field(index)];
    const picks = (
      Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value]
    )
      .map(String)
      .filter((pick) => pick !== "");
    const other = content[otherField(index)];
    const custom = typeof other === "string" ? other.trim() : "";

    // Picking several is adding up; the typed answer joins the picks.
    if (question.multiSelect) {
      const all = custom === "" ? picks : [...picks, custom];
      if (all.length > 0) {
        answers[question.question] = all.join(", ");
      }
      return;
    }
    // One question, one answer: the pick wins, and anything typed rides along
    // as a note. With nothing picked, what was typed is the answer.
    const picked = picks.join(", ");
    if (picked === "") {
      if (custom !== "") {
        answers[question.question] = custom;
      }
      return;
    }
    answers[question.question] = picked;
    if (custom !== "") {
      notes[question.question] = { notes: custom };
    }
  });

  return {
    answered: true,
    input: {
      ...input,
      answers,
      ...(Object.keys(notes).length > 0 && { annotations: notes }),
    },
  };
}

// ── An MCP server's own request ─────────────────────────────────

type ElicitationContent = Record<string, string | number | boolean | string[]>;

/**
 * An MCP elicitation as an ACP form. Only form mode travels: a `url`
 * elicitation asks the user to finish something in a browser, which needs a
 * channel back that this host does not have yet.
 */
export function mcpForm(
  request: ElicitationRequest,
  sessionId: string,
): Extract<CreateElicitationRequest, { mode: "form" }> | undefined {
  if (request.mode !== undefined && request.mode !== "form") {
    return undefined;
  }
  return {
    mode: "form",
    sessionId,
    message: request.message || `${request.serverName} is asking for input.`,
    requestedSchema: schemaOf(request.requestedSchema),
  };
}

/** What the user did with the form, in the shape the MCP server expects. */
export function mcpResult(response: CreateElicitationResponse): ElicitationResult {
  if (response.action === "accept") {
    // ACP's values are exactly the primitives MCP allows back.
    const content = (response as { content?: ElicitationContent }).content;
    return { action: "accept", ...(content && { content }) };
  }
  return { action: response.action === "decline" ? "decline" : "cancel" };
}

/** An MCP schema is already JSON Schema; this keeps only what ACP declares. */
function schemaOf(schema: Record<string, unknown> | undefined): ElicitationSchema {
  const properties = schema?.properties;
  const required = schema?.required;
  return {
    type: "object",
    ...(properties !== null && typeof properties === "object"
      ? { properties: properties as Record<string, ElicitationPropertySchema> }
      : { properties: {} }),
    ...(Array.isArray(required) && { required: required.filter((r) => typeof r === "string") }),
    ...(typeof schema?.title === "string" && { title: schema.title }),
    ...(typeof schema?.description === "string" && { description: schema.description }),
  };
}
