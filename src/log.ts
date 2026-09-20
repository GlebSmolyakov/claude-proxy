// Leveled logging to stderr. `LOG_LEVEL=debug` adds the CLI's own stderr.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[process.env.LOG_LEVEL as Level] ?? LEVELS.info;

function write(level: Level, message: string): void {
  if (LEVELS[level] < threshold) {
    return;
  }
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`);
}

export const log = {
  debug: (message: string) => write("debug", message),
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
};
