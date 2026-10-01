/**
 * Schema invariants that do not need a database:
 *   - every tenant-scoped table is covered by an RLS policy in sql/rls.sql,
 *   - the append-only tables keep their mutation guards,
 *   - the committed Drizzle migration snapshot matches the TypeScript schema
 *     (i.e. nobody changed the schema without regenerating a migration),
 *   - secret references point at the encrypted secret store and actor columns
 *     at the better-auth identity.
 * The tenant-A-never-sees-tenant-B behaviour itself is exercised against a
 * real Postgres in the integration stage (docs/TESTING.md).
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig, isPgEnum } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./index.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (relative: string) => readFileSync(`${packageRoot}${relative}`, "utf8");

const exported: unknown[] = Object.values(schema);
const tables = exported.filter((value): value is PgTable => is(value, PgTable));
const enumNames = exported.filter(isPgEnum).map((e) => e.enumName);

const tableConfigs = tables.map((table) => getTableConfig(table));
const tableNames = tableConfigs.map((t) => t.name);

const tenantScoped = tableConfigs
  .filter((t) => t.name !== "tenants" && t.columns.some((c) => c.name === "tenant_id"))
  .map((t) => t.name);

const rlsSql = read("sql/rls.sql");

/** The quoted names inside `tenant_tables text[] := ARRAY[ ... ]`. */
function rlsTenantTables(sql: string): string[] {
  const match = sql.match(/tenant_tables text\[\] := ARRAY\[([\s\S]*?)\];/);
  if (!match) {
    throw new Error("tenant_tables array not found in sql/rls.sql");
  }
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("row level security coverage", () => {
  it("lists every tenant-scoped table exactly once in sql/rls.sql", () => {
    const listed = rlsTenantTables(rlsSql);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...tenantScoped].sort());
  });

  it("isolates the tenants table on its own id", () => {
    expect(rlsSql).toMatch(/CREATE POLICY tenant_isolation_self ON tenants/);
    expect(tableNames).toContain("tenants");
  });

  it("keeps the append-only guards on the audit and archive chain tables", () => {
    for (const table of ["audit_log", "audit_anchor", "archive_items", "archive_anchor"]) {
      expect(tableNames).toContain(table);
      expect(rlsSql).toMatch(new RegExp(`CREATE TRIGGER ${table}_append_only`));
    }
  });
});

describe("migration snapshot is in sync with the schema", () => {
  const journal = JSON.parse(read("drizzle/meta/_journal.json")) as {
    entries: { idx: number; tag: string }[];
  };
  const migrationFiles = readdirSync(`${packageRoot}drizzle`).filter((f) => f.endsWith(".sql"));

  it("has one SQL file per journal entry, in order", () => {
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual([...migrationFiles].sort());
    journal.entries.forEach((entry, i) => expect(entry.idx).toBe(i));
  });

  const latest = journal.entries.at(-1);
  if (!latest) {
    throw new Error("migration journal is empty");
  }
  const snapshot = JSON.parse(
    read(`drizzle/meta/${String(latest.idx).padStart(4, "0")}_snapshot.json`),
  ) as {
    tables: Record<
      string,
      { name: string; columns: Record<string, { name: string; type: string }> }
    >;
    enums: Record<string, { name: string }>;
  };
  const snapshotTables = new Map(Object.values(snapshot.tables).map((t) => [t.name, t]));

  it("contains every table and column of the TypeScript schema", () => {
    for (const table of tableConfigs) {
      const snap = snapshotTables.get(table.name);
      expect(snap, `table ${table.name} missing from latest snapshot`).toBeDefined();
      const snapColumns = new Set(Object.values(snap?.columns ?? {}).map((c) => c.name));
      for (const column of table.columns) {
        expect(snapColumns.has(column.name), `${table.name}.${column.name} not migrated`).toBe(
          true,
        );
      }
      expect(snapColumns.size).toBe(table.columns.length);
    }
    expect(snapshotTables.size).toBe(tableConfigs.length);
  });

  it("contains every enum of the TypeScript schema", () => {
    const snapshotEnums = Object.values(snapshot.enums).map((e) => e.name);
    expect([...snapshotEnums].sort()).toEqual([...enumNames].sort());
  });

  it("records the actor columns as text (better-auth user ids)", () => {
    const expectText: [string, string][] = [
      ["audit_log", "actor_user_id"],
      ["restore_jobs", "actor_user_id"],
      ["legal_holds", "created_by"],
      ["api_keys", "created_by"],
    ];
    for (const [table, column] of expectText) {
      const snapColumn = Object.values(snapshotTables.get(table)?.columns ?? {}).find(
        (c) => c.name === column,
      );
      expect(snapColumn?.type, `${table}.${column}`).toBe("text");
    }
  });
});

describe("reference conventions", () => {
  const foreignTarget = (tableName: string, columnName: string): string | undefined => {
    const config = tableConfigs.find((t) => t.name === tableName);
    const fk = config?.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === columnName),
    );
    return fk ? getTableConfig(fk.reference().foreignTable).name : undefined;
  };

  it("points every secret_ref at the encrypted secret store", () => {
    const holders = tableConfigs.filter((t) => t.columns.some((c) => c.name === "secret_ref"));
    expect(holders.map((t) => t.name).sort()).toEqual([
      "protected_objects",
      "sources",
      "storage_targets",
      "webhooks",
    ]);
    for (const holder of holders) {
      expect(foreignTarget(holder.name, "secret_ref")).toBe("secrets");
    }
  });

  it("points actor columns of mutable tables at the better-auth user table", () => {
    expect(foreignTarget("restore_jobs", "actor_user_id")).toBe("user");
    expect(foreignTarget("legal_holds", "created_by")).toBe("user");
    expect(foreignTarget("api_keys", "created_by")).toBe("user");
  });

  it("keeps the append-only audit log free of actor foreign keys", () => {
    // Any ON DELETE action would be an UPDATE the append-only trigger rejects,
    // and the log must outlive the account anyway.
    expect(foreignTarget("audit_log", "actor_user_id")).toBeUndefined();
    const auditLog = tableConfigs.find((t) => t.name === "audit_log");
    expect(
      auditLog?.foreignKeys.map((f) => getTableConfig(f.reference().foreignTable).name),
    ).toEqual(["tenants"]);
  });

  it("links a tenant to its better-auth organization", () => {
    expect(foreignTarget("tenants", "organization_id")).toBe("organization");
  });

  it("gives every Restow table a uuid primary key and timestamptz created_at", () => {
    const authTables = new Set([
      "user",
      "session",
      "account",
      "verification",
      "passkey",
      "organization",
      "member",
      "invitation",
      "two_factor",
      "rate_limit",
    ]);
    for (const table of tableConfigs.filter((t) => !authTables.has(t.name))) {
      const id = table.columns.find((c) => c.name === "id");
      expect(id?.primary, `${table.name}.id`).toBe(true);
      expect(id?.getSQLType(), `${table.name}.id`).toBe("uuid");
      const createdAt = table.columns.find((c) => c.name === "created_at");
      expect(createdAt?.getSQLType(), `${table.name}.created_at`).toBe("timestamp with time zone");
    }
  });
});

describe("installation-level tables, identity and verification links", () => {
  const config = (name: string) => {
    const found = tableConfigs.find((t) => t.name === name);
    if (!found) {
      throw new Error(`table ${name} is not part of the schema`);
    }
    return found;
  };
  const column = (table: string, name: string) => {
    const found = config(table).columns.find((c) => c.name === name);
    if (!found) {
      throw new Error(`${table}.${name} is not part of the schema`);
    }
    return found;
  };
  const indexNamed = (table: string, name: string) =>
    config(table).indexes.find((i) => i.config.name === name)?.config;
  const indexColumns = (table: string, name: string) =>
    indexNamed(table, name)?.columns.map((c) => ("name" in c ? c.name : String(c)));

  it("keeps service heartbeats installation-level, one row per process", () => {
    const heartbeats = config("service_heartbeats");
    expect(heartbeats.columns.some((c) => c.name === "tenant_id")).toBe(false);
    expect(rlsTenantTables(rlsSql)).not.toContain("service_heartbeats");
    expect(indexNamed("service_heartbeats", "service_heartbeats_instance_uq")?.unique).toBe(true);
    expect(indexColumns("service_heartbeats", "service_heartbeats_instance_uq")).toEqual([
      "instance_id",
    ]);
    expect(schema.serviceRoleEnum.enumValues).toEqual(["api", "worker", "scheduler"]);
    for (const name of ["role", "instance_id", "version", "started_at", "beat_at", "details"]) {
      expect(column("service_heartbeats", name).notNull, name).toBe(true);
    }
    expect(column("service_heartbeats", "hostname").notNull).toBe(false);
    expect(heartbeats.checks.map((c) => c.name)).toContain(schema.SERVICE_HEARTBEAT_HOSTNAME_CHECK);
  });

  it("declares the better-auth rate-limit table with one counter per key", () => {
    expect(column("rate_limit", "key").isUnique).toBe(true);
    expect(column("rate_limit", "count").getSQLType()).toBe("integer");
    // Milliseconds since the epoch do not fit an integer.
    expect(column("rate_limit", "last_request").getSQLType()).toBe("bigint");
    expect(rlsTenantTables(rlsSql)).not.toContain("rate_limit");
  });

  it("stores a user's Entra identity in nullable columns, unique per tenant and object", () => {
    expect(column("user", "entra_object_id").notNull).toBe(false);
    expect(column("user", "entra_tenant_id").notNull).toBe(false);
    const unique = indexNamed("user", schema.USER_ENTRA_IDENTITY_UNIQUE_INDEX);
    expect(unique?.unique).toBe(true);
    expect(unique?.where).toBeDefined();
    expect(indexColumns("user", schema.USER_ENTRA_IDENTITY_UNIQUE_INDEX)).toEqual([
      "entra_tenant_id",
      "entra_object_id",
    ]);
  });

  it("links a verification report to the snapshot it checked", () => {
    const link = config("verify_reports").foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "snapshot_id"),
    );
    expect(link && getTableConfig(link.reference().foreignTable).name).toBe("snapshots");
    // Pruning a snapshot keeps the report; it only loses the link.
    expect(link?.onDelete).toBe("set null");
    expect(column("verify_reports", "snapshot_id").notNull).toBe(false);
    expect(indexColumns("verify_reports", "verify_reports_object_snapshot_idx")).toEqual([
      "protected_object_id",
      "snapshot_id",
    ]);
  });

  it("records when a tenant received the recommended schedules", () => {
    const applied = column("tenants", "schedule_defaults_applied_at");
    expect(applied.notNull).toBe(false);
    expect(applied.getSQLType()).toBe("timestamp with time zone");
  });

  it("backfills the snapshot link in the migration that adds it", () => {
    const migrations = readdirSync(`${packageRoot}drizzle`).filter((f) => f.endsWith(".sql"));
    const adding = migrations.filter((file) =>
      read(`drizzle/${file}`).includes(
        'ALTER TABLE "verify_reports" ADD COLUMN "snapshot_id" uuid;',
      ),
    );
    expect(adding).toHaveLength(1);
    const migration = read(`drizzle/${adding[0]}`);
    expect(migration).toMatch(/UPDATE "verify_reports" AS "report"\s+SET "snapshot_id"/);
    // The Row Level Security flag lifted for the backfill is restored in the same migration.
    for (const table of ["verify_reports", "snapshots"]) {
      expect(migration).toContain(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;`);
      expect(migration.trimEnd()).toMatch(
        new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;[\\s\\S]*$`),
      );
    }
  });
});

describe("per-mailbox IMAP credentials", () => {
  const config = (name: string) => {
    const found = tableConfigs.find((t) => t.name === name);
    if (!found) {
      throw new Error(`table ${name} is not part of the schema`);
    }
    return found;
  };
  const column = (table: string, name: string) => {
    const found = config(table).columns.find((c) => c.name === name);
    if (!found) {
      throw new Error(`${table}.${name} is not part of the schema`);
    }
    return found;
  };

  it("declares the credential_status enum with the untested/ok/failed states", () => {
    expect(schema.credentialStatusEnum.enumValues).toEqual(["untested", "ok", "failed"]);
  });

  it("keeps the per-mailbox credential columns nullable, so most objects use none", () => {
    for (const name of [
      "secret_ref",
      "credential_status",
      "credential_checked_at",
      "credential_error",
    ]) {
      expect(column("protected_objects", name).notNull, name).toBe(false);
    }
  });

  it("clears secret_ref, never the object, when its secret is deleted", () => {
    const fk = config("protected_objects").foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "secret_ref"),
    );
    expect(fk?.onDelete).toBe("set null");
    expect(fk && getTableConfig(fk.reference().foreignTable).name).toBe("secrets");
  });
});
