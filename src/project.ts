// Settings a project keeps for itself, in `.claude-proxy.json` beside the
// code: the model to run it with, the mode to start in, and which of the
// editor's MCP servers the CLI may reach from here. Flags stay the default
// for everything the file leaves out.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import { log } from "./log.js";
import { resolveModel } from "./models.js";
import { isMode } from "./permissions.js";
import { parseWishes, type Wishes } from "./proxy.js";

export const PROJECT_FILE = ".claude-proxy.json";

export interface ProjectSettings {
  model?: string;
  permissionMode?: PermissionMode;
  /** Names of the editor's MCP servers, or "all". */
  allowMcp?: "all" | string[];
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
