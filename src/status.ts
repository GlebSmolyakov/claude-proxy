// What the proxy learns while it runs: uptime, the CLI version, the
// subscription limits the CLI reports on every turn, and which real model
// ids stand behind the aliases.

import type { ModelUsage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import { ALIASES } from "./models.js";

export interface RateLimitWindow {
  /** Share of the window already used, from 0.0 to 1.0. */
  utilization: number | null;
  resets_at: number | null;
}

export interface RateLimits {
  status: string | null;
  /** Window name (`five_hour`, `seven_day`, …) → how much is used. */
  windows: Record<string, RateLimitWindow>;
  /** Unix seconds when the CLI last reported these numbers. */
  reported_at: number;
}

export interface ModelLimits {
  context_window: number | null;
  max_output_tokens: number | null;
}

/**
 * CLIs of this line report every window in `unifiedWindows`, which the SDK's
 * type does not declare; the declared fields describe only the window that
 * triggered the event.
 */
type RateLimitReport = SDKRateLimitInfo & {
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
};

export class RuntimeStatus {
  private readonly started = Date.now();
  private limits: RateLimits | null = null;
  /** Alias → the model id it resolved to on the last turn that used it. */
  private readonly aliasIds = new Map<string, string>();
  /** Model id → what `modelUsage` said about it. */
  private readonly modelLimits = new Map<string, ModelLimits>();

  constructor(readonly cliVersion: string) {}

  uptimeSecs(): number {
    return Math.floor((Date.now() - this.started) / 1000);
  }

  recordRateLimit(info: RateLimitReport): void {
    let windows: Record<string, RateLimitWindow>;
    if (info.unifiedWindows) {
      windows = Object.fromEntries(
        Object.entries(info.unifiedWindows).map(([name, w]) => [
          name,
          { utilization: w.utilization ?? null, resets_at: w.resetsAt ?? null },
        ]),
      );
    } else {
      windows = { ...this.limits?.windows };
      if (info.rateLimitType) {
        windows[info.rateLimitType] = {
          utilization: info.utilization ?? null,
          resets_at: info.resetsAt ?? null,
        };
      }
    }
    this.limits = { status: info.status ?? null, windows: sorted(windows), reported_at: unixNow() };
  }

  /** Remember what an alias resolved to. Full ids are not aliases and are skipped. */
  recordModel(requested: string, resolved: string): void {
    if ((ALIASES as readonly string[]).includes(requested)) {
      this.aliasIds.set(requested, resolved);
    }
  }

  recordModelUsage(usage: Record<string, ModelUsage>): void {
    for (const [id, facts] of Object.entries(usage)) {
      this.modelLimits.set(id, {
        context_window: facts.contextWindow ?? null,
        max_output_tokens: facts.maxOutputTokens ?? null,
      });
    }
  }

  rateLimits(): RateLimits | null {
    return this.limits;
  }

  aliases(): Record<string, string> {
    return sorted(Object.fromEntries(this.aliasIds));
  }

  models(): Record<string, ModelLimits> {
    return sorted(Object.fromEntries(this.modelLimits));
  }
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function sorted<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
