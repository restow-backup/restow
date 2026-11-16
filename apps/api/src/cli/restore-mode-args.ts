/**
 * The arguments of `restow restore-mode ...` (main.ts parses, restore-mode.ts runs). Kept apart
 * from the runner so the parser has no database import.
 */

export type RestoreModeCommand =
  | { kind: "restore-mode-status"; json: boolean }
  | { kind: "restore-mode-on"; reason: string; yes: boolean }
  | { kind: "restore-mode-check" }
  | { kind: "restore-mode-import-keys"; tenantId: string | null; yes: boolean }
  | {
      kind: "restore-mode-off";
      email: string;
      checked: string;
      storageOnlyData: "keep" | "release";
      acceptUnreachable: string[];
      yes: boolean;
    };

/** A command line that cannot be run (main.ts prints the usage, exit code 64). */
export class RestoreModeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const MIN_CHECKED = 20;

function optionValue(rest: readonly string[], index: number, option: string): string {
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new RestoreModeUsageError(`${option} needs a value.`);
  }
  return value;
}

export function parseRestoreModeCommand(
  action: string | undefined,
  rest: readonly string[],
): RestoreModeCommand {
  const flags = new Map<string, string[]>();
  const known: Record<string, readonly string[]> = {
    status: ["--json"],
    on: ["--reason", "--yes"],
    check: [],
    "import-keys": ["--tenant", "--yes"],
    off: ["--email", "--checked", "--storage-only-data", "--accept-unreachable", "--yes"],
  };
  if (action === undefined || !(action in known)) {
    throw new RestoreModeUsageError(
      action ? `Unknown restore-mode command: ${action}` : "restore-mode needs a command",
    );
  }
  const allowed = known[action] as readonly string[];
  const takesValue = new Set([
    "--reason",
    "--tenant",
    "--email",
    "--checked",
    "--storage-only-data",
    "--accept-unreachable",
  ]);
  for (let index = 0; index < rest.length; index++) {
    let argument = rest[index] ?? "";
    let inline: string | null = null;
    const equals = argument.indexOf("=");
    if (argument.startsWith("--") && equals > 0) {
      inline = argument.slice(equals + 1);
      argument = argument.slice(0, equals);
    }
    if (argument === "-y") {
      argument = "--yes";
    }
    if (!allowed.includes(argument)) {
      throw new RestoreModeUsageError(`Unknown option for restore-mode ${action}: ${argument}`);
    }
    let value = "";
    if (takesValue.has(argument)) {
      value = inline ?? optionValue(rest, index, argument);
      if (inline === null) {
        index++;
      }
    }
    flags.set(argument, [...(flags.get(argument) ?? []), value]);
  }
  const one = (name: string) => flags.get(name)?.at(-1);
  const yes = flags.has("--yes");
  switch (action) {
    case "status":
      return { kind: "restore-mode-status", json: flags.has("--json") };
    case "on": {
      const reason = one("--reason")?.trim();
      if (!reason) {
        throw new RestoreModeUsageError('restore-mode on needs --reason "<text>".');
      }
      return { kind: "restore-mode-on", reason, yes };
    }
    case "check":
      return { kind: "restore-mode-check" };
    case "import-keys": {
      const tenant = one("--tenant")?.trim() ?? null;
      if (tenant !== null && !/^[0-9a-f-]{36}$/i.test(tenant)) {
        throw new RestoreModeUsageError("--tenant needs a tenant id.");
      }
      return { kind: "restore-mode-import-keys", tenantId: tenant, yes };
    }
    default: {
      const email = one("--email")?.trim();
      if (!email?.includes("@")) {
        throw new RestoreModeUsageError("restore-mode off needs --email <address> of an owner.");
      }
      const checked = one("--checked")?.trim() ?? "";
      if (checked.length < MIN_CHECKED) {
        throw new RestoreModeUsageError(
          `restore-mode off needs --checked "<what was checked>" with at least ${MIN_CHECKED} characters.`,
        );
      }
      const mode = one("--storage-only-data") ?? "keep";
      if (mode !== "keep" && mode !== "release") {
        throw new RestoreModeUsageError("--storage-only-data is keep or release.");
      }
      return {
        kind: "restore-mode-off",
        email,
        checked,
        storageOnlyData: mode,
        acceptUnreachable: flags.get("--accept-unreachable") ?? [],
        yes,
      };
    }
  }
}
