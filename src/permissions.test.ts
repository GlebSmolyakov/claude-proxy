import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  availableModes,
  CANCELLED,
  decide,
  isMode,
  OPTION,
  permissionOptions,
} from "./permissions.js";

const rule: PermissionUpdate[] = [
  {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "npm test" }],
    behavior: "allow",
    destination: "localSettings",
  },
];

describe("permission options", () => {
  it("offer always-allow only with a suggested rule", () => {
    expect(permissionOptions("Bash", rule).map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
    expect(permissionOptions("Bash", undefined).map((o) => o.kind)).toEqual([
      "allow_once",
      "reject_once",
    ]);
  });

  it("choose a mode when leaving plan mode", () => {
    expect(permissionOptions("ExitPlanMode", undefined).map((o) => o.optionId)).toEqual([
      OPTION.planAcceptEdits,
      OPTION.planManual,
      OPTION.reject,
    ]);
  });
});

describe("decide", () => {
  const input = { command: "npm test" };
  const selected = (optionId: string) => ({ outcome: "selected" as const, optionId });

  it("allows once or with the suggested rule", () => {
    expect(decide("Bash", selected(OPTION.allow), input, rule).result).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
    expect(decide("Bash", selected(OPTION.allowAlways), input, rule).result).toEqual({
      behavior: "allow",
      updatedInput: input,
      updatedPermissions: rule,
    });
  });

  it("switches the mode when a plan is approved", () => {
    const decision = decide("ExitPlanMode", selected(OPTION.planAcceptEdits), {}, undefined);
    expect(decision.mode).toBe("acceptEdits");
    expect(decision.result).toMatchObject({
      behavior: "allow",
      updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    });
    expect(decide("ExitPlanMode", selected(OPTION.planManual), {}, undefined).mode).toBe("default");
  });

  it("denies a rejection, an unknown answer and a cancelled dialog", () => {
    expect(decide("Bash", selected(OPTION.reject), input, rule).result.behavior).toBe("deny");
    expect(decide("Bash", selected("made-up"), input, rule).result.behavior).toBe("deny");
    expect(decide("Bash", { outcome: "cancelled" }, input, rule).result).toBe(CANCELLED);
  });
});

describe("modes", () => {
  it("are the SDK's permission modes the editor can pick", () => {
    expect(availableModes().map((m) => m.id)).toEqual(
      expect.arrayContaining(["default", "acceptEdits", "plan", "dontAsk"]),
    );
    expect(isMode("plan")).toBe(true);
    expect(isMode("yolo")).toBe(false);
  });
});
