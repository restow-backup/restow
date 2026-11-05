/**
 * The arguments of `restow restore ...` and `restow node check` (main.ts parses, restore.ts
 * runs). Kept apart from the runner so the parser has no database import.
 */

export type RestoreCommand =
  | {
      kind: "restore-prepare";
      database: string;
      dumpName: string | null;
      via: string;
      json: boolean;
    }
  | { kind: "restore-activate"; database: string; json: boolean }
  | { kind: "restore-abort"; database: string }
  | { kind: "node-check"; json: boolean }
  | {
      kind: "cluster-override";
      file: string;
      exposure: { bind: string; port: number } | null;
    };

/** A command line that cannot be run (main.ts prints the usage, exit code 64). */
export class RestoreUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const DUMP_NAME = /^[0-9A-Za-z._-]{1,200}$/;

function options(
  command: string,
  rest: readonly string[],
  allowed: readonly string[],
  takesValue: readonly string[],
): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    let argument = rest[index] ?? "";
    let inline: string | null = null;
    const equals = argument.indexOf("=");
    if (argument.startsWith("--") && equals > 0) {
      inline = argument.slice(equals + 1);
      argument = argument.slice(0, equals);
    }
    if (!allowed.includes(argument)) {
      throw new RestoreUsageError(`Unknown option for ${command}: ${argument}`);
    }
    let value = "";
    if (takesValue.includes(argument)) {
      if (inline !== null) {
        value = inline;
      } else {
        const next = rest[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new RestoreUsageError(`${argument} needs a value.`);
        }
        value = next;
        index++;
      }
    }
    flags.set(argument, value);
  }
  return flags;
}

function databaseOption(flags: Map<string, string>, fallback: string): string {
  const database = flags.get("--database") ?? fallback;
  if (!DATABASE_NAME.test(database)) {
    throw new RestoreUsageError("--database needs a database name (lower case, digits, _).");
  }
  return database;
}

export function parseRestoreCommand(
  action: string | undefined,
  rest: readonly string[],
  scratch: string,
): RestoreCommand {
  switch (action) {
    case "prepare": {
      const flags = options(
        "restore prepare",
        rest,
        ["--database", "--dump-name", "--via", "--json"],
        ["--database", "--dump-name", "--via"],
      );
      const dumpName = flags.get("--dump-name") ?? null;
      if (dumpName !== null && !DUMP_NAME.test(dumpName)) {
        throw new RestoreUsageError("--dump-name needs a file name (letters, digits, . _ -).");
      }
      const via = (flags.get("--via") ?? "command line").trim().slice(0, 80) || "command line";
      return {
        kind: "restore-prepare",
        database: databaseOption(flags, scratch),
        dumpName,
        via,
        json: flags.has("--json"),
      };
    }
    case "activate": {
      const flags = options("restore activate", rest, ["--database", "--json"], ["--database"]);
      return {
        kind: "restore-activate",
        database: databaseOption(flags, scratch),
        json: flags.has("--json"),
      };
    }
    case "abort": {
      const flags = options("restore abort", rest, ["--database"], ["--database"]);
      return { kind: "restore-abort", database: databaseOption(flags, scratch) };
    }
    default:
      throw new RestoreUsageError(
        action ? `Unknown restore command: ${action}` : "restore needs a command",
      );
  }
}

export function parseNodeCommand(
  action: string | undefined,
  rest: readonly string[],
): RestoreCommand {
  if (action !== "check") {
    throw new RestoreUsageError(
      action ? `Unknown node command: ${action}` : "node needs a command",
    );
  }
  const flags = options("node check", rest, ["--json"], []);
  return { kind: "node-check", json: flags.has("--json") };
}

/** `restow cluster database-override --file F (--bind A --port P | --remove)` (install.sh). */
export function parseClusterCommand(
  action: string | undefined,
  rest: readonly string[],
): RestoreCommand {
  if (action !== "database-override") {
    throw new RestoreUsageError(
      action ? `Unknown cluster command: ${action}` : "cluster needs a command",
    );
  }
  const flags = options(
    "cluster database-override",
    rest,
    ["--file", "--bind", "--port", "--remove"],
    ["--file", "--bind", "--port"],
  );
  const file = flags.get("--file") ?? "";
  if (!/^\/[A-Za-z0-9._/-]+$/.test(file) || file.includes("..")) {
    throw new RestoreUsageError("--file needs the absolute path of the compose override.");
  }
  if (flags.has("--remove")) {
    if (flags.has("--bind") || flags.has("--port")) {
      throw new RestoreUsageError("--remove takes no --bind or --port.");
    }
    return { kind: "cluster-override", file, exposure: null };
  }
  const bind = flags.get("--bind") ?? "";
  const port = Number(flags.get("--port") ?? "5432");
  if (!/^[0-9A-Fa-f.:]+$/.test(bind) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RestoreUsageError("--bind needs an IP address of this host, --port 1 to 65535.");
  }
  return { kind: "cluster-override", file, exposure: { bind, port } };
}
