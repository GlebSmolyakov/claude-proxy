// Settings a project keeps for itself, in `.claude-proxy.json` beside the
// code: the model to run it with, the mode to start in, and which of the
// editor's MCP servers the CLI may reach from here. Flags stay the default
// for everything the file leaves out.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import type { Allowed } from "./acp-agent.js";
import { log } from "./log.js";
import { resolveModel } from "./models.js";
import { freerThan, isMode } from "./permissions.js";
import { parseWishes, type Wanted, type Wishes } from "./proxy.js";

export const PROJECT_FILE = ".claude-proxy.json";

export interface ProjectSettings {
  model?: string;
  permissionMode?: PermissionMode;
  /** Names of the editor's MCP servers, or "all". */
  allowMcp?: Allowed;
  /** Servers whose tools this host carries over itself, as `{ "Air": ["browser-read-page"] }`. */
  proxyMcp?: Wishes;
}

/** What the project asks for, as far as it asks for something usable. */
export function projectSettings(cwd: string): ProjectSettings {
  const path = join(cwd, PROJECT_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`Could not read ${path}: ${(e as Error).message}`);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.warn(`Ignoring ${path}: ${(e as Error).message}`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn(`Ignoring ${path}: it holds no settings object`);
    return {};
  }

  const settings: ProjectSettings = {};
  const { model, permissionMode, allowMcp, proxyMcp } = parsed as Record<string, unknown>;
  const complain = (field: string, why: string) => log.warn(`Ignoring ${field} in ${path}: ${why}`);

  if (typeof model === "string") {
    try {
      settings.model = resolveModel(model);
    } catch (e) {
      complain("model", (e as Error).message);
    }
  } else if (model !== undefined) {
    complain("model", "it is not a model name");
  }

  if (typeof permissionMode === "string" && isMode(permissionMode)) {
    settings.permissionMode = permissionMode;
  } else if (permissionMode !== undefined) {
    complain("permissionMode", `'${String(permissionMode)}' is not a mode of this host`);
  }

  if (allowMcp === "all") {
    settings.allowMcp = "all";
  } else if (Array.isArray(allowMcp) && allowMcp.every((name) => typeof name === "string")) {
    settings.allowMcp = allowMcp as string[];
  } else if (allowMcp !== undefined) {
    complain("allowMcp", 'it is neither a list of server names nor "all"');
  }

  if (typeof proxyMcp === "string") {
    settings.proxyMcp = parseWishes(proxyMcp);
  } else if (proxyMcp !== null && typeof proxyMcp === "object" && !Array.isArray(proxyMcp)) {
    const wishes: Wishes = {};
    for (const [server, wanted] of Object.entries(proxyMcp)) {
      if (
        wanted === "all" ||
        (Array.isArray(wanted) && wanted.every((n) => typeof n === "string"))
      ) {
        wishes[server] = wanted as "all" | string[];
      } else {
        complain(`proxyMcp.${server}`, 'it is neither a list of tool names nor "all"');
      }
    }
    settings.proxyMcp = wishes;
  } else if (proxyMcp !== undefined) {
    complain("proxyMcp", "it is not a set of servers");
  }

  const named = Object.entries(settings).map(([key, value]) =>
    Array.isArray(value)
      ? `${key}=${value.join(" ")}`
      : typeof value === "object" && value !== null
        ? `${key}=${Object.keys(value).join(" ")}`
        : `${key}=${String(value)}`,
  );
  if (named.length > 0) {
    log.info(`${PROJECT_FILE} in ${cwd}: ${named.join(", ")}`);
  }
  return settings;
}

/** What the operator allowed on the command line, as a ceiling for a project. */
export interface Limits {
  permissionMode: PermissionMode;
  allowMcp: Allowed;
  proxyMcp: Wishes;
}

/**
 * The project's settings, kept within the flags.
 *
 * `.claude-proxy.json` comes with the code, and code can be someone else's:
 * cloning a repository must not be enough to hand its agent a freer mode or
 * a server the operator never allowed. So a project may ask for less than
 * the host was started with, and never for more.
 */
export function narrowTo(settings: ProjectSettings, limits: Limits): ProjectSettings {
  const narrowed: ProjectSettings = { model: settings.model };
  const refuse = (field: string, why: string) =>
    log.warn(`Ignoring ${field} in ${PROJECT_FILE}: ${why}`);

  if (settings.permissionMode !== undefined) {
    if (freerThan(settings.permissionMode, limits.permissionMode)) {
      refuse(
        "permissionMode",
        `'${settings.permissionMode}' is freer than '${limits.permissionMode}', which this host was started with`,
      );
    } else {
      narrowed.permissionMode = settings.permissionMode;
    }
  }

  if (settings.allowMcp !== undefined) {
    narrowed.allowMcp = narrowAllowed(settings.allowMcp, limits.allowMcp);
  }

  if (settings.proxyMcp !== undefined) {
    narrowed.proxyMcp = narrowWishes(settings.proxyMcp, limits.proxyMcp, refuse);
  }
  return narrowed;
}

/** The servers a project asks for, minus the ones the flags never allowed. */
function narrowAllowed(asked: Allowed, limit: Allowed): Allowed {
  if (limit === "all") {
    return asked;
  }
  if (asked === "all") {
    return limit;
  }
  return asked.filter((name) => limit.includes(name));
}

/** The same for proxying, down to which tools of a server were allowed. */
function narrowWishes(
  asked: Wishes,
  limit: Wishes,
  refuse: (field: string, why: string) => void,
): Wishes {
  const wishes: Wishes = {};
  for (const [server, wanted] of Object.entries(asked)) {
    const allowed: Wanted | undefined = limit[server];
    if (allowed === undefined) {
      refuse(`proxyMcp.${server}`, "--proxy-mcp does not carry that server over");
      continue;
    }
    if (allowed === "all" || wanted === "all") {
      wishes[server] = allowed === "all" ? wanted : allowed;
      continue;
    }
    const kept = wanted.filter((name) => allowed.includes(name));
    if (kept.length === 0) {
      refuse(`proxyMcp.${server}`, "--proxy-mcp carries none of the tools it asks for");
      continue;
    }
    wishes[server] = kept;
  }
  return wishes;
}
