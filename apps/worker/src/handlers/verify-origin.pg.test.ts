/**
 * Which restore check follows a backup (`verifyBackupJobId`, `verifyScheduleId`), against Postgres:
 * the mail job an object belongs to decides (its own override first, else the job's), an "all" job
 * covers an object that is in no job, a switched-off job or one without restore checks asks for
 * none, and a schedule a job took over no longer counts (while one that stayed does).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_worker_verify_origin_test` is recreated there on every run). Without it the suite is
 * skipped.
 */
import { Keyring, generateDek } from "@restow/core";
import {
  backupJobMembers,
  backupJobs,
  createDb,
  protectedObjects,
  providers,
  schedules,
  sources,
  tenants,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { pgBackupStore } from "./backup.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_verify_origin_test";

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

const WEEKLY = { kind: "cron", cron: "0 3 * * 0", timeZone: "Europe/Berlin" } as const;
const DAILY = { kind: "cron", cron: "0 3 * * *", timeZone: "Europe/Berlin" } as const;

describe.skipIf(!adminUrl)("what asks for a restore check after a backup", () => {
  it("follows the job of the object, then the job over all objects, then the schedules that remain", async () => {
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
      const make = async (name: string) => {
        const [row] = await db
          .insert(protectedObjects)
          .values({
            tenantId,
            sourceId: source?.id as string,
            kind: "mailbox",
            externalId: `${name}@contoso.example`,
          })
          .returning();
        return row?.id as string;
      };
      const checked = await make("checked");
      const plain = await make("plain");
      const own = await make("own");
      const off = await make("off");
      const loose = await make("loose");
      const [withChecks] = await db
        .insert(backupJobs)
        .values({ tenantId, kind: "mail", name: "With checks", verifySchedule: WEEKLY })
        .returning();
      const [withoutChecks] = await db
        .insert(backupJobs)
        .values({ tenantId, kind: "mail", name: "Without checks" })
        .returning();
      const [paused] = await db
        .insert(backupJobs)
        .values({ tenantId, kind: "mail", name: "Paused", verifySchedule: WEEKLY, enabled: false })
        .returning();
      await db.insert(backupJobMembers).values([
        { tenantId, jobId: withChecks?.id as string, protectedObjectId: checked },
        { tenantId, jobId: withoutChecks?.id as string, protectedObjectId: plain },
        {
          tenantId,
          jobId: withoutChecks?.id as string,
          protectedObjectId: own,
          overrides: { verifySchedule: DAILY },
        },
        { tenantId, jobId: paused?.id as string, protectedObjectId: off },
      ]);
      const store = pgBackupStore(
        (fn) => db.transaction((tx) => fn(tx)),
        tenantId,
        new Keyring(tenantId, [generateDek(1)]),
      );

      expect(await store.verifyBackupJobId(checked)).toBe(withChecks?.id);
      expect(await store.verifyBackupJobId(plain)).toBeNull();
      // An override of its own asks for a check although its job has none.
      expect(await store.verifyBackupJobId(own)).toBe(withoutChecks?.id);
      expect(await store.verifyBackupJobId(off)).toBeNull();
      // In no job at all, and no job over all objects.
      expect(await store.verifyBackupJobId(loose)).toBeNull();

      // A job over all objects covers the object that is in no job.
      const [everything] = await db
        .insert(backupJobs)
        .values({
          tenantId,
          kind: "mail",
          name: "Everything",
          scopeMode: "all",
          verifySchedule: WEEKLY,
        })
        .returning();
      expect(await store.verifyBackupJobId(loose)).toBe(everything?.id);
      // ... but not the one that belongs to another job.
      expect(await store.verifyBackupJobId(plain)).toBeNull();
      await db
        .update(backupJobs)
        .set({ enabled: false })
        .where(eq(backupJobs.id, everything?.id as string));
      expect(await store.verifyBackupJobId(loose)).toBeNull();

      // The schedules of an older release: one a job took over no longer asks, one that stayed does.
      const [taken] = await db
        .insert(schedules)
        .values({
          tenantId,
          kind: "verify",
          cron: "0 3 * * 0",
          timezone: "Europe/Berlin",
          supersededByJobId: withChecks?.id,
        })
        .returning();
      expect(await store.verifyScheduleId(loose)).toBeNull();
      const [stayed] = await db
        .insert(schedules)
        .values({ tenantId, kind: "verify", cron: "0 4 * * 0", timezone: "Europe/Berlin" })
        .returning();
      expect(await store.verifyScheduleId(loose)).toBe(stayed?.id);
      expect(taken?.id).not.toBe(stayed?.id);
    } finally {
      await db.$client.end();
    }
  }, 60_000);
});
