const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * JSON-lines logger. Writes to stderr so stdout stays free for process managers.
 * Callers must never pass tool arguments or tokens as fields: they can hold secret values.
 */
export function createLogger(level: LogLevel, write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lvl] < LEVELS[level]) return;
    write(`${JSON.stringify({ time: new Date().toISOString(), level: lvl, message, ...fields })}\n`);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
