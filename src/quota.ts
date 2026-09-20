// What the subscription has spent, said out loud when it starts to matter.
//
// The CLI reports every window it tracks on each turn. Most of those
// readings are noise; the ones worth a word are when a window crosses a
// threshold and when it runs out.

import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

/** Shares of a window that are worth interrupting for, largest first. */
export const THRESHOLDS = [0.95, 0.8] as const;

export interface Quota {
  /** `five_hour`, `seven_day`, … as the CLI names it. */
  window: string;
  /** Share of the window already spent, from 0 to 1. */
  used: number;
  /** Unix seconds when it starts over. */
  resetsAt?: number;
  spent: boolean;
}

/**
 * CLIs of this line report every window in `unifiedWindows`, which the SDK's
 * type does not declare; older ones report only the window that changed.
 */
type Report = SDKRateLimitInfo & {
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
};

export function quotas(info: Report): Quota[] {
  const spent = info.status === "rejected";
  if (info.unifiedWindows) {
    return Object.entries(info.unifiedWindows).flatMap(([window, reading]) =>
      reading.utilization === undefined
        ? []
        : [{ window, used: reading.utilization, resetsAt: reading.resetsAt, spent }],
    );
  }
  if (info.rateLimitType === undefined || info.utilization === undefined) {
    return [];
  }
  return [{ window: info.rateLimitType, used: info.utilization, resetsAt: info.resetsAt, spent }];
}

/**
 * The threshold this reading crosses for the first time, or `undefined` when
 * it says nothing new. `announced` remembers what a session has already been
 * told; a window that starts over is told about again.
 */
export function crossing(quota: Quota, announced: Map<string, number>): number | undefined {
  const told = announced.get(quota.window) ?? 0;
  if (quota.used < told) {
    // The window started over, so the next threshold is news again.
    announced.delete(quota.window);
  }
  const reached = quota.spent ? 1 : THRESHOLDS.find((threshold) => quota.used >= threshold);
  if (reached === undefined || reached <= (announced.get(quota.window) ?? 0)) {
    return undefined;
  }
  announced.set(quota.window, reached);
  return reached;
}

const WINDOWS: Record<string, string> = {
  five_hour: "five-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly with overage",
  overage: "overage",
};

export function quotaMessage(quota: Quota, now = Date.now()): string {
  const window = WINDOWS[quota.window] ?? quota.window.replaceAll("_", " ");
  const spent = quota.spent
    ? `the ${window} limit is used up`
    : `the ${window} limit is ${Math.round(quota.used * 100)}% used`;
  return `Subscription: ${spent}${resets(quota.resetsAt, now)}.`;
}

/** "; it starts over at 14:20" — with the date when that is not today. */
function resets(at: number | undefined, now: number): string {
  if (at === undefined) {
    return "";
  }
  const when = new Date(at * 1000);
  const sameDay = when.toDateString() === new Date(now).toDateString();
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return sameDay ? `; it starts over at ${time}` : `; it starts over on ${day} at ${time}`;
}
