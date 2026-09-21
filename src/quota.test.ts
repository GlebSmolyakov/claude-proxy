import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { crossing, type Quota, quotaMessage, quotas } from "./quota.js";

const reading = (fields: object): SDKRateLimitInfo => ({ status: "allowed", ...fields }) as never;

describe("quotas", () => {
  it("take every window the CLI reports", () => {
    expect(
      quotas(
        reading({
          unifiedWindows: {
            five_hour: { utilization: 0.84, resetsAt: 1_789_850_000 },
            seven_day: { utilization: 0.3 },
          },
        }),
      ),
    ).toEqual([
      { window: "five_hour", used: 0.84, resetsAt: 1_789_850_000, spent: false },
      { window: "seven_day", used: 0.3, resetsAt: undefined, spent: false },
    ]);
  });

  it("fall back to the single window of an older CLI, and to nothing at all", () => {
    expect(quotas(reading({ rateLimitType: "five_hour", utilization: 0.5 }))).toEqual([
      { window: "five_hour", used: 0.5, resetsAt: undefined, spent: false },
    ]);
    expect(quotas(reading({}))).toEqual([]);
  });

  it("mark as used up only the window that ran out, not its neighbours", () => {
    expect(
      quotas(
        reading({
          status: "rejected",
          rateLimitType: "five_hour",
          unifiedWindows: {
            five_hour: { utilization: 1 },
            seven_day: { utilization: 0.12 },
          },
        }),
      ),
    ).toEqual([
      { window: "five_hour", used: 1, resetsAt: undefined, spent: true },
      { window: "seven_day", used: 0.12, resetsAt: undefined, spent: false },
    ]);
  });

  it("know when a window is used up", () => {
    const [quota] = quotas(
      reading({ status: "rejected", rateLimitType: "five_hour", utilization: 1 }),
    );
    expect(quota.spent).toBe(true);
  });
});

describe("crossing", () => {
  const quota = (used: number, spent = false): Quota => ({ window: "five_hour", used, spent });

  it("speaks once per threshold and stays quiet below it", () => {
    const announced = new Map<string, number>();
    expect(crossing(quota(0.5), announced)).toBeUndefined();
    expect(crossing(quota(0.81), announced)).toBe(0.8);
    expect(crossing(quota(0.9), announced)).toBeUndefined();
    expect(crossing(quota(0.96), announced)).toBe(0.95);
    expect(crossing(quota(0.99), announced)).toBeUndefined();
  });

  it("speaks again after the window starts over", () => {
    const announced = new Map<string, number>();
    crossing(quota(0.81), announced);
    expect(crossing(quota(0.05), announced)).toBeUndefined();
    expect(crossing(quota(0.82), announced)).toBe(0.8);
  });

  it("always has something to say about a window that is used up", () => {
    const announced = new Map<string, number>();
    crossing(quota(0.96), announced);
    expect(crossing(quota(1, true), announced)).toBe(1);
  });

  it("keeps windows apart", () => {
    const announced = new Map<string, number>();
    expect(crossing({ window: "five_hour", used: 0.85, spent: false }, announced)).toBe(0.8);
    expect(crossing({ window: "seven_day", used: 0.85, spent: false }, announced)).toBe(0.8);
  });
});

describe("quotaMessage", () => {
  const noon = new Date("2026-09-20T12:00:00Z").getTime();

  it("names the window, the share and when it starts over", () => {
    const text = quotaMessage(
      { window: "five_hour", used: 0.84, resetsAt: Math.floor(noon / 1000) + 3600, spent: false },
      noon,
    );
    expect(text).toMatch(/^Subscription: the five-hour limit is 84% used; it starts over at /);
  });

  it("says plainly when nothing is left, and dates a reset that is not today", () => {
    const text = quotaMessage(
      { window: "seven_day", used: 1, resetsAt: Math.floor(noon / 1000) + 3 * 86_400, spent: true },
      noon,
    );
    expect(text).toMatch(/^Subscription: the weekly limit is used up; it starts over on /);
  });

  it("leaves out a reset nobody reported, and spells out an unknown window", () => {
    expect(quotaMessage({ window: "some_other_window", used: 0.8, spent: false }, noon)).toBe(
      "Subscription: the some other window limit is 80% used.",
    );
  });
});
