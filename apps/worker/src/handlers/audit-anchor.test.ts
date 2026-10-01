/**
 * Daily audit anchors: the pure day and chain-head helpers, and (against
 * Postgres) the nightly run itself: completed days only, a tie at the end of
 * a day, idempotency, catch-up after downtime and append-only anchors.
 *
 * The Postgres section runs when RESTOW_TEST_DATABASE_URL points at a
 * Postgres server (a database named `restow_worker_anchor_test` is recreated
 * there and dropped after). Without it that section is skipped; the chain
 * verification against these anchors is covered by the API suite
 * (apps/api/src/features/audit/audit.pg.test.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { type Database, auditAnchor, auditLog, createDb, providers, tenants } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { asc, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import {
  type AnchorLogger,
  anchorChain,
  anchorLockKey,
  chainHeadOf,
  dayAfter,
  startOfUtcDay,
  writeAuditAnchors,
} from "./audit-anchor.js";

describe("audit anchor helpers", () => {
  it("finds the UTC day of an instant, whatever its offset", () => {
    expect(startOfUtcDay(new Date("2026-09-22T23:59:59.999Z")).toISOString()).toBe(
      "2026-09-22T00:00:00.000Z",
    );
    expect(startOfUtcDay(new Date("2026-09-23T00:30:00+02:00")).toISOString()).toBe(
      "2026-09-22T00:00:00.000Z",
    );
  });

  it("steps to the next day across month and year ends", () => {
    expect(dayAfter("2026-09-30").toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(dayAfter("2026-12-31").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("picks the entry no other entry links to as the chain head", () => {
    expect(chainHeadOf([])).toBeNull();
    expect(chainHeadOf([{ prevHash: "a", chainHash: "b" }])).toBe("b");
    // Same timestamp, listed by id against insertion order.
    expect(
      chainHeadOf([
        { prevHash: "b", chainHash: "c" },
        { prevHash: "a", chainHash: "b" },
      ]),
    ).toBe("c");
  });

  it("keeps one advisory lock per chain", () => {
    expect(anchorLockKey(null)).toBe("restow.audit-anchor:provider");
    expect(anchorLockKey("t-1")).toBe("restow.audit-anchor:t-1");
    expect(anchorLockKey("t-1")).not.toBe(anchorLockKey("t-2"));
  });
});

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_anchor_test";

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

async function recreateTestDatabase(base: string): Promise<string> {
  await withAdmin(base, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await withAdmin(base, `CREATE DATABASE ${TEST_DB}`);
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

/** A stand-in chain hash: the anchor run records hashes, it does not recompute them. */
function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ChainEntry {
  readonly at: string;
  readonly id?: string;
}

/** Append linked entries to one chain; returns their chain hashes in order. */
async function appendChain(
  db: Database,
  tenantId: string | null,
  entries: readonly ChainEntry[],
): Promise<string[]> {
  const hashes: string[] = [];
  let prevHash: string | null = null;
  for (const [index, entry] of entries.entries()) {
    const chainHash = hashOf(`${tenantId ?? "provider"}:${index}`);
    await db.insert(auditLog).values({
      id: entry.id ?? randomUUID(),
      tenantId,
      actor: "system",
      action: "job.retried",
      target: `target-${index}`,
      prevHash,
      chainHash,
      createdAt: new Date(entry.at),
    });
    hashes.push(chainHash);
    prevHash = chainHash;
  }
  return hashes;
}

function recordingLogger(): AnchorLogger & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}

describe.skipIf(!adminUrl)("audit anchor run (Postgres)", () => {
  let db: Database;
  let tenantId: string;
  let providerHashes: string[];
  let tenantHashes: string[];

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider.id,
        name: "Contoso",
        slug: `contoso-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant.id;

    providerHashes = await appendChain(db, null, [
      { at: "2026-09-20T07:00:00.000Z" },
      { at: "2026-09-22T07:00:00.000Z" },
    ]);
    tenantHashes = await appendChain(db, tenantId, [
      { at: "2026-09-20T08:00:00.000Z" },
      { at: "2026-09-20T23:59:59.999Z" },
      // A tie at the end of the day, ids sorting against insertion order.
      { at: "2026-09-21T23:00:00.000Z", id: "99999999-0000-4000-8000-000000000000" },
      { at: "2026-09-21T23:00:00.000Z", id: "11111111-0000-4000-8000-000000000000" },
      { at: "2026-09-22T00:00:00.000Z" },
      { at: "2026-09-23T10:00:00.000Z" },
    ]);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  async function anchors() {
    return db
      .select({
        tenantId: auditAnchor.tenantId,
        anchorDate: auditAnchor.anchorDate,
        lastHash: auditAnchor.lastHash,
        count: auditAnchor.count,
      })
      .from(auditAnchor)
      .orderBy(asc(auditAnchor.anchorDate), asc(auditAnchor.tenantId));
  }

  it("seals completed days only, with the head of a tied run and the day's count", async () => {
    const logger = recordingLogger();
    const summary = await writeAuditAnchors({
      db,
      logger,
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    });
    expect(summary).toEqual({ chains: 2, anchorsWritten: 3, failedChains: 0 });

    const rows = await anchors();
    expect(rows).toHaveLength(3);
    const provider20 = rows.find((row) => row.tenantId === null);
    expect(provider20).toMatchObject({ anchorDate: "2026-09-20", count: 1 });
    expect(provider20?.lastHash).toBe(providerHashes[0]);

    const tenantRows = rows.filter((row) => row.tenantId === tenantId);
    expect(tenantRows.map((row) => [row.anchorDate, row.count])).toEqual([
      ["2026-09-20", 2],
      ["2026-09-21", 2],
    ]);
    expect(tenantRows[0]?.lastHash).toBe(tenantHashes[1]);
    // The later entry of the tie is the head, although its id sorts first.
    expect(tenantRows[1]?.lastHash).toBe(tenantHashes[3]);
    expect(logger.lines.filter((line) => line === "audit chain anchored")).toHaveLength(3);
  });

  it("is idempotent within a day", async () => {
    const summary = await writeAuditAnchors({
      db,
      logger: recordingLogger(),
      now: () => new Date("2026-09-22T18:00:00.000Z"),
    });
    expect(summary.anchorsWritten).toBe(0);
    expect(await anchors()).toHaveLength(3);
  });

  it("catches up on every day missed while the worker was down", async () => {
    const summary = await writeAuditAnchors({
      db,
      logger: recordingLogger(),
      now: () => new Date("2026-09-24T00:10:00.000Z"),
    });
    // 2026-09-22 for both chains, 2026-09-23 for the tenant.
    expect(summary).toEqual({ chains: 2, anchorsWritten: 3, failedChains: 0 });

    const rows = await anchors();
    expect(rows.filter((row) => row.tenantId === tenantId).map((row) => row.anchorDate)).toEqual([
      "2026-09-20",
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
    ]);
    expect(rows.find((row) => row.anchorDate === "2026-09-23")?.lastHash).toBe(tenantHashes[5]);
    expect(await anchorChain(db, tenantId, new Date("2026-09-24T00:00:00.000Z"))).toEqual([]);
  });

  it("keeps anchors append-only", async () => {
    // Drizzle wraps the driver error; the trigger's message is on `cause`.
    await expect(db.execute(sql`DELETE FROM audit_anchor`)).rejects.toHaveProperty(
      "cause.message",
      expect.stringMatching(/append-only/),
    );
  });
});
