// Maps conversation prefixes to saved CLI sessions.
//
// After every successful turn the store remembers which CLI session now
// holds the conversation including the reply (`Conversation.keyAfterReply`).
// The client's next request carries that same history, which hashes to the
// same key, so the turn resumes the session and sends only the new message.
// Every resume forks (`forkSession`), so regenerating an earlier reply
// branches off cleanly instead of appending to a session that moved on.

import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "./log.js";
import { unixNow } from "./status.js";

const SESSION_TTL_SECS = 24 * 60 * 60;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Entry {
  session_id: string;
  created_at: number;
  last_used_at: number;
}

export class SessionStore {
  private saving: Promise<void> = Promise.resolve();

  private constructor(
    private readonly entries: Map<string, Entry>,
    private readonly filePath: string,
    /** Where the CLI keeps transcripts for the proxy's working directory. */
    private readonly transcriptsDir: string,
  ) {}

  static async open(filePath: string, transcriptsDir: string): Promise<SessionStore> {
    let entries = new Map<string, Entry>();
    try {
      const data = await readFile(filePath, "utf8");
      try {
        entries = new Map(Object.entries(JSON.parse(data) as Record<string, Entry>));
      } catch (e) {
        log.warn(`Ignoring unreadable sessions file ${filePath}: ${(e as Error).message}`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        log.warn(`Could not read sessions file ${filePath}: ${(e as Error).message}`);
      }
    }
    if (entries.size > 0) {
      log.info(`Loaded ${entries.size} saved sessions from ${filePath}`);
    }
    return new SessionStore(entries, filePath, transcriptsDir);
  }

  /** The session that holds the conversation up to `key`, if any. */
  lookup(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    entry.last_used_at = unixNow();
    return entry.session_id;
  }

  async remember(key: string, sessionId: string): Promise<void> {
    const now = unixNow();
    this.entries.set(key, { session_id: sessionId, created_at: now, last_used_at: now });
    await this.save();
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Drop entries unused for a day and delete the CLI transcripts that no
   * remaining entry points to. Returns how many entries were dropped.
   */
  cleanupExpired(): Promise<number> {
    return this.cleanupOlderThan(unixNow() - SESSION_TTL_SECS);
  }

  async cleanupOlderThan(cutoff: number): Promise<number> {
    const dropped: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.last_used_at < cutoff) {
        dropped.push(entry.session_id);
        this.entries.delete(key);
      }
    }
    const alive = new Set([...this.entries.values()].map((e) => e.session_id));
    const orphaned = dropped.filter((id) => !alive.has(id));
    if (orphaned.length === 0) {
      return 0;
    }

    let deleted = 0;
    for (const id of orphaned) {
      // Session ids come from our own file; only ever delete `<uuid>.jsonl`.
      if (!UUID.test(id)) {
        continue;
      }
      try {
        await rm(join(this.transcriptsDir, `${id}.jsonl`));
        deleted += 1;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn(`Could not delete transcript ${id}: ${(e as Error).message}`);
        }
      }
    }
    log.info(`Expired ${orphaned.length} saved sessions, deleted ${deleted} transcripts`);
    await this.save();
    return orphaned.length;
  }

  /** Clean up every hour; the timer does not keep the process alive. */
  startCleanup(): NodeJS.Timeout {
    const timer = setInterval(() => void this.cleanupExpired(), CLEANUP_EVERY_MS);
    timer.unref();
    return timer;
  }

  /** Write the file atomically, one write at a time: a temp file renamed over the old one. */
  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const data = JSON.stringify(Object.fromEntries(this.entries), null, 2);
      const tmp = `${this.filePath}.tmp`;
      try {
        await writeFile(tmp, data);
        await rename(tmp, this.filePath);
      } catch (e) {
        log.error(`Failed to write ${this.filePath}: ${(e as Error).message}`);
      }
    });
    return this.saving;
  }
}

/**
 * The directory where the CLI saves sessions started in `cwd`:
 * `<config dir>/projects/<cwd with every character other than an ASCII
 * letter, digit or '-' replaced by '-'>`. The config dir is
 * `$CLAUDE_CONFIG_DIR`, or `~/.claude` by default.
 */
export function transcriptsDirFor(cwd: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(configDir, "projects", cwd.replace(/[^A-Za-z0-9-]/g, "-"));
}
