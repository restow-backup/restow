/**
 * Structured JSON logging shared by the worker roles.
 *
 * One object per line so container log collectors parse it. Field values that
 * look like secrets are redacted defensively (bearer tokens, keys, passwords);
 * the real rule is that callers never pass secrets in the first place.
 */
import type { LogFields, Logger } from "./types.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are never logged verbatim. */
const SECRET_FIELD =
  /(secret|password|passwd|token|authorization|cookie|api[-_]?key|private[-_]?key)/i;

export function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(key)) {
      out[key] = "[redacted]";
    } else if (Buffer.isBuffer(value)) {
      out[key] = `<${value.length} bytes>`;
    } else if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface LogRecord {
  ts: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

export type LogSink = (record: LogRecord) => void;

/** Writes each record as one JSON line: warn/error to stderr, the rest to stdout. */
export const stdioSink: LogSink = (record) => {
  const line = `${JSON.stringify(record)}\n`;
  if (record.level === "warn" || record.level === "error") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
};

class SinkLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel,
    private readonly bound: LogFields,
    private readonly clock: () => Date,
  ) {}

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) {
      return;
    }
    this.sink({
      ts: this.clock().toISOString(),
      level,
      message,
      ...this.bound,
      ...(fields ? redactFields(fields) : {}),
    });
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  child(fields: LogFields): Logger {
    return new SinkLogger(
      this.sink,
      this.minLevel,
      { ...this.bound, ...redactFields(fields) },
      this.clock,
    );
  }
}

export interface CreateLoggerOptions {
  readonly sink?: LogSink;
  readonly level?: LogLevel;
  readonly fields?: LogFields;
  readonly clock?: () => Date;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return new SinkLogger(
    options.sink ?? stdioSink,
    options.level ?? "info",
    options.fields ? redactFields(options.fields) : {},
    options.clock ?? (() => new Date()),
  );
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
    ? value
    : fallback;
}

/** A logger that discards everything (tests, dry runs). */
export const noopLogger: Logger = createLogger({ sink: () => {}, level: "error" });
