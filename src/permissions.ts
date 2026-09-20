// Modes the editor can switch between, what it offers when the agent asks
// for approval, and what each answer means for the SDK.

import type {
  PermissionOption,
  RequestPermissionOutcome,
  SessionMode,
} from "@agentclientprotocol/sdk";
import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";

import type { Input } from "./tools.js";

// Bypassing permissions does not work as root outside a sandbox; the CLI refuses it.
const IS_ROOT = process.geteuid?.() === 0;
export const ALLOW_BYPASS = !IS_ROOT || Boolean(process.env.IS_SANDBOX);

const MODES: SessionMode[] = [
  { id: "default", name: "Default", description: "Ask before edits and commands" },
  { id: "acceptEdits", name: "Accept Edits", description: "Edit files without asking" },
  { id: "plan", name: "Plan", description: "Research and plan without changing anything" },
  { id: "dontAsk", name: "Don't Ask", description: "Refuse whatever is not allowed in advance" },
  {
    id: "bypassPermissions",
    name: "Bypass Permissions",
    description: "Do everything without asking",
  },
];

export function availableModes(): SessionMode[] {
  return MODES.filter((m) => ALLOW_BYPASS || m.id !== "bypassPermissions");
}

export function isMode(id: string): id is PermissionMode {
  return availableModes().some((m) => m.id === id);
}

export const OPTION = {
  allow: "allow",
  allowAlways: "allow-always",
  reject: "reject",
  planAcceptEdits: "plan-accept-edits",
  planManual: "plan-manual",
} as const;

/**
 * "Always allow" appears only when the CLI suggested a rule for it. Leaving
 * plan mode picks the mode to work in.
 */
export function permissionOptions(
  toolName: string,
  suggestions: PermissionUpdate[] | undefined,
): PermissionOption[] {
  if (toolName === "ExitPlanMode") {
    return [
      {
        optionId: OPTION.planAcceptEdits,
        name: "Yes, and auto-accept edits",
        kind: "allow_always",
      },
      { optionId: OPTION.planManual, name: "Yes, and manually approve edits", kind: "allow_once" },
      { optionId: OPTION.reject, name: "No, keep planning", kind: "reject_once" },
    ];
  }
  return [
    { optionId: OPTION.allow, name: "Allow", kind: "allow_once" },
    ...(suggestions?.length
      ? [{ optionId: OPTION.allowAlways, name: "Always allow", kind: "allow_always" as const }]
      : []),
    { optionId: OPTION.reject, name: "Reject", kind: "reject_once" },
  ];
}

export interface Decision {
  result: PermissionResult;
  /** The mode the session switches to, when the answer changes it. */
  mode?: PermissionMode;
}

/** The turn was cancelled while the question was open. */
export const CANCELLED: PermissionResult = {
  behavior: "deny",
  message: "The user cancelled the turn.",
  interrupt: true,
};

export function decide(
  toolName: string,
  outcome: RequestPermissionOutcome,
  input: Input,
  suggestions: PermissionUpdate[] | undefined,
): Decision {
  if (outcome.outcome === "cancelled") {
    return { result: CANCELLED };
  }
  switch (outcome.optionId) {
    case OPTION.allow:
      return { result: { behavior: "allow", updatedInput: input } };
    case OPTION.allowAlways:
      return {
        result: { behavior: "allow", updatedInput: input, updatedPermissions: suggestions ?? [] },
      };
    case OPTION.planAcceptEdits:
    case OPTION.planManual: {
      const mode = outcome.optionId === OPTION.planAcceptEdits ? "acceptEdits" : "default";
      return {
        result: {
          behavior: "allow",
          updatedInput: input,
          updatedPermissions: [{ type: "setMode", mode, destination: "session" }],
        },
        mode,
      };
    }
    default:
      return {
        result: {
          behavior: "deny",
          message:
            toolName === "ExitPlanMode"
              ? "The user wants to keep planning. Ask what to change in the plan."
              : "The user rejected this action. Do not retry it; stop and wait for their instructions.",
        },
      };
  }
}
