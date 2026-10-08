/**
 * Daily archive anchors against Postgres: completed days only, the
 * cumulative count and the last chain hash of each day, idempotency and
 * catch-up. The comparison of a chain against these anchors is tested with
 * the archive check (apps/api/src/features/archive/archive.pg.test.ts).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
 * named `restow_worker_archive_anchor_test` is recreated there and dropped after).
 */
import { archive } from "@restow/core";
import {
  type Database,
  archiveAnchor,
  archiveItems,
  createDb,
  providers,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { asc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import { anchorArchiveChain, writeArchiveAnchors } from "./archive-anchor.js";
import type { AnchorLogger } from "./audit-anchor.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_archive_anchor_test";

async function withAdmin(base: string, statement: string): Promise<void> {
  const admin = createDb(base);
  try {
    await admin.$client.query(statement);
  } finally {
    await admin.$client.end();
  }
}

const logger: AnchorLogger = { info: () => {}, error: () => {} };

describe.skipIf(!adminUrl)("archive anchor run (Postgres)", () => {
  let db: Database;
  let tenantId: string;
  const hashes: string[] = [];

  beforeAll(async () => {
    await withAdmin(adminUrl as string, `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await withAdmin(adminUrl as string, `CREATE DATABASE ${TEST_DB}`);
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";

    let prev: string | null = null;
    const times = [
      "2026-09-20T08:00:00.000Z",
      "2026-09-20T23:59:59.999Z",
      "2026-09-22T10:00:00.000Z",
      "2026-09-23T10:00:00.000Z",
    ];
    for (const [index, at] of times.entries()) {
      const receivedAt = new Date(at);
      const itemHash = `hash-${index}`;
      const chainHash = archive.computeArchiveChainHash(prev, itemHash, receivedAt);
      await db.insert(archiveItems).values({
        tenantId,
        messageId: `msg-${index}`,
        itemHash,
        prevChainHash: prev,
        chainHash,
        receivedAt,
        capturedVia: "journal",
        storagePath: `tenants/${tenantId}/archive/${index}`,
        createdAt: receivedAt,
      });
      hashes.push(chainHash);
      prev = chainHash;
    }
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  const anchors = () =>
    db
      .select({
        date: archiveAnchor.anchorDate,
        lastHash: archiveAnchor.lastHash,
        count: archiveAnchor.count,
      })
      .from(archiveAnchor)
      .orderBy(asc(archiveAnchor.anchorDate));

  it("seals completed days with the chain's length and last hash at the end of each day", async () => {
    const summary = await writeArchiveAnchors({
      db,
      logger,
      now: () => new Date("2026-09-23T12:00:00.000Z"),
    });
    expect(summary).toEqual({ tenants: 1, anchorsWritten: 2, failedTenants: 0 });
    expect(await anchors()).toEqual([
      { date: "2026-09-20", lastHash: hashes[1], count: 2 },
      { date: "2026-09-22", lastHash: hashes[2], count: 3 },
    ]);
  });

  it("is idempotent and catches up on the days since the last anchor", async () => {
    expect(await anchorArchiveChain(db, tenantId, new Date("2026-09-23T00:00:00.000Z"))).toEqual(
      [],
    );
    const later = await anchorArchiveChain(db, tenantId, new Date("2026-09-25T00:00:00.000Z"));
    expect(later).toEqual([{ tenantId, anchorDate: "2026-09-23", lastHash: hashes[3], count: 4 }]);
  });
});
