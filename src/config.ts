// What the editor can change about a session besides its mode: the model.

import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import type { Session } from "./session.js";

export const MODEL_CONFIG_ID = "model";
/** The model from the user's own Claude Code settings. */
export const DEFAULT_MODEL = "default";

const DEFAULT_OPTION: SessionConfigSelectOption = {
  value: DEFAULT_MODEL,
  name: "Default",
  description: "The model your Claude Code settings choose",
};

/** Offered until the agent starts and says what the account really has. */
const ALIASES: SessionConfigSelectOption[] = [
  DEFAULT_OPTION,
  { value: "opus", name: "Opus", description: "The newest Opus" },
  { value: "sonnet", name: "Sonnet", description: "The newest Sonnet" },
  { value: "haiku", name: "Haiku", description: "The newest Haiku" },
];

export function modelOption(session: Session): SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    type: "select",
    name: "Model",
    category: "model",
    currentValue: session.model ?? DEFAULT_MODEL,
    options: session.models ?? ALIASES,
  };
}

/** The models the CLI reported, as the editor's picker shows them. */
export function modelOptions(models: ModelInfo[]): SessionConfigSelectOption[] {
  return [
    DEFAULT_OPTION,
    ...models.map((model) => ({
      value: model.value,
      name: model.displayName,
      ...(model.description !== "" && { description: model.description }),
    })),
  ];
}
