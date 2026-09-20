// Which model names the proxy accepts and what it passes to the SDK's `model`.

import { AppError } from "./errors.js";

/** CLI aliases. The CLI resolves each one to the newest model of that family. */
export const ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/** Used when a request names no model. */
export const DEFAULT_MODEL = "opus";

/**
 * Map a requested model name to a `model` value.
 *
 * Aliases pass through, as do full Claude model ids such as
 * `claude-sonnet-5` or `claude-opus-5[1m]`; the CLI checks those itself.
 * Anything else is refused instead of silently falling back to a model the
 * client did not ask for.
 */
export function resolveModel(requested: string | null | undefined): string {
  const trimmed = requested?.trim();
  if (!trimmed) {
    return DEFAULT_MODEL;
  }
  const name = trimmed.startsWith("claude-code-cli/")
    ? trimmed.slice("claude-code-cli/".length)
    : trimmed;

  if ((ALIASES as readonly string[]).includes(name)) {
    return name;
  }
  if (name.startsWith("claude-") && /^[A-Za-z0-9.\-[\]]+$/.test(name)) {
    return name;
  }
  throw AppError.badRequest(
    `Unknown model '${name}'. Use an alias (${ALIASES.join(", ")}) or a full Claude model id such as claude-sonnet-5.`,
  );
}
