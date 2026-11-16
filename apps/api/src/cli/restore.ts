import type { Database } from "@restow/db";
import type { RestoreCommand } from "./restore-args.js";

/**
 * `restow restore prepare|activate|abort` and `restow node check` (main.ts parses the arguments):
 *
 *   restore prepare   on the scratch database a dump was restored into (features/setup-restore):
 *                     migrate, restore mode on, check the master key and the storage; prints the
 *                     report (JSON with --json). Exit 0 ok, 3 wrong master key, 4 dump refused,
 *                     1 error. The updater and install.sh run it with
 *                     `docker compose run --rm --no-deps --entrypoint restow api restore prepare`.
 *   restore activate  the prepared scratch database becomes the live database (the fresh one is
 *                     kept as `<db>_before_restore_<time>`); api, worker and scheduler stopped.
 *   restore abort     drop the scratch database (a refused or aborted restore).
 *   node check        on a worker node: TLS to the database, the roles, the schema version, the
 *                     master key and every storage target; exit 0 when all is well.
 *
 * Nothing secret is printed.
 */

export interface RestoreIo {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. Run this in the api container of the installation.`);
  }
  return value;
}

export async function runRestoreCommand(
  command: RestoreCommand,
  io: RestoreIo,
  env: Env = process.env,
): Promise<number> {
  if (command.kind === "node-check") {
    return runNodeCheck(command.json, io);
  }
  if (command.kind === "cluster-override") {
    const { applyDatabaseOverride } = await import("./cluster-override.js");
    await applyDatabaseOverride(command.file, command.exposure);
    io.out(
      command.exposure
        ? `PostgreSQL is published on ${command.exposure.bind}:${command.exposure.port} with TLS (${command.file}).\n`
        : `PostgreSQL is no longer published (${command.file}).\n`,
    );
    return 0;
  }
  const {
    activateRestoredDatabase,
    ActivationRefusedError,
    databaseOf,
    dropScratchDatabase,
    ownerUrlFor,
  } = await import("../features/setup-restore/activate.js");
  const ownerUrl = required(env, "DATABASE_MIGRATION_URL");
  if (command.database === databaseOf(ownerUrl)) {
    io.err(
      `${command.database} is the live database of this installation; a restore is prepared in a database of its own.\n`,
    );
    return 1;
  }
  if (command.kind === "restore-abort") {
    await dropScratchDatabase(ownerUrl, command.database);
    io.out(
      `The database ${command.database} was dropped (if it existed). The live database is unchanged.\n`,
    );
    return 0;
  }
  if (command.kind === "restore-activate") {
    try {
      const result = await activateRestoredDatabase({ ownerUrl, scratch: command.database });
      if (command.json) {
        io.out(`${JSON.stringify(result)}\n`);
      } else if (result.status === "already_active") {
        io.out("The restored database is live already.\n");
      } else {
        io.out(
          `The restored database is live now, with restore mode on.${result.previous ? ` The fresh database was kept as ${result.previous}.` : ""}\n`,
        );
      }
      return 0;
    } catch (error) {
      if (error instanceof ActivationRefusedError) {
        io.err(`${error.message}\n`);
        return 4;
      }
      throw error;
    }
  }
  const { kekFromBase64 } = await import("@restow/core");
  const { authLoginFromEnvironment, roleLoginFromUrl } = await import("@restow/db");
  const { prepareRestoredDatabase } = await import("../features/setup-restore/prepare.js");
  const { formatReport, PREPARE_EXIT } = await import("../features/setup-restore/report.js");
  let kek: Buffer;
  try {
    kek = kekFromBase64(required(env, "RESTOW_MASTER_KEY"));
  } catch {
    io.err("RESTOW_MASTER_KEY must be 32 bytes, base64-encoded.\n");
    return PREPARE_EXIT.error;
  }
  const report = await prepareRestoredDatabase({
    ownerUrl: ownerUrlFor(ownerUrl, command.database),
    roles: {
      tenant: roleLoginFromUrl(required(env, "DATABASE_URL"), "DATABASE_URL"),
      installation: roleLoginFromUrl(
        required(env, "DATABASE_PROVIDER_URL"),
        "DATABASE_PROVIDER_URL",
      ),
      auth: authLoginFromEnvironment(env),
    },
    kek,
    dumpName: command.dumpName,
    via: command.via,
  });
  io.out(command.json ? `${JSON.stringify(report)}\n` : formatReport(report));
  if (report.ok) {
    return PREPARE_EXIT.ok;
  }
  return report.refusal?.code === "master_key_mismatch"
    ? PREPARE_EXIT.masterKey
    : PREPARE_EXIT.refused;
}

interface NodeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : "unknown error";
}

/** Everything a worker node needs before it starts. */
export async function nodeChecks(db: Database, providerDb: Database): Promise<NodeCheck[]> {
  const checks: NodeCheck[] = [];
  const { assertDatabaseRoles, nodeIdentity } = await import("@restow/db");
  const { appliedMigrationCount, shippedMigrationCount } = await import("@restow/db/migrate");
  const run = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, detail: message(error) });
    }
  };
  await run("tls", async () => {
    const { rows } = await providerDb.$client.query<{ ssl: boolean; version: string | null }>(
      "SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    );
    if (rows[0]?.ssl !== true) {
      throw new Error("the connection to the database is not encrypted (set sslmode=verify-full)");
    }
    return `encrypted (${rows[0].version ?? "TLS"})`;
  });
  await run("roles", async () => {
    const roles = await assertDatabaseRoles({
      tenant: db.$client,
      installation: providerDb.$client,
    });
    return `${roles.tenant.name} and ${roles.installation.name}`;
  });
  await run("schema", async () => {
    const applied = await appliedMigrationCount(providerDb.$client);
    const shipped = shippedMigrationCount();
    if (applied !== shipped) {
      throw new Error(
        `the database has ${applied ?? "no"} migrations, this release ${shipped}: install the release of the main host on this node`,
      );
    }
    return `${applied} migrations, as in this release`;
  });
  await run("node", async () => {
    const { nodeId, nodeName } = nodeIdentity();
    if (!nodeId) {
      throw new Error("RESTOW_NODE_ID is not set: this host did not join with install.sh --join");
    }
    const { rows } = await providerDb.$client.query<{ status: string }>(
      "SELECT status FROM cluster_nodes WHERE id = $1::uuid",
      [nodeId],
    );
    if (rows[0]?.status !== "active") {
      throw new Error(
        "this node is not an active node of the installation (removed, or another installation)",
      );
    }
    return `${nodeName ?? nodeId} is an active node`;
  });
  await run("master_key", async () => {
    const { keyProvider } = await import("../lib/secrets.js");
    const { rows } = await providerDb.$client.query<{ encrypted_dek: string }>(
      "SELECT encrypted_dek FROM tenant_keys ORDER BY created_at LIMIT 1",
    );
    if (!rows[0]) {
      return "no tenant key to check yet";
    }
    try {
      await keyProvider().unwrapDek(Buffer.from(rows[0].encrypted_dek, "base64"));
    } catch {
      throw new Error("RESTOW_MASTER_KEY does not open the tenant keys of this installation");
    }
    return "opens the tenant keys";
  });
  await run("storage", async () => {
    const { tenantStorageTargets } = await import("../features/restore-mode/guard.js");
    const { rows } = await providerDb.$client.query<{ id: string }>(
      "SELECT id::text AS id FROM tenants ORDER BY created_at",
    );
    const failed: string[] = [];
    let targets = 0;
    for (const { id } of rows) {
      const { targets: own, previous } = await tenantStorageTargets(providerDb, id);
      for (const target of [...own, ...previous]) {
        targets += 1;
        try {
          await target.backend.list(`tenants/${id}/keys/`);
        } catch (error) {
          failed.push(`${id}/${target.id}: ${message(error)}`);
        }
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `${failed.length} of ${targets} storage target(s) cannot be read: ${failed.slice(0, 5).join("; ")}`,
      );
    }
    return `${targets} storage target(s) of ${rows.length} tenant(s) can be read`;
  });
  return checks;
}

async function runNodeCheck(json: boolean, io: RestoreIo): Promise<number> {
  const { db, providerDb, authDb } = await import("../db.js");
  try {
    const checks = await nodeChecks(db, providerDb);
    const ok = checks.every((check) => check.ok);
    if (json) {
      io.out(`${JSON.stringify({ ok, checks })}\n`);
    } else {
      for (const check of checks) {
        io.out(`${check.ok ? "ok  " : "FAIL"} ${check.name.padEnd(10)} ${check.detail}\n`);
      }
    }
    return ok ? 0 : 1;
  } finally {
    await Promise.allSettled([db.$client.end(), providerDb.$client.end(), authDb.$client.end()]);
  }
}
