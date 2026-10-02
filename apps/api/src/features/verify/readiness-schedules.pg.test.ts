/**
 * What the readiness overview says about the schedules of a tenant when backups and restore checks
 * are jobs (release 0.2.0): a mail job speaks for them with its own timer and the timers of members
 * that have a schedule of their own; a schedule a job took over, a job that is switched off and a
 * machine job do not.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_readiness_schedules_test` is recreated there and dropped after).
 */
import { randomUUID } from "node:crypto";
import {
  type Database,
  backupJobMembers,
  backupJobs,
  createDb,
  protectedObjects,
  providers,
  schedules,
  sources,
  tenants,
} from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { readinessOverview } from "./service.js";

const DATABASE = "restow_api_readiness_schedules_test";
const NOW = new Date("2026-10-02T12:00:00.000Z");
const interval = { kind: "interval", intervalMinutes: 480, timeZone: "UTC" } as const;
const weekly = { kind: "cron", cron: "0 3 * * 0", timeZone: "UTC" } as const;

describe.skipIf(!testDatabaseAdminUrl)(
  "the readiness overview's schedules with backup jobs",
  () => {
    let db: Database;
    let providerId: string;

    beforeAll(async () => {
      db = createDb(await recreateDatabase(testDatabaseAdminUrl as string, DATABASE));
      const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
      providerId = provider?.id as string;
    }, 60_000);

    afterAll(async () => {
      await db?.$client.end();
      await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    });

    async function tenant(): Promise<string> {
      const [row] = await db
        .insert(tenants)
        .values({ providerId, name: "Contoso", slug: `t-${randomUUID().slice(0, 8)}` })
        .returning();
      return row?.id as string;
    }

    it("shows no schedule for a tenant without jobs and schedules", async () => {
      const id = await tenant();
      const overview = await readinessOverview(db, id, NOW);
      expect(overview.schedules).toEqual({ backup: null, verify: null, scrub: null });
    });

    it("speaks for backups and restore checks with the job's timers", async () => {
      const id = await tenant();
      await db.insert(backupJobs).values({
        tenantId: id,
        kind: "mail",
        name: "Mail backup",
        scopeMode: "all",
        schedule: interval,
        verifySchedule: weekly,
        nextRunAt: new Date("2026-10-02T18:00:00Z"),
        verifyNextRunAt: new Date("2026-10-04T03:00:00Z"),
      });
      const overview = await readinessOverview(db, id, NOW);
      expect(overview.schedules.backup).toEqual({ nextRunAt: "2026-10-02T18:00:00.000Z" });
      expect(overview.schedules.verify).toEqual({ nextRunAt: "2026-10-04T03:00:00.000Z" });
      expect(overview.schedules.scrub).toBeNull();
    });

    it("takes the earliest of the job's and its members' timers", async () => {
      const id = await tenant();
      const [source] = await db
        .insert(sources)
        .values({ tenantId: id, kind: "m365", name: "M365", status: "active" })
        .returning();
      const [object] = await db
        .insert(protectedObjects)
        .values({
          tenantId: id,
          sourceId: source?.id as string,
          kind: "mailbox",
          externalId: "anna@example.test",
        })
        .returning();
      const [job] = await db
        .insert(backupJobs)
        .values({
          tenantId: id,
          kind: "mail",
          name: "Selected",
          schedule: interval,
          nextRunAt: new Date("2026-10-02T18:00:00Z"),
        })
        .returning();
      await db.insert(backupJobMembers).values({
        tenantId: id,
        jobId: job?.id as string,
        protectedObjectId: object?.id as string,
        overrides: { schedule: { kind: "interval", intervalMinutes: 60, timeZone: "UTC" } },
        nextRunAt: new Date("2026-10-02T13:00:00Z"),
      });
      const overview = await readinessOverview(db, id, NOW);
      expect(overview.schedules.backup).toEqual({ nextRunAt: "2026-10-02T13:00:00.000Z" });
      expect(overview.schedules.verify).toBeNull();
    });

    it("ignores a job that is switched off, a machine job and a schedule a job took over", async () => {
      const id = await tenant();
      const [off] = await db
        .insert(backupJobs)
        .values({ tenantId: id, kind: "mail", name: "Off", schedule: interval, enabled: false })
        .returning();
      await db
        .insert(backupJobs)
        .values({ tenantId: id, kind: "endpoint", name: "Servers", schedule: interval });
      await db.insert(schedules).values({
        tenantId: id,
        kind: "backup",
        intervalMinutes: 480,
        timezone: "UTC",
        supersededByJobId: off?.id,
        nextRunAt: NOW,
      });
      const overview = await readinessOverview(db, id, NOW);
      expect(overview.schedules).toEqual({ backup: null, verify: null, scrub: null });
      // A schedule of an older release that stayed still counts.
      await db.insert(schedules).values({
        tenantId: id,
        kind: "backup",
        intervalMinutes: 120,
        timezone: "UTC",
        nextRunAt: NOW,
      });
      expect((await readinessOverview(db, id, NOW)).schedules.backup).toEqual({
        nextRunAt: NOW.toISOString(),
      });
    });
  },
);
