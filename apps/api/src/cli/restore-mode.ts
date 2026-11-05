import { hostname } from "node:os";
import type { Database } from "@restow/db";
import { readRestoreMode } from "@restow/db";
import { createApiRestoreModeGuard } from "../features/restore-mode/guard.js";
import {
  checkRestoreMode,
  END_CONFIRMATION,
  endRestoreModeConfirmed,
  importRestoreModeKeys,
  providerOwnerByEmail,
  restoreModeView,
  startRestoreMode,
} from "../features/restore-mode/service.js";
import type { RestoreModeCommand } from "./restore-mode-args.js";

/**
 * `restow restore-mode ...` (main.ts): restore mode after restoring a database dump
 * (docs/STORAGE.md, "Restore mode and progress markers"; docs/UPDATING.md, "Rollback"). The
 * same service functions as the Restore mode page, on the installation pool. It needs only
 * postgres (and, for `check`, `import-keys` and `off`, the storage): run it before the worker and
 * the scheduler start:
 *
 *   docker compose run --rm --no-deps --entrypoint restow api restore-mode on --reason "..."
 */

export interface RestoreModeIo {
  readonly confirm: (question: string) => Promise<boolean>;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Typed confirmation for `off` (a line read from the terminal). */
  readonly ask?: (question: string) => Promise<string>;
}

function actor(label: string, extra: { userId?: string; email?: string } = {}) {
  return { label, host: hostname(), ...extra };
}

async function askLine(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  if (!process.stdin.isTTY) {
    throw new Error("No terminal to confirm on. Pass --yes to run without confirmation.");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

export async function runRestoreModeCommand(
  command: RestoreModeCommand,
  db: Database,
  io: RestoreModeIo,
): Promise<number> {
  const guard = createApiRestoreModeGuard(db, (level, message, fields) => {
    if (level !== "info") {
      io.err(`${level}: ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`);
    }
  });
  switch (command.kind) {
    case "restore-mode-status": {
      const view = await restoreModeView(db);
      if (command.json) {
        io.out(`${JSON.stringify(view, null, 2)}\n`);
        return 0;
      }
      if (view.active) {
        io.out(
          `Restore mode is ON since ${view.active.activatedAt} (${view.active.source}${
            view.active.reason ? `: ${view.active.reason}` : ""
          }).\nNothing is deleted; jobs from before ${view.active.holdJobsBefore} are held.\n`,
        );
      } else {
        io.out("Restore mode is off.\n");
      }
      for (const target of view.targets) {
        io.out(
          `  ${target.tenantName ?? target.tenantId}  ${target.targetId}  ${target.outcome}  storage ${
            target.storageMaxSeq ?? "-"
          }  database ${target.dbSeq}${
            target.unknownKeyVersions.length > 0
              ? `  key versions not in the database: ${target.unknownKeyVersions.join(", ")}`
              : ""
          }\n`,
        );
      }
      if (view.heldJobs.held + view.heldJobs.waiting > 0) {
        io.out(`Held jobs: ${view.heldJobs.held} held, ${view.heldJobs.waiting} still queued.\n`);
      }
      return 0;
    }
    case "restore-mode-on": {
      const state = await readRestoreMode(db.$client);
      if (state.active) {
        io.out(`Restore mode is on already (since ${state.activatedAt?.toISOString()}).\n`);
        return 0;
      }
      if (!command.yes) {
        const agreed = await io.confirm(
          "Switch restore mode on? Nothing is deleted until a provider owner ends it. [y/N] ",
        );
        if (!agreed) {
          io.out("Nothing was changed.\n");
          return 1;
        }
      }
      const started = await startRestoreMode(db, {
        source: "cli",
        reason: command.reason,
        actor: actor(`cli@${hostname()}`),
      });
      io.out(
        started.created
          ? "Restore mode is on. Start the installation now (docker compose up -d), then check and end restore mode under Installation > Restore mode.\n"
          : "Restore mode is on already.\n",
      );
      return 0;
    }
    case "restore-mode-check": {
      const checks = await checkRestoreMode(db, guard);
      for (const check of checks) {
        for (const target of check.targets) {
          io.out(
            `${check.tenantId}  ${target.targetId}  ${target.outcome}  storage ${
              target.storageMaxSeq ?? "-"
            }  database ${target.dbSeq}${target.detail ? `  (${target.detail})` : ""}\n`,
          );
        }
      }
      const ahead = checks.some((check) => check.outcome === "ahead");
      const state = await readRestoreMode(db.$client);
      io.out(
        state.active
          ? "Restore mode is on.\n"
          : ahead
            ? "A storage target is ahead of the database.\n"
            : "Restore mode is off.\n",
      );
      return 0;
    }
    case "restore-mode-import-keys": {
      if (!command.yes) {
        const agreed = await io.confirm(
          "Take the key versions found in storage that the database lacks into the database? [y/N] ",
        );
        if (!agreed) {
          io.out("Nothing was changed.\n");
          return 1;
        }
      }
      const result = await importRestoreModeKeys(db, {
        actor: actor(`cli@${hostname()}`),
        ...(command.tenantId ? { tenantId: command.tenantId } : {}),
      });
      for (const key of result.imported) {
        io.out(`imported  ${key.tenantId}  version ${key.keyVersion}\n`);
      }
      for (const key of result.refused) {
        io.out(`refused   ${key.tenantId}  version ${key.keyVersion}  ${key.reason}\n`);
      }
      if (result.imported.length + result.refused.length === 0) {
        io.out("No key version in storage is missing from the database.\n");
      }
      return result.refused.length > 0 ? 1 : 0;
    }
    case "restore-mode-off": {
      const owner = await providerOwnerByEmail(db, command.email);
      if (!command.yes) {
        const typed = await (io.ask ?? askLine)(
          `Type "end restore mode" to end restore mode as ${owner.email}: `,
        );
        if (typed.trim() !== "end restore mode") {
          io.out("Nothing was changed.\n");
          return 1;
        }
      }
      const result = await endRestoreModeConfirmed(db, guard, {
        checked: command.checked,
        confirmation: END_CONFIRMATION,
        storageOnlyData: command.storageOnlyData,
        acceptUnreachable: command.acceptUnreachable,
        actor: actor(`cli:${owner.email}@${hostname()}`, { userId: owner.id, email: owner.email }),
      });
      io.out(
        `Restore mode ended. Progress values lifted for ${result.rebase.length} tenant(s)${
          result.acceptedUnreachable.length > 0
            ? `; accepted as unreachable: ${result.acceptedUnreachable.join(", ")}`
            : ""
        }.\n`,
      );
      return 0;
    }
  }
}
