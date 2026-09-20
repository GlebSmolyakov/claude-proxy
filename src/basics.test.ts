import { describe, expect, it } from "vitest";

import { AppError } from "./errors.js";
import { ALIASES, DEFAULT_MODEL, resolveModel } from "./models.js";
import { RuntimeStatus } from "./status.js";

describe("resolveModel", () => {
  it("passes aliases and full ids through", () => {
    for (const alias of ALIASES) {
      expect(resolveModel(alias)).toBe(alias);
    }
    for (const id of ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-5[1m]"]) {
      expect(resolveModel(id)).toBe(id);
    }
  });

  it("uses the default for a missing or blank model", () => {
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModel("  ")).toBe(DEFAULT_MODEL);
  });

  it("strips the provider prefix", () => {
    expect(resolveModel("claude-code-cli/sonnet")).toBe("sonnet");
  });

  it("refuses unknown models", () => {
    for (const name of ["gpt-4o", "claude-x --verbose", "llama3"]) {
      expect(() => resolveModel(name)).toThrow("Unknown model");
    }
  });
});

describe("AppError", () => {
  const upstream = (status: number) => AppError.upstream({ status, message: "boom" });

  it("keeps a valid upstream status and falls back to 502", () => {
    expect(upstream(429).status).toBe(429);
    expect(upstream(0).status).toBe(502);
  });

  it("renders the OpenAI shape", () => {
    expect(upstream(429).openaiBody()).toEqual({
      error: { message: "boom", type: "rate_limit_error", code: null },
    });
    expect(AppError.notFound("x").openaiBody()).toMatchObject({ error: { code: "not_found" } });
  });

  it("renders the Anthropic shape", () => {
    expect(upstream(529).anthropicBody()).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "boom" },
    });
    expect(upstream(502).anthropicBody()).toMatchObject({ error: { type: "api_error" } });
    expect(AppError.badRequest("x").anthropicBody()).toMatchObject({
      error: { type: "invalid_request_error" },
    });
  });
});

describe("RuntimeStatus", () => {
  it("records every unified window", () => {
    const status = new RuntimeStatus("x");
    expect(status.rateLimits()).toBeNull();
    status.recordRateLimit({
      status: "allowed",
      unifiedWindows: {
        seven_day: { utilization: 0.03 },
        five_hour: { utilization: 0.25, resetsAt: 10 },
      },
    } as never);
    const limits = status.rateLimits()!;
    expect(limits.status).toBe("allowed");
    expect(Object.keys(limits.windows)).toEqual(["five_hour", "seven_day"]);
    expect(limits.windows.five_hour).toEqual({ utilization: 0.25, resets_at: 10 });
  });

  it("merges single-window reports", () => {
    const status = new RuntimeStatus("x");
    status.recordRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1 });
    status.recordRateLimit({
      status: "allowed_warning",
      rateLimitType: "seven_day",
      utilization: 0.9,
    });
    const limits = status.rateLimits()!;
    expect(limits.status).toBe("allowed_warning");
    expect(limits.windows.five_hour.utilization).toBe(0.1);
    expect(limits.windows.seven_day.utilization).toBe(0.9);
  });

  it("records aliases but not full ids, and model limits", () => {
    const status = new RuntimeStatus("x");
    status.recordModel("haiku", "claude-haiku-4-5-20251001");
    status.recordModel("claude-sonnet-5", "claude-sonnet-5");
    expect(status.aliases()).toEqual({ haiku: "claude-haiku-4-5-20251001" });
    status.recordModelUsage({
      "claude-haiku-4-5-20251001": { contextWindow: 200_000, maxOutputTokens: 32_000 } as never,
    });
    expect(status.models()["claude-haiku-4-5-20251001"]).toEqual({
      context_window: 200_000,
      max_output_tokens: 32_000,
    });
  });
});
