// Which model names `--model` accepts.

/** CLI aliases. The CLI resolves each one to the newest model of that family. */
export const ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/**
 * Aliases pass through, as do full Claude model ids such as
 * `claude-sonnet-5` or `claude-opus-5[1m]`; the CLI checks those itself.
 * Anything else is refused instead of silently falling back to a model
 * nobody asked for.
 */
export function resolveModel(requested: string): string {
  const name = requested.trim();
  if ((ALIASES as readonly string[]).includes(name)) {
    return name;
  }
  if (name.startsWith("claude-") && /^[A-Za-z0-9.\-[\]]+$/.test(name)) {
    return name;
  }
  throw new Error(
    `Unknown model '${name}'. Use an alias (${ALIASES.join(", ")}) or a full Claude model id such as claude-sonnet-5.`,
  );
}
