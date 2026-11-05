import { createInterface } from "node:readline/promises";
import type { AdminSummary, RecoveryResult } from "./admin-recovery.js";
import {
  parseClusterCommand,
  parseNodeCommand,
  parseRestoreCommand,
  type RestoreCommand,
  RestoreUsageError,
} from "./restore-args.js";
import {
  parseRestoreModeCommand,
  type RestoreModeCommand,
  RestoreModeUsageError,
} from "./restore-mode-args.js";

/** The scratch database a restore is prepared in (features/setup-restore/report.ts). */
const SCRATCH_DATABASE = "restow_restore";
const RESTORE_KINDS: ReadonlySet<string> = new Set([
  "restore-prepare",
  "restore-activate",
  "restore-abort",
  "node-check",
  "cluster-override",
]);

/**
 * `restow`: maintenance commands an operator runs on the server, in the api
 * container (the image installs ./bin.ts as /usr/local/bin/restow):
 *
 *   docker compose exec api restow admin list
 *   docker compose exec api restow admin recover --email owner@example.com
 *   docker compose run --rm --no-deps --entrypoint restow api restore-mode on --reason "..."
 *
 * It uses the api's own configuration (the container environment) and talks
 * to the database directly; it needs no running api and opens no port.
 * Nothing secret is printed: the new password is typed at a hidden prompt, or
 * read from standard input with --password-stdin.
 */

export const USAGE = `Usage: restow <command>

Commands:
  admin list
      List the administrators of this installation.

  admin recover --email <address> [--password-stdin] [--yes]
      Give an owner who lost their passkey, authenticator app or password
      access again: sets a new password (asked for at a hidden prompt),
      removes their authenticator app and passkeys and ends all their
      sessions. They then sign in with the new password and set up an
      authenticator app again. Recorded in the audit log.

        --password-stdin   read the new password from the first line of
                           standard input (for scripts; needs --yes)
        --yes              do not ask for confirmation

  restore-mode status [--json]
      Whether restore mode is on, and what the last comparison of the
      storage with the database found.

  restore-mode on --reason <text> [--yes]
      Switch restore mode on after restoring a database dump, before the
      worker and the scheduler start: nothing is deleted (no retention, no
      clean-up, no purge) and jobs from before the restore are held. New
      backups still run.

  restore-mode check
      Compare every tenant's storage with the database now, one line per
      storage target.

  restore-mode import-keys [--tenant <id>] [--yes]
      Take wrapped keys found in storage that the database does not have
      into the database (each must open with the master key and be the
      same on every target).

  restore-mode off --email <owner> --checked <text>
                   [--storage-only-data keep|release]
                   [--accept-unreachable <tenant>/<target>]... [--yes]
      End restore mode after checking the restored database. --checked
      says in at least 20 characters what was checked. With "keep" (the
      default) data in storage the database does not know stays for good;
      "release" lets the clean-ups remove it again.

  restore prepare [--database restow_restore] [--dump-name <file>] [--json]
      After a database dump of an installation was restored into the
      scratch database (the setup wizard and install.sh --restore do that):
      migrate it to this release, switch restore mode on in it, check that
      RESTOW_MASTER_KEY opens its keys and secrets and compare its storage
      targets. Exit code 0 ok, 3 the master key does not match, 4 the dump
      is refused (newer release, no Restow database, no setup), 1 error.

  restore activate [--database restow_restore] [--json]
      Make the prepared scratch database the live database (api, worker
      and scheduler stopped); the fresh database is kept aside.

  restore abort [--database restow_restore]
      Drop the scratch database; the live database is unchanged.

  node check [--json]
      On a worker node (install.sh --join): check the encrypted database
      connection, the roles, the schema version, the master key and every
      storage target before the worker starts.

  cluster database-override --file <override> (--bind <address> --port <port> | --remove)
      Used by install.sh --allow-worker: publish PostgreSQL with TLS for
      worker nodes in docker-compose.override.yml, or take that out again.

  help
      Show this text.

Run it in the api container, for example:
  docker compose exec api restow admin recover --email owner@example.com

After restoring a database dump, while only postgres runs:
  docker compose run --rm --no-deps --entrypoint restow api restore-mode on --reason "rollback to 0.5.0"
`;

export type Command =
  | { kind: "help" }
  | { kind: "list" }
  | {
      kind: "recover";
      email: string;
      passwordStdin: boolean;
      yes: boolean;
    }
  | RestoreModeCommand
  | RestoreCommand;

/** A command line that cannot be run; printed with the usage, exit code 64. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Parse the arguments after `restow`. Throws {@link UsageError}. */
export function parseCommand(args: readonly string[]): Command {
  const [group, action, ...rest] = args;
  if (group === undefined || group === "help" || group === "--help" || group === "-h") {
    return { kind: "help" };
  }
  if (group === "restore-mode") {
    try {
      return parseRestoreModeCommand(action, rest);
    } catch (error) {
      if (error instanceof RestoreModeUsageError) {
        throw new UsageError(error.message);
      }
      throw error;
    }
  }
  if (group === "restore" || group === "node" || group === "cluster") {
    try {
      return group === "restore"
        ? parseRestoreCommand(action, rest, SCRATCH_DATABASE)
        : group === "node"
          ? parseNodeCommand(action, rest)
          : parseClusterCommand(action, rest);
    } catch (error) {
      if (error instanceof RestoreUsageError) {
        throw new UsageError(error.message);
      }
      throw error;
    }
  }
  if (group !== "admin") {
    throw new UsageError(`Unknown command: ${group}`);
  }
  if (action === "list") {
    if (rest.length > 0) {
      throw new UsageError(`admin list takes no arguments: ${rest.join(" ")}`);
    }
    return { kind: "list" };
  }
  if (action !== "recover") {
    throw new UsageError(action ? `Unknown admin command: ${action}` : "admin needs a command");
  }
  let email: string | undefined;
  let passwordStdin = false;
  let yes = false;
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index] ?? "";
    if (argument === "--email") {
      email = rest[++index];
    } else if (argument.startsWith("--email=")) {
      email = argument.slice("--email=".length);
    } else if (argument === "--password-stdin") {
      passwordStdin = true;
    } else if (argument === "--yes" || argument === "-y") {
      yes = true;
    } else {
      throw new UsageError(`Unknown option for admin recover: ${argument}`);
    }
  }
  if (!email?.includes("@")) {
    throw new UsageError("admin recover needs --email <address> of the owner.");
  }
  return { kind: "recover", email: email.trim(), passwordStdin, yes };
}

/** The administrators as a plain table. */
export function formatAdmins(admins: readonly AdminSummary[]): string {
  if (admins.length === 0) {
    return "This installation has no administrator yet. Complete the setup wizard first.\n";
  }
  const header = ["EMAIL", "NAME", "ROLE", "PASSWORD", "AUTHENTICATOR", "PASSKEYS", "STATE"];
  const rows = admins.map((admin) => [
    admin.email,
    admin.name,
    admin.teamRole,
    admin.password ? "yes" : "no",
    admin.authenticatorApp ? "yes" : "no",
    String(admin.passkeys),
    admin.disabled ? "disabled" : "active",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  return `${[header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n`;
}

/** What happened, and what the owner does next. */
export function formatRecovery(result: RecoveryResult, signInAt: string | null): string {
  const lines = [
    `Access of ${result.email} recovered:`,
    result.passwordCreated ? "  - password set (the account had none)" : "  - password replaced",
    result.authenticatorRemoved
      ? "  - authenticator app removed"
      : "  - no authenticator app was set up",
    `  - ${result.passkeysRemoved} passkey(s) removed`,
    `  - ${result.sessionsEnded} session(s) ended`,
    "",
    `Sign in${signInAt ? ` at ${signInAt}` : ""} with ${result.email} and the new password.`,
    "You will be asked to set up an authenticator app before anything else;",
    "add a new passkey afterwards under your account. The recovery is recorded",
    "in the audit log (account.access_recovered).",
  ];
  return `${lines.join("\n")}\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The first line of standard input, without its line break. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

/** Read a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    throw new UsageError(
      "No terminal to ask for the password. Run docker compose exec without -T, or pass --password-stdin.",
    );
  }
  process.stdout.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          finish();
          reject(new UsageError("Cancelled."));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new UsageError("No terminal to confirm on. Pass --yes to run without confirmation.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(question);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function newPassword(fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    return firstLine(await readStdin());
  }
  const first = await promptHidden("New password: ");
  const second = await promptHidden("Repeat the new password: ");
  if (first !== second) {
    throw new UsageError("The two passwords differ. Nothing was changed.");
  }
  return first;
}

async function run(command: Command): Promise<number> {
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  // A restore and the node check bring their own connections (the scratch database, the node's).
  if (RESTORE_KINDS.has(command.kind)) {
    const { runRestoreCommand } = await import("./restore.js");
    return runRestoreCommand(command as RestoreCommand, {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  }
  // Configuration and database only now: `restow help` works anywhere.
  const { config, missingRequiredConfig } = await import("../config.js");
  const missing = missingRequiredConfig(config).filter((name) => name.startsWith("DATABASE_"));
  if (missing.length > 0) {
    process.stderr.write(
      `Missing configuration: ${missing.join(", ")}. Run this in the api container (docker compose exec api restow ...).\n`,
    );
    return 1;
  }
  const { authDb, db, providerDb } = await import("../db.js");
  const recovery = await import("./admin-recovery.js");
  try {
    if (command.kind.startsWith("restore-mode")) {
      const { runRestoreModeCommand } = await import("./restore-mode.js");
      return await runRestoreModeCommand(command as RestoreModeCommand, providerDb, {
        confirm,
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    }
    if (command.kind === "list") {
      process.stdout.write(formatAdmins(await recovery.listProviderAdmins(providerDb)));
      return 0;
    }
    if (command.kind !== "recover") {
      throw new UsageError("Unknown command.");
    }
    // Refused before anything is asked: an unknown account, not an owner, disabled.
    const target = await recovery.recoveryTarget(providerDb, command.email);
    if (!command.yes) {
      const passkeys =
        (await recovery.listProviderAdmins(providerDb)).find(
          (admin) => admin.email === target.email,
        )?.passkeys ?? 0;
      const agreed = await confirm(
        `Set a new password for ${target.email}, remove the authenticator app and ${passkeys} passkey(s) and end all sessions? [y/N] `,
      );
      if (!agreed) {
        process.stdout.write("Nothing was changed.\n");
        return 1;
      }
    }
    const password = await newPassword(command.passwordStdin);
    const problem = recovery.passwordProblem(password);
    if (problem) {
      throw new UsageError(`${problem} Nothing was changed.`);
    }
    const result = await recovery.recoverAdminAccess(providerDb, {
      email: target.email,
      password,
    });
    process.stdout.write(
      formatRecovery(result, await recovery.signInUrl(providerDb, config.publicUrl)),
    );
    return 0;
  } catch (error) {
    if (
      error instanceof recovery.RecoveryError ||
      error instanceof UsageError ||
      (error instanceof Error && error.name === "ProblemError")
    ) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await Promise.allSettled([db.$client.end(), providerDb.$client.end(), authDb.$client.end()]);
  }
}

/** Entry point: parse, run, exit with 0, 1 (refused or failed) or 64 (usage). */
export async function main(args: readonly string[]): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(args);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 64;
    }
    throw error;
  }
  try {
    return await run(command);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`restow: ${reason}\n`);
    return 1;
  }
}
