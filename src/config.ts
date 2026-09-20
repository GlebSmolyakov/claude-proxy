// What the editor can change about a session besides its mode: the model.

import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import type { Session } from "./session.js";

export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";
export const THINKING_CONFIG_ID = "thinking";
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

/** Left as the CLI's own choice. */
const DEFAULT_VALUE = "default";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Every option the editor may change, as it stands now. */
export function configOptions(session: Session): SessionConfigOption[] {
  return [
    modelOption(session),
    ...(session.effortLevels ? [effortOption(session)] : []),
    thinkingOption(session),
  ];
}

/**
 * How hard the model works on a turn. Offered only once the agent has said
 * the model takes the setting at all.
 */
function effortOption(session: Session): SessionConfigOption {
  const levels = session.effortLevels ?? EFFORT_LEVELS;
  return {
    id: EFFORT_CONFIG_ID,
    type: "select",
    name: "Effort",
    category: "model_config",
    currentValue: session.effort ?? DEFAULT_VALUE,
    options: [
      { value: DEFAULT_VALUE, name: "Default", description: "The level Claude Code picks" },
      ...levels.map((level) => ({ value: level, name: level })),
    ],
  };
}

/** Whether the model thinks before it answers. */
function thinkingOption(session: Session): SessionConfigOption {
  return {
    id: THINKING_CONFIG_ID,
    type: "select",
    name: "Thinking",
    category: "thought_level",
    currentValue: session.thinking ?? DEFAULT_VALUE,
    options: [
      { value: DEFAULT_VALUE, name: "Default", description: "As Claude Code has it" },
      { value: "adaptive", name: "Adaptive", description: "The model decides how much to think" },
      { value: "off", name: "Off", description: "Answer without thinking first" },
    ],
  };
}

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

/** The effort levels the current model takes, or `undefined` when it takes none. */
export function effortLevels(models: ModelInfo[], resolved: string): readonly string[] | undefined {
  const model = models.find(
    (m) => (m.resolvedModel ?? m.value) === resolved || m.value === resolved,
  );
  if (model?.supportsEffort !== true) {
    return undefined;
  }
  return model.supportedEffortLevels ?? EFFORT_LEVELS;
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
