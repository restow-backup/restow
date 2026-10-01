import type { Redactor } from "./redact.js";

/** Where the updater's own log lines go. Every line passes through the redactor first. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Writes `<time> <level> [updater] <message>` to stdout (info) or stderr (warn, error). */
export function consoleLogger(redactor: Redactor, now: () => Date = () => new Date()): Logger {
  const write = (level: string, sink: (line: string) => void, message: string): void => {
    sink(`${now().toISOString()} ${level} [updater] ${redactor.oneLine(message, 4000)}`);
  };
  return {
    info: (message) => write("INFO", (line) => console.log(line), message),
    warn: (message) => write("WARN", (line) => console.warn(line), message),
    error: (message) => write("ERROR", (line) => console.error(line), message),
  };
}

/** A logger that keeps its lines (tests). */
export function memoryLogger(redactor: Redactor): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (message: string) => {
    lines.push(`${level} ${redactor.oneLine(message, 4000)}`);
  };
  return { lines, info: add("INFO"), warn: add("WARN"), error: add("ERROR") };
}
