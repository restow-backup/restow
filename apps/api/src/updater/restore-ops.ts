import * as path from "node:path";
import { isDumpFileName } from "./dumps.js";
import type { PostgresSettings } from "./env-file.js";
import { type CommandResult, type CommandRunner, OpsError } from "./ops.js";
import { SERVICES } from "./ops-cli.js";
import type { Redactor } from "./redact.js";
import { SCRATCH_DATABASE } from "./restore-report.js";

/**
 * The Docker commands of a restore from a dump (restore.ts), as argument vectors for a
 * CommandRunner, never shell strings:
 *
 *   createScratch   `psql -d postgres -c 'CREATE DATABASE restow_restore'` (dropped first)
 *   dropScratch     `psql -d postgres -c 'DROP DATABASE IF EXISTS restow_restore WITH (FORCE)'`
 *   restoreDump     `pg_restore --no-owner --no-acl --exit-on-error -d restow_restore`, the dump
 *                   on standard input: the scratch database only, never the live one; a dump
 *                   carries no roles, and the grants come again from the role provisioning of
 *                   `restow restore prepare`
 *   restoreCli      `compose run --rm --no-deps -T --entrypoint restow api restore <action>`: the
 *                   application's own command line with the installation's .env (the updater
 *                   holds no database credential and no key itself)
 */

export interface RestoreCliResult {
  readonly exitCode: number;
  /** Standard output (the JSON of `--json`); never logged. */
  readonly stdout: string;
  readonly errorTail: string;
}

export interface RestoreOps {
  createScratch(): Promise<void>;
  dropScratch(): Promise<void>;
  restoreDump(file: string): Promise<void>;
  restoreCli(
    action: "prepare" | "activate" | "abort",
    args: readonly string[],
  ): Promise<RestoreCliResult>;
}

const MINUTE = 60_000;
const TIMEOUTS = { psql: 5 * MINUTE, restore: 12 * 60 * MINUTE, cli: 6 * 60 * MINUTE } as const;
/** What `--dump-name` and `--via` may carry. */
const ARGUMENT = /^[0-9A-Za-z._ -]{1,200}$/;

export interface CliRestoreOpsOptions {
  runner: CommandRunner;
  redactor: Redactor;
  projectName: string;
  composeFile: string | null;
  dumpsDir: string;
  postgres: () => Promise<PostgresSettings>;
}

export class CliRestoreOps implements RestoreOps {
  constructor(private readonly options: CliRestoreOpsOptions) {}

  async createScratch(): Promise<void> {
    await this.dropScratch();
    await this.psql(`CREATE DATABASE ${SCRATCH_DATABASE}`, "Creating the database for the restore");
  }

  async dropScratch(): Promise<void> {
    await this.psql(
      `DROP DATABASE IF EXISTS ${SCRATCH_DATABASE} WITH (FORCE)`,
      "Dropping the database of the restore",
    );
  }

  async restoreDump(file: string): Promise<void> {
    if (path.dirname(file) !== this.options.dumpsDir || !isDumpFileName(path.basename(file))) {
      throw new OpsError("The file is not a dump file of this updater.");
    }
    const { user } = await this.options.postgres();
    const result = await this.compose(
      [
        "exec",
        "-T",
        SERVICES.postgres,
        "pg_restore",
        "-U",
        user,
        "-d",
        SCRATCH_DATABASE,
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
      ],
      { timeoutMs: TIMEOUTS.restore, stdinFile: file },
    );
    this.expectSuccess(result, "Restoring the dump");
  }

  async restoreCli(
    action: "prepare" | "activate" | "abort",
    args: readonly string[],
  ): Promise<RestoreCliResult> {
    for (const argument of args) {
      if (!argument.startsWith("--") && !ARGUMENT.test(argument)) {
        throw new OpsError("An argument of the restore command is not valid.");
      }
    }
    const result = await this.compose(
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--entrypoint",
        "restow",
        SERVICES.api,
        "restore",
        action,
        ...args,
      ],
      { timeoutMs: TIMEOUTS.cli, maxOutputBytes: 8 * 1024 * 1024 },
    );
    return { exitCode: result.exitCode, stdout: result.stdout, errorTail: result.errorTail };
  }

  private async psql(statement: string, action: string): Promise<void> {
    const { user } = await this.options.postgres();
    const result = await this.compose(
      [
        "exec",
        "-T",
        SERVICES.postgres,
        "psql",
        "-U",
        user,
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-Atc",
        statement,
      ],
      { timeoutMs: TIMEOUTS.psql },
    );
    this.expectSuccess(result, action);
  }

  private compose(
    args: readonly string[],
    options: { timeoutMs: number; stdinFile?: string; maxOutputBytes?: number },
  ): Promise<CommandResult> {
    const base = ["compose", "-p", this.options.projectName];
    if (this.options.composeFile) {
      base.push("-f", this.options.composeFile);
    }
    return this.options.runner.run({ argv: ["docker", ...base, ...args], ...options });
  }

  private expectSuccess(result: CommandResult, action: string): void {
    if (result.exitCode === 0) {
      return;
    }
    throw new OpsError(
      result.timedOut ? `${action} timed out.` : `${action} failed (exit code ${result.exitCode}).`,
      this.options.redactor.oneLine(result.errorTail, 400),
    );
  }
}
