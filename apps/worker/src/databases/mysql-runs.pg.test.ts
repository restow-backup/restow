/**
 * Backups and restores of MySQL and MariaDB by the Restow server against real servers with TLS
 * (docs/DATABASES.md 5.3, 7.1, 16 "D4"): a schema with an InnoDB and a MyISAM table, a view, a
 * procedure, a function, a trigger and an event owned by another user is dumped through the relay
 * into restic, restored under a new name on the same connection and onto another connection whose
 * user may not set definers (the DEFINER filter), with the events switched off afterwards; a name
 * taken, a broken backup (only the run's own schema is dropped) and another certificate are
 * refused.
 *
 * Needs RESTOW_TEST_DATABASE_URL (Restow's PostgreSQL) and at least one of RESTOW_TEST_MYSQL_URL,
 * RESTOW_TEST_MYSQL80_URL, RESTOW_TEST_MARIADB_URL, RESTOW_TEST_MARIADB106_URL (a user with all
 * rights, `mysql://user:password@host:port`, TLS on); the programs of the family on PATH or in
 * /opt/mysql/bin; restic on PATH. Each server without its variable is skipped (the CI guard
 * requires all four, scripts/ci/assert-pg-suites.mjs).
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateDek,
  Keyring,
  LocalStorageBackend,
  mysqlQuoteIdent,
  openMysqlAdminSession,
  type PgAdminSession,
  probeDatabaseFromServer,
  resticDump,
  resticSnapshots,
  withRepository,
} from "@restow/core";
import { createDb, databaseBackups, databaseConnections, databaseRuns } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TenantCache } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import {
  type DatabaseRunDeps,
  ensureDatabaseRepository,
  insertDatabaseRun,
  runDatabaseJob,
} from "./runs.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

const SERVERS = [
  { env: "RESTOW_TEST_MYSQL_URL", engine: "mysql" as const },
  { env: "RESTOW_TEST_MYSQL80_URL", engine: "mysql" as const },
  { env: "RESTOW_TEST_MARIADB_URL", engine: "mariadb" as const },
  { env: "RESTOW_TEST_MARIADB106_URL", engine: "mariadb" as const },
].map((server) => ({ ...server, url: process.env[server.env] }));

const network = { allowPrivateNetworks: true, approvedAddresses: [], forbiddenTargets: [] };

describe.each(SERVERS)(
  "MySQL runs of the Restow server ($env) [DB-007]",
  ({ env, engine, url }) => {
    const enabled = Boolean(adminUrl && url);
    const parsed = url ? new URL(url) : null;
    const host = parsed?.hostname ?? "127.0.0.1";
    const port = Number(parsed?.port || 3306);
    const user = decodeURIComponent(parsed?.username ?? "");
    const password = decodeURIComponent(parsed?.password ?? "");
    const suffix = randomBytes(3).toString("hex");
    const SOURCE = `restow_d4_src_${suffix}`;
    const OWNER = `restow_d4_owner_${suffix}`;
    const RESTORER = `restow_d4_rest_${suffix}`;
    const RESTORER_PASSWORD = `pw-${randomBytes(8).toString("hex")}`;
    const TEST_DB = `restow_worker_mysqlruns_${env.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

    let db: ReturnType<typeof createDb>;
    let tenantId = "";
    let connectionId = "";
    let otherConnectionId = "";
    let fingerprint = "";
    let storageDir = "";
    let customer: PgAdminSession;
    const credentials: Record<string, { user: string; password: string }> = {};
    const now = new Date("2026-11-18T10:00:00.000Z");
    const keys = new Keyring("x", [generateDek(1)]);

    const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
      db.$client.query<T>(text, values).then((result) => result.rows);

    const deps = (): DatabaseRunDeps => ({
      db,
      providerDb: db,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => now,
      keyrings: new TenantCache(async () => keys),
      primaryStorage: async () => new LocalStorageBackend(storageDir),
      primaryWriteOnce: async () => false,
      privateNetworksAllowed: true,
      restoreModeActive: async () => false,
      readCredentials: async (_tenant, secretId) =>
        credentials[secretId] ?? { user: null, password: null },
      ownSystemIdentifier: async () => "6000000000000000001",
      ownDatabaseTargets: async () => [{ address: "10.9.9.9", port: 5432 }],
      enqueue: async () => undefined,
      dbStreamCommand: [
        process.execPath,
        fileURLToPath(new URL("./db-stream.ts", import.meta.url)),
      ],
    });

    const runOf = async (id: string) => {
      const [row] = await db.select().from(databaseRuns).where(eq(databaseRuns.id, id));
      return row as NonNullable<typeof row>;
    };

    const sql = async (statement: string) => customer.query(statement);

    const run = async (
      input:
        | { kind: "backup" }
        | { kind: "restore"; backupId: string; target: string; name: string },
    ) => {
      const inserted = await insertDatabaseRun(
        db,
        { id: connectionId, tenantId, executorKind: "server", executorEndpointId: null },
        input.kind === "backup"
          ? { kind: "backup", trigger: "manual" }
          : {
              kind: "restore",
              trigger: "manual",
              sourceBackupId: input.backupId,
              targetConnectionId: input.target,
              targetName: input.name,
            },
        now,
      );
      if (!inserted) throw new Error("no run");
      await runDatabaseJob(deps(), { tenantId, runId: inserted.id });
      const done = await runOf(inserted.id);
      if (process.env.RESTOW_TEST_DEBUG && done.status === "failed") {
        process.stderr.write(
          `run failed: ${done.errorCode} ${done.errorMessage} ${JSON.stringify(done.notes)}\n`,
        );
      }
      return done;
    };

    beforeAll(async () => {
      if (!enabled) return;
      const admin = createDb(adminUrl as string);
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
      await admin.$client.end();
      const target = new URL(adminUrl as string);
      target.pathname = `/${TEST_DB}`;
      await runMigrations(target.toString());
      db = createDb(target.toString());
      storageDir = await mkdtemp(join(tmpdir(), "restow-mysqlruns-"));
      const probe = await probeDatabaseFromServer(
        {
          probeId: "00000000-0000-4000-8000-000000000005",
          engine,
          host,
          port,
          path: null,
          database: null,
          authMethod: "password",
          user,
          password,
          allowUnencrypted: false,
          timeoutSeconds: 20,
        },
        network,
      );
      if (probe.error) throw new Error(`${probe.error.code}: ${probe.error.message}`);
      fingerprint = probe.tls.fingerprintSha256 ?? "";
      const opened = await openMysqlAdminSession(
        { host, port, allowUnencrypted: false, pinnedFingerprintSha256: fingerprint },
        engine,
        network,
        { user, password },
        null,
      );
      if (!opened.ok) throw new Error(opened.message);
      customer = opened.session;
      const at = (name: string) => `${mysqlQuoteIdent(name)}@'%'`;
      await sql(`CREATE USER ${at(OWNER)} IDENTIFIED BY 'owner-pw-${suffix}'`);
      await sql(`GRANT ALL ON *.* TO ${at(OWNER)}`);
      // A restoring user with the rights of 3.2 and nothing that lets it set another definer.
      await sql(`CREATE USER ${at(RESTORER)} IDENTIFIED BY '${RESTORER_PASSWORD}'`);
      await sql(
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, CREATE ROUTINE, ALTER ROUTINE, CREATE VIEW, SHOW VIEW, TRIGGER, EVENT, LOCK TABLES ON *.* TO ${at(RESTORER)}`,
      );
      const s = mysqlQuoteIdent(SOURCE);
      const owner = `${mysqlQuoteIdent(OWNER)}@'%'`;
      await sql(`CREATE DATABASE ${s} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      // The objects as an application writes them: inside the schema, without its name.
      const inside = await openMysqlAdminSession(
        { host, port, allowUnencrypted: false, pinnedFingerprintSha256: fingerprint },
        engine,
        network,
        { user, password },
        SOURCE,
      );
      if (!inside.ok) throw new Error(inside.message);
      const app = (statement: string) => inside.session.query(statement);
      try {
        await app(
          "CREATE TABLE orders (id INT PRIMARY KEY, item VARCHAR(40), blob_col VARBINARY(8)) ENGINE=InnoDB",
        );
        await app("INSERT INTO orders VALUES (1, 'tea', 0x00ff0a27), (2, 'cake''s\\\\ end', NULL)");
        await app("CREATE TABLE legacy (id INT) ENGINE=MyISAM");
        await app(`CREATE DEFINER=${owner} VIEW cheap AS SELECT id FROM orders`);
        await app(`CREATE DEFINER=${owner} PROCEDURE cleanup() BEGIN DELETE FROM legacy; END`);
        await app(`CREATE DEFINER=${owner} FUNCTION one() RETURNS INT DETERMINISTIC RETURN 1`);
        await app(
          `CREATE DEFINER=${owner} TRIGGER stamp BEFORE INSERT ON orders FOR EACH ROW SET NEW.item = NEW.item`,
        );
        await app(
          `CREATE DEFINER=${owner} EVENT nightly ON SCHEDULE EVERY 1 DAY DO DELETE FROM legacy`,
        );
      } finally {
        inside.session.close();
      }

      const [provider] = await q<{ id: string }>(
        "INSERT INTO providers (name) VALUES ('p') RETURNING id",
      );
      const [tenant] = await q<{ id: string }>(
        "INSERT INTO tenants (provider_id, name, slug, status) VALUES ($1, 'Contoso', 'contoso', 'active') RETURNING id",
        [provider?.id],
      );
      tenantId = tenant?.id ?? "";
      const secret = async (owner: { user: string; password: string }) => {
        const [row] = await q<{ id: string }>(
          `INSERT INTO secrets (tenant_id, kind, ciphertext, key_version)
         VALUES ($1, 'database_credentials', 'x', 1) RETURNING id`,
          [tenantId],
        );
        credentials[row?.id as string] = owner;
        return row?.id as string;
      };
      const add = async (name: string, login: { user: string; password: string }) => {
        const [row] = await q<{ id: string }>(
          `INSERT INTO database_connections
           (tenant_id, name, engine, host, port, executor_kind, auth_method, schedule, selection,
            tls_fingerprint, credential_secret_id)
         VALUES ($1, $2, $3, $4, $5, 'server', 'password', $6::jsonb, $7::jsonb, $8, $9)
         RETURNING id`,
          [
            tenantId,
            name,
            engine,
            host,
            port,
            JSON.stringify({ kind: "interval", intervalMinutes: 60, timeZone: "UTC" }),
            JSON.stringify({ mode: "selected", names: [SOURCE], exclude: [] }),
            fingerprint,
            await secret(login),
          ],
        );
        return row?.id as string;
      };
      connectionId = await add("ERP", { user, password });
      otherConnectionId = await add("Test instance", {
        user: RESTORER,
        password: RESTORER_PASSWORD,
      });
    }, 180_000);

    afterAll(async () => {
      if (!enabled) return;
      if (customer) {
        for (const [name] of await sql("SHOW DATABASES")) {
          if (name?.includes(`_${suffix}`) || name?.startsWith(SOURCE)) {
            await sql(`DROP DATABASE IF EXISTS ${mysqlQuoteIdent(name)}`);
          }
        }
        for (const account of [OWNER, RESTORER]) {
          await sql(`DROP USER IF EXISTS ${mysqlQuoteIdent(account)}@'%'`);
        }
        customer.close();
      }
      await db?.$client.end();
      if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
      if (storageDir) await rm(storageDir, { recursive: true, force: true });
    });

    it.skipIf(!enabled)(
      "dumps each schema through the relay with its objects, users and grants, and restores it under new names [DB-008]",
      async () => {
        const backup = await run({ kind: "backup" });
        if (backup.status !== "succeeded")
          throw new Error(JSON.stringify(backup.notes) + backup.errorMessage);
        expect(backup).toMatchObject({ status: "succeeded", errorCode: null });
        expect(backup.notes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "db_nontransactional_tables", tables: ["legacy"] }),
            expect.objectContaining({ globals: true, result: "backed_up" }),
          ]),
        );
        const rows = await db
          .select()
          .from(databaseBackups)
          .where(eq(databaseBackups.connectionId, connectionId));
        const dump = rows.find((row) => row.kind === "database");
        const users = rows.find((row) => row.kind === "globals");
        expect(dump).toMatchObject({
          databaseName: SOURCE,
          fileName: `${engine}/${SOURCE}.sql`,
          identity: null,
          engineOptions: { characterSet: "utf8mb4", collation: "utf8mb4_unicode_ci" },
        });
        expect(dump?.objects).toEqual({
          TABLE: 2,
          VIEW: 1,
          PROCEDURE: 1,
          FUNCTION: 1,
          TRIGGER: 1,
          EVENT: 1,
        });
        expect(users?.fileName).toBe(`${engine}/users.sql`);
        const [full] = await db
          .select()
          .from(databaseConnections)
          .where(eq(databaseConnections.id, connectionId));
        const access = await ensureDatabaseRepository(deps(), full as NonNullable<typeof full>);
        const snapshots = await withRepository(access, (session) => resticSnapshots(session));
        expect(snapshots).toHaveLength(2);
        for (const snapshot of snapshots) {
          expect(snapshot.tags).toContain(`restow-db-run=${backup.id}`);
          expect(snapshot.tags).toContain(`restow-db-engine=${engine}`);
        }
        // The users and grants as text: MySQL's binary password hashes as hex.
        const usersText = await withRepository(access, async (session) => {
          const read = resticDump(session, users?.snapshotId as string, `/${users?.fileName}`);
          const chunks: Buffer[] = [];
          read.stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          await read.done;
          return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        });
        expect(usersText).toContain(OWNER);
        if (engine === "mysql") {
          expect(usersText).toContain(" AS 0x");
        }

        // Same connection, new name: data byte for byte, the event switched off, the marker gone.
        const copy = `${SOURCE}_copy`;
        const same = await run({
          kind: "restore",
          backupId: dump?.id as string,
          target: connectionId,
          name: copy,
        });
        expect(same).toMatchObject({ status: "succeeded" });
        expect(same.notes).toEqual([
          expect.objectContaining({ result: "restored", eventsDisabled: 1 }),
        ]);
        const c = mysqlQuoteIdent(copy);
        expect(await sql(`SELECT id, item, HEX(blob_col) FROM ${c}.orders ORDER BY id`)).toEqual([
          ["1", "tea", "00FF0A27"],
          ["2", "cake's\\ end", null],
        ]);
        expect(await sql(`SELECT ${c}.one()`)).toEqual([["1"]]);
        const [event] = await sql(`SHOW EVENTS FROM ${c}`);
        expect(String(event?.[10])).toMatch(/DISABLED/);
        expect((await sql(`SHOW TABLES FROM ${c}`)).map((row) => row[0]).sort()).toEqual([
          "cheap",
          "legacy",
          "orders",
        ]);
        const [charset] = await sql(
          `SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${copy}'`,
        );
        expect(charset?.[0]).toBe("utf8mb4_unicode_ci");

        // Another connection whose user may not set definers: the filter makes it the owner.
        const elsewhere = `${SOURCE}_other`;
        // With the binary log on, a user without SUPER may create triggers and routines only
        // while log_bin_trust_function_creators is on: refused as a missing right first, and
        // only the run's own schema is dropped.
        const [[logBin, trusted]] = (await sql(
          "SELECT @@log_bin, @@log_bin_trust_function_creators",
        )) as [[string, string]];
        if (logBin === "1" && trusted === "0") {
          const refused = await run({
            kind: "restore",
            backupId: dump?.id as string,
            target: otherConnectionId,
            name: elsewhere,
          });
          expect(refused).toMatchObject({ status: "failed", errorCode: "db_permission_missing" });
          expect((await sql("SHOW DATABASES")).map((row) => row[0])).not.toContain(elsewhere);
          await sql("SET GLOBAL log_bin_trust_function_creators = 1");
        }
        const other = await run({
          kind: "restore",
          backupId: dump?.id as string,
          target: otherConnectionId,
          name: elsewhere,
        });
        expect(other).toMatchObject({ status: "succeeded" });
        expect(other.notes[0]?.definersRemoved).toBeGreaterThanOrEqual(4);
        expect(await sql(`SELECT COUNT(*) FROM ${mysqlQuoteIdent(elsewhere)}.orders`)).toEqual([
          ["2"],
        ]);
        if (logBin === "1" && trusted === "0") {
          await sql("SET GLOBAL log_bin_trust_function_creators = 0");
        }

        // A name taken: refused, the existing schema untouched.
        const taken = await run({
          kind: "restore",
          backupId: dump?.id as string,
          target: connectionId,
          name: SOURCE,
        });
        expect(taken).toMatchObject({ status: "failed", errorCode: "db_restore_name_taken" });
        expect(await sql(`SELECT COUNT(*) FROM ${mysqlQuoteIdent(SOURCE)}.orders`)).toEqual([
          ["2"],
        ]);

        // A backup whose content differs from its record: the run's own schema (marker) goes.
        await q("UPDATE database_backups SET sha256 = repeat('0', 64) WHERE id = $1", [dump?.id]);
        const broken = `${SOURCE}_br\\'k`;
        const failed = await run({
          kind: "restore",
          backupId: dump?.id as string,
          target: connectionId,
          name: broken,
        });
        expect(failed).toMatchObject({ status: "failed", errorCode: "db_backup_mismatch" });
        expect((await sql("SHOW DATABASES")).map((row) => row[0])).not.toContain(broken);
        await q("UPDATE database_backups SET sha256 = $1 WHERE id = $2", [dump?.sha256, dump?.id]);
      },
      300_000,
    );

    it.skipIf(!enabled)(
      "refuses another certificate before anything is sent [DB-003]",
      async () => {
        const other = `${fingerprint.slice(0, -2)}00`;
        await q("UPDATE database_connections SET tls_fingerprint = $1 WHERE id = $2", [
          other,
          connectionId,
        ]);
        try {
          const refused = await run({ kind: "backup" });
          expect(refused).toMatchObject({ status: "failed", errorCode: "db_tls_changed" });
        } finally {
          await q("UPDATE database_connections SET tls_fingerprint = $1 WHERE id = $2", [
            fingerprint,
            connectionId,
          ]);
        }
      },
      120_000,
    );
  },
);
