import { randomUUID } from "node:crypto";
import type { AuditLogEntry, Database, NewAuditLogEntry } from "@restow/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type AuditPayload,
  actorLabel,
  audit,
  auditPayload,
  canonicalJson,
  chainLockKey,
  computeChainHash,
  nextCreatedAt,
  verifyAuditChain,
} from "./audit.js";

const TENANT = "0f1e2d3c-4b5a-4978-8899-aabbccddeeff";
const dialect = new PgDialect();

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined members", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } });
    const b = canonicalJson({ a: { d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("keeps null and array order, renders dates as ISO strings", () => {
    expect(canonicalJson({ n: null, list: [2, 1] })).toBe('{"list":[2,1],"n":null}');
    expect(canonicalJson(new Date("2026-01-02T03:04:05.000Z"))).toBe('"2026-01-02T03:04:05.000Z"');
  });
});

describe("auditPayload / actorLabel", () => {
  it("defaults the actor label and normalizes optional fields to null", () => {
    expect(actorLabel({})).toBe("system");
    expect(actorLabel({ actorUserId: "u1" })).toBe("user:u1");
    expect(actorLabel({ actor: "ops@example.com", actorUserId: "u1" })).toBe("ops@example.com");
    expect(auditPayload({ action: "x" })).toEqual({
      tenantId: null,
      actor: "system",
      actorUserId: null,
      action: "x",
      target: null,
      targetType: null,
      onBehalfOf: null,
      ip: null,
      details: null,
    });
  });

  it("stores empty details as null and canonicalizes the rest", () => {
    expect(auditPayload({ action: "x", details: {} }).details).toBeNull();
    expect(auditPayload({ action: "x", details: { b: 1, a: new Date(0) } }).details).toEqual({
      a: "1970-01-01T00:00:00.000Z",
      b: 1,
    });
  });
});

function entry(
  prevHash: string | null,
  overrides: Partial<AuditPayload> = {},
  createdAt = new Date("2026-03-01T10:00:00.000Z"),
): AuditLogEntry {
  const payload: AuditPayload = {
    tenantId: TENANT,
    actor: "ops@example.com",
    actorUserId: "user-1",
    action: "restore.started",
    target: "snapshot-1",
    targetType: "snapshot",
    onBehalfOf: null,
    ip: "203.0.113.7",
    details: { items: 3 },
    ...overrides,
  };
  return {
    id: randomUUID(),
    ...payload,
    prevHash,
    chainHash: computeChainHash(prevHash, payload, createdAt),
    createdAt,
  };
}

describe("computeChainHash / verifyAuditChain", () => {
  it("is deterministic and sensitive to every input", () => {
    const payload = auditPayload({ action: "a", tenantId: TENANT });
    const at = new Date("2026-03-01T10:00:00.000Z");
    expect(computeChainHash(null, payload, at)).toBe(computeChainHash(null, payload, at));
    expect(computeChainHash(null, payload, at)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeChainHash("prev", payload, at)).not.toBe(computeChainHash(null, payload, at));
    expect(computeChainHash(null, { ...payload, action: "b" }, at)).not.toBe(
      computeChainHash(null, payload, at),
    );
    expect(computeChainHash(null, payload, new Date(at.getTime() + 1))).not.toBe(
      computeChainHash(null, payload, at),
    );
  });

  it("verifies an intact chain", () => {
    const first = entry(null);
    const second = entry(first.chainHash, { action: "restore.completed" });
    const third = entry(second.chainHash, { action: "export" });
    expect(verifyAuditChain([first, second, third])).toEqual({
      ok: true,
      checked: 3,
      brokenAt: null,
    });
    expect(verifyAuditChain([])).toEqual({ ok: true, checked: 0, brokenAt: null });
  });

  it("detects a rewritten field, a broken link and a wrong genesis", () => {
    const first = entry(null);
    const second = entry(first.chainHash);
    const tampered: AuditLogEntry = { ...second, target: "snapshot-9" };
    expect(verifyAuditChain([first, tampered])).toEqual({ ok: false, checked: 2, brokenAt: 1 });

    const unlinked = entry("0".repeat(64));
    expect(verifyAuditChain([first, unlinked])).toEqual({ ok: false, checked: 2, brokenAt: 1 });

    expect(verifyAuditChain([second])).toEqual({ ok: false, checked: 1, brokenAt: 0 });
  });

  it("reproduces the hash from a row that came back from jsonb with different key order", () => {
    const original = entry(null, { details: { zeta: 1, alpha: { b: 2, a: 1 } } });
    const reordered: AuditLogEntry = { ...original, details: { alpha: { a: 1, b: 2 }, zeta: 1 } };
    expect(verifyAuditChain([reordered]).ok).toBe(true);
  });
});

describe("chainLockKey", () => {
  it("separates tenant chains from the installation chain", () => {
    expect(chainLockKey(null)).toBe("restow.audit:provider");
    expect(chainLockKey(TENANT)).toBe(`restow.audit:${TENANT}`);
  });
});

/**
 * A minimal in-memory stand-in for the Drizzle executor covering exactly the
 * calls `audit()` makes: transaction, execute, select().from().where().orderBy()
 * .limit() and insert().values().returning().
 */
function fakeDatabase() {
  const rows: AuditLogEntry[] = [];
  const executed: { sql: string; params: unknown[] }[] = [];
  const whereClauses: string[] = [];

  interface FakeTx {
    rollback(): void;
    execute(statement: SQL): Promise<void>;
    transaction<T>(fn: (t: FakeTx) => Promise<T>): Promise<T>;
    select(): unknown;
    insert(): unknown;
  }

  const tx: FakeTx = {
    rollback() {},
    async execute(statement: SQL) {
      const query = dialect.sqlToQuery(statement);
      executed.push({ sql: query.sql, params: query.params });
    },
    transaction<T>(fn: (t: FakeTx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
    select() {
      return {
        from: () => ({
          where: (condition: SQL) => {
            const rendered = dialect.sqlToQuery(condition);
            whereClauses.push(rendered.sql);
            const scoped = rows.filter((row) =>
              rendered.params.length === 0
                ? row.tenantId === null
                : row.tenantId === rendered.params[0],
            );
            return {
              orderBy: () => ({
                limit: async () => {
                  const last = scoped.at(-1);
                  return last ? [{ chainHash: last.chainHash }] : [];
                },
              }),
            };
          },
        }),
      };
    },
    insert() {
      return {
        values: (row: NewAuditLogEntry) => ({
          returning: async () => {
            const stored: AuditLogEntry = {
              id: randomUUID(),
              tenantId: row.tenantId ?? null,
              actor: row.actor,
              actorUserId: row.actorUserId ?? null,
              action: row.action,
              target: row.target ?? null,
              targetType: row.targetType ?? null,
              onBehalfOf: row.onBehalfOf ?? null,
              ip: row.ip ?? null,
              details: row.details ?? null,
              prevHash: row.prevHash ?? null,
              chainHash: row.chainHash,
              createdAt: row.createdAt ?? new Date(),
            };
            rows.push(stored);
            return [stored];
          },
        }),
      };
    },
  };
  const db = {
    transaction<T>(fn: (t: FakeTx) => Promise<T>): Promise<T> {
      return fn(tx);
    },
  };
  return { db: db as unknown as Database, tx, rows, executed, whereClauses };
}

describe("audit", () => {
  it("links consecutive tenant entries and pins the tenant plus the chain lock", async () => {
    const fake = fakeDatabase();
    const first = await audit(fake.db, {
      tenantId: TENANT,
      action: "tenant.created",
      actor: "ops",
    });
    const second = await audit(fake.db, {
      tenantId: TENANT,
      action: "restore.started",
      actor: "ops",
    });

    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.chainHash);
    expect(verifyAuditChain(fake.rows)).toEqual({ ok: true, checked: 2, brokenAt: null });

    const statements = fake.executed.map((e) => e.sql);
    expect(statements[0]).toBe("select set_config('app.tenant_id', $1, true)");
    expect(fake.executed[0]?.params).toEqual([TENANT]);
    expect(statements[1]).toBe("select pg_advisory_xact_lock(hashtext($1))");
    expect(fake.executed[1]?.params).toEqual([chainLockKey(TENANT)]);
    expect(fake.whereClauses[0]).toContain("tenant_id");
  });

  it("keeps the installation chain separate from tenant chains", async () => {
    const fake = fakeDatabase();
    const tenantEntry = await audit(fake.db, { tenantId: TENANT, action: "a" });
    const providerEntry = await audit(fake.db, { action: "setup.completed", actorUserId: "u1" });

    expect(providerEntry.prevHash).toBeNull();
    expect(providerEntry.tenantId).toBeNull();
    expect(providerEntry.actor).toBe("user:u1");
    expect(providerEntry.actorUserId).toBe("u1");
    expect(tenantEntry.chainHash).not.toBe(providerEntry.chainHash);
    expect(fake.whereClauses[1]).toContain("is null");
    // No tenant pin for the installation chain, only the lock.
    expect(fake.executed.filter((e) => e.sql.startsWith("select set_config"))).toHaveLength(1);
  });

  it("joins an open transaction instead of opening its own tenant transaction", async () => {
    const fake = fakeDatabase();
    const inserted = await audit(fake.tx as unknown as Database, {
      tenantId: TENANT,
      action: "x",
      details: { reason: "test" },
    });
    expect(inserted.details).toEqual({ reason: "test" });
    expect(fake.executed.map((e) => e.sql)).toEqual(["select pg_advisory_xact_lock(hashtext($1))"]);
  });
});

describe("nextCreatedAt", () => {
  const last = new Date("2026-09-23T08:00:00.000Z");

  it("uses the current time for the first entry and when time moved on", () => {
    const now = new Date("2026-09-23T08:00:00.005Z");
    expect(nextCreatedAt(null, now)).toBe(now);
    expect(nextCreatedAt(last, now)).toBe(now);
  });

  it("stays strictly after the predecessor within the same millisecond", () => {
    expect(nextCreatedAt(last, new Date(last.getTime())).toISOString()).toBe(
      "2026-09-23T08:00:00.001Z",
    );
  });

  it("stays strictly after the predecessor when the clock stepped back", () => {
    const earlier = new Date("2026-09-23T07:59:59.000Z");
    expect(nextCreatedAt(last, earlier).getTime()).toBe(last.getTime() + 1);
  });
});
