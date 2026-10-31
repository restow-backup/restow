/**
 * A confirmation as empty against Postgres (apps/api verify/empty.ts): a check that still finds
 * the object empty keeps it and raises no "needs attention"; the first check that finds content
 * deletes it in the transaction that records its report.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_worker_verify_empty_test` is recreated there on every run). Without it the suite is
 * skipped.
 */
import type { VerifyOutcome } from "@restow/core";
import {
  createDb,
  emptyConfirmations,
  jobs,
  notifications,
  protectedObjects,
  providers,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pgVerifyStore, VERIFY_EVENTS } from "./verify.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_verify_empty_test";

async function recreate(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

function outcome(snapshotId: string, checked: number, contentBytes: number): VerifyOutcome {
  const empty = checked === 0 && contentBytes === 0;
  const counts = { mail: 0, file: 0, event: 0, contact: 0, site: 0 };
  return {
    readiness: empty ? "yellow" : "green",
    checked,
    mismatched: 0,
    missing: 0,
    snapshotId,
    details: {
      format: 1,
      origin: "verify",
      kind: "verify",
      scope: "sample",
      seed: 1,
      quota: null,
      snapshot: {
        id: snapshotId,
        sequence: 1,
        completedAt: null,
        itemCount: 6,
        packCount: 1,
        contentBytes,
        contentObjects: contentBytes > 0 ? 1 : 0,
      },
      reasons: empty ? [{ code: "snapshot_empty", severity: "yellow", count: 6 }] : [],
      counts: {
        eligible: { ...counts, mail: checked },
        sampled: { ...counts, mail: checked },
        checked,
        bytesRead: contentBytes,
        verified: checked,
        mismatch: 0,
        missing: 0,
        unreadable: 0,
      },
      items: [],
      itemsOmitted: 0,
      damagedPacks: [],
      testRestore: null,
      startedAt: new Date().toISOString(),
      durationMs: 1,
    },
  };
}

describe.skipIf(!adminUrl)("a confirmation as empty in the worker", () => {
  it("survives a check that still finds the object empty and ends with one that finds content", async () => {
    const db = createDb(await recreate(adminUrl as string));
    try {
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      const [tenant] = await db
        .insert(tenants)
        .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
        .returning();
      const tenantId = tenant?.id as string;
      const [source] = await db
        .insert(sources)
        .values({ tenantId, kind: "m365", name: "M365", status: "active" })
        .returning();
      const [object] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "empty@contoso.example",
          displayName: "Empty",
        })
        .returning();
      const objectId = object?.id as string;
      const [snapshot] = await db
        .insert(snapshots)
        .values({ tenantId, protectedObjectId: objectId, sequence: 1 })
        .returning();
      const snapshotId = snapshot?.id as string;
      await db.insert(emptyConfirmations).values({
        tenantId,
        protectedObjectId: objectId,
        snapshotId,
        confirmedBy: "admin@contoso.example",
      });
      const JOBS = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
      await db.insert(jobs).values(
        JOBS.map((id) => ({
          id,
          tenantId,
          queue: "verify" as const,
          status: "active" as const,
          protectedObjectId: objectId,
        })),
      );
      const store = pgVerifyStore(db, tenantId);
      const ref = {
        id: objectId,
        tenantId,
        kind: "mailbox" as const,
        externalId: "empty@contoso.example",
        displayName: "Empty",
        sourceId: source?.id as string,
        userId: null,
      };
      const confirmations = () =>
        db
          .select({ id: emptyConfirmations.id })
          .from(emptyConfirmations)
          .where(eq(emptyConfirmations.protectedObjectId, objectId));
      const events = async () =>
        (
          await db
            .select({ event: notifications.event })
            .from(notifications)
            .where(eq(notifications.tenantId, tenantId))
        ).map((row) => row.event);

      // Still empty after a green check: kept, and no "needs attention" for the confirmed object.
      await store.record({
        tenantId,
        jobId: "00000000-0000-4000-8000-000000000001",
        object: ref,
        kind: "verify",
        outcome: outcome(snapshotId, 0, 0),
        previous: "green",
        checkedAt: new Date(),
      });
      expect(await confirmations()).toHaveLength(1);
      expect(await events()).not.toContain(VERIFY_EVENTS.yellow);

      // Content again: the confirmation ends with this report.
      await store.record({
        tenantId,
        jobId: "00000000-0000-4000-8000-000000000002",
        object: ref,
        kind: "verify",
        outcome: outcome(snapshotId, 1, 4096),
        previous: "yellow",
        checkedAt: new Date(),
      });
      expect(await confirmations()).toEqual([]);
    } finally {
      await db.$client.end();
    }
  }, 60_000);
});
