// Minimal dependency-free structured logger for the scheduler process.
//
// One JSON object per line so container log collectors can parse it. Secrets
// (connection strings, tokens) are never passed in as fields — the scheduler
// only ever logs operational facts, never credentials.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    component: "scheduler",
    message,
    ...fields,
  };
  const line = JSON.stringify(record);
  // warn/error to stderr, everything else to stdout.
  if (level === "warn" || level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields): void => emit("debug", message, fields),
  info: (message: string, fields?: LogFields): void => emit("info", message, fields),
  warn: (message: string, fields?: LogFields): void => emit("warn", message, fields),
  error: (message: string, fields?: LogFields): void => emit("error", message, fields),
};

/** Extract a safe, human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
