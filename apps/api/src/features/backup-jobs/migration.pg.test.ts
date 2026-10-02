/**
 * The migration of an older installation to backup jobs, against Postgres and realistic
 * fixtures: several tenants with the recommended schedules, per-object schedules, disabled and
 * duplicate schedules, machines with different paths, schedules and systems, a revoked machine
 * and tenants with nothing to carry over.
 *
 * What it proves (the reviewer's checklist):
 *   - the number of jobs, members and overrides per tenant;
 *   - nothing is lost: every machine is in exactly one job and the job with its override gives
 *     back the very configuration it had (and nothing was rewritten: `config_version` and the
 *     configuration are untouched); every schedule that ran before is either carried by the
 *     job with the same cadence or still running as it was; nothing was deleted;
 *   - a second run (and a run for a tenant that was moved already) changes nothing at all;
 *   - the scheduler no longer plans a replaced schedule, the timers are carried over;
 *   - the system writes an audit entry per tenant and one for the installation.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser; the database
 * and the roles are created and dropped. Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  buildEndpointConfig,
  defaultEndpointConfig,
  effectiveSchedule,
  effectiveSettings,
  sameEndpointConfig,
} from "@restow/core";
import {
  type Database,
  auditLog,
  backupJobMembers,
  backupJobs,
  createDb,
  endpoints,
  protectedObjects,
  providers,
  schedules,
  sources,
  tenants,
} from "@restow/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_backup_jobs_migration_test";
const ZONE = "Europe/Berlin";
const NOW = new Date("2026-10-02T12:00:00.000Z");

describe.skipIf(!testDatabaseAdminUrl)("migration to backup jobs against Postgres", () => {
  let owner: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let migrate: typeof import("./migration.js");

  const tenantIds: Record<string, string> = {};
  const objectIds: Record<string, string> = {};
  const machineIds: Record<string, string> = {};
  const scheduleIds: Record<string, string> = {};
  const machineConfigs = new Map<string, { config: unknown; configVersion: number }>();
  let created = 0;

  async function makeTenant(key: string, language: "de" | "en" | null = "en") {
    const [provider] = await owner.select().from(providers).limit(1);
    const [row] = await owner
      .insert(tenants)
      .values({
        providerId: provider?.id ?? "",
        name: key,
        slug: key.toLowerCase(),
        language,
        createdAt: new Date(NOW.getTime() - 100_000_000 + created++ * 1000),
      })
      .returning();
    tenantIds[key] = row?.id ?? "";
    return row?.id ?? "";
  }

  async function makeObjects(tenant: string, key: string, names: string[]) {
    const [source] = await owner
      .insert(sources)
      .values({ tenantId: tenant, kind: "m365", name: `${key} M365`, status: "active" })
      .returning();
    for (const name of names) {
      const [row] = await owner
        .insert(protectedObjects)
        .values({
          tenantId: tenant,
          sourceId: source?.id ?? "",
          kind: "mailbox",
          externalId: `${name}@${key.toLowerCase()}.example`,
          displayName: name,
        })
        .returning();
      objectIds[`${key}/${name}`] = row?.id ?? "";
    }
  }

  async function schedule(
    key: string,
    tenant: string,
    values: {
      kind: "backup" | "verify" | "retention" | "scrub" | "directory";
      intervalMinutes?: number;
      cron?: string;
      object?: string;
      enabled?: boolean;
      nextRunAt?: Date | null;
      lastRunAt?: Date | null;
    },
  ) {
    const [row] = await owner
      .insert(schedules)
      .values({
        tenantId: tenant,
        kind: values.kind,
        protectedObjectId: values.object ? objectIds[values.object] : null,
        intervalMinutes: values.intervalMinutes ?? null,
        cron: values.cron ?? null,
        timezone: ZONE,
        enabled: values.enabled ?? true,
        nextRunAt:
          values.nextRunAt === undefined ? new Date("2026-10-02T14:00:00Z") : values.nextRunAt,
        lastRunAt:
          values.lastRunAt === undefined ? new Date("2026-10-02T06:00:00Z") : values.lastRunAt,
        createdAt: new Date(NOW.getTime() - 50_000_000 + created++ * 1000),
      })
      .returning();
    scheduleIds[key] = row?.id ?? "";
  }

  async function machine(
    key: string,
    tenant: string,
    values: {
      os?: "linux" | "darwin";
      profile?: "server" | "client";
      config?: Partial<ReturnType<typeof defaultEndpointConfig>>;
      status?: "active" | "revoked";
      retention?: { keepDaily: number; keepWeekly: number; keepMonthly: number };
    } = {},
  ) {
    const os = values.os ?? "linux";
    const profile = values.profile ?? "server";
    const config = {
      ...defaultEndpointConfig(os, profile, { timeZone: ZONE }),
      ...values.config,
    };
    const [row] = await owner
      .insert(endpoints)
      .values({
        tenantId: tenant,
        hostname: key,
        os,
        arch: "amd64",
        profile,
        status: values.status ?? "active",
        secretHash: randomBytes(8).toString("hex"),
        config,
        configVersion: 3,
        settings: values.retention ? { retention: values.retention } : {},
        createdAt: new Date(NOW.getTime() - 60_000_000 + created++ * 1000),
      })
      .returning();
    machineIds[key] = row?.id ?? "";
    machineConfigs.set(key, { config, configVersion: 3 });
  }

  /** Everything the second run must leave exactly as it is. */
  async function snapshotOfDatabase() {
    return {
      jobs: await owner.select().from(backupJobs).orderBy(asc(backupJobs.id)),
      members: await owner.select().from(backupJobMembers).orderBy(asc(backupJobMembers.id)),
      schedules: await owner.select().from(schedules).orderBy(asc(schedules.id)),
      endpoints: await owner
        .select({ id: endpoints.id, config: endpoints.config, version: endpoints.configVersion })
        .from(endpoints)
        .orderBy(asc(endpoints.id)),
      tenants: await owner
        .select({ id: tenants.id, at: tenants.backupJobsMigratedAt })
        .from(tenants)
        .orderBy(asc(tenants.id)),
      audit: (await owner.select({ id: auditLog.id }).from(auditLog)).length,
    };
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    providerDb = createDb(roles.providerUrl);
    migrate = await import("./migration.js");
    await owner.insert(providers).values({ name: "Provider" });

    // Contoso: the recommended set, an object with schedules of its own, three servers (one with
    // another folder and a bandwidth limit), a server on another schedule, a client, a revoked server.
    const contoso = await makeTenant("Contoso", "en");
    await makeObjects(contoso, "Contoso", ["anna", "ben", "clara"]);
    await schedule("contoso.backup", contoso, { kind: "backup", intervalMinutes: 480 });
    await schedule("contoso.verify", contoso, { kind: "verify", cron: "0 3 * * 0" });
    await schedule("contoso.ceo", contoso, {
      kind: "backup",
      object: "Contoso/anna",
      intervalMinutes: 60,
      nextRunAt: new Date("2026-10-02T12:30:00Z"),
    });
    await schedule("contoso.verify.ben", contoso, {
      kind: "verify",
      object: "Contoso/ben",
      cron: "0 3 * * *",
    });
    await schedule("contoso.weekly.clara", contoso, {
      kind: "backup",
      object: "Contoso/clara",
      cron: "0 3 * * 0",
    });
    await schedule("contoso.retention", contoso, { kind: "retention", cron: "30 4 * * *" });
    await schedule("contoso.scrub", contoso, { kind: "scrub", cron: "0 4 * * 6" });
    await schedule("contoso.directory", contoso, { kind: "directory", intervalMinutes: 360 });
    await machine("web01", contoso);
    await machine("web02", contoso);
    await machine("files01", contoso, {
      config: { paths: ["/srv", "/data/projects"], bandwidthKbps: 5000, excludes: ["*.iso"] },
      retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
    });
    await machine("db01", contoso, {
      config: { schedule: { kind: "daily", timeOfDay: "02:00", timeZone: ZONE } },
    });
    await machine("laptop01", contoso, { os: "darwin", profile: "client" });
    await machine("old01", contoso, { status: "revoked" });

    // Fabrikam: German tenant, only schedules for single objects; no machines.
    const fabrikam = await makeTenant("Fabrikam", "de");
    await makeObjects(fabrikam, "Fabrikam", ["dora", "emil", "fritz"]);
    await schedule("fabrikam.dora", fabrikam, {
      kind: "backup",
      object: "Fabrikam/dora",
      intervalMinutes: 480,
      nextRunAt: new Date("2026-10-02T13:00:00Z"),
    });
    await schedule("fabrikam.emil", fabrikam, {
      kind: "backup",
      object: "Fabrikam/emil",
      intervalMinutes: 480,
      nextRunAt: new Date("2026-10-02T15:00:00Z"),
    });
    await schedule("fabrikam.fritz", fabrikam, {
      kind: "backup",
      object: "Fabrikam/fritz",
      cron: "0 2 * * *",
    });

    // Globex: backups switched off, restore checks on.
    const globex = await makeTenant("Globex");
    await makeObjects(globex, "Globex", ["gina"]);
    await schedule("globex.backup", globex, {
      kind: "backup",
      intervalMinutes: 480,
      enabled: false,
    });
    await schedule("globex.verify", globex, { kind: "verify", cron: "0 3 * * 0" });

    // Initech: two tenant-wide backup schedules that differ, and a duplicate of the first.
    const initech = await makeTenant("Initech");
    await makeObjects(initech, "Initech", ["ivan"]);
    await schedule("initech.first", initech, { kind: "backup", intervalMinutes: 480 });
    await schedule("initech.twin", initech, { kind: "backup", intervalMinutes: 480 });
    await schedule("initech.night", initech, { kind: "backup", cron: "0 2 * * *" });

    // Hooli: a single machine, no schedules. Umbrella: nothing at all.
    const hooli = await makeTenant("Hooli");
    await machine("solo01", hooli, { config: { paths: ["/home"], excludes: [] } });
    await makeTenant("Umbrella");

    // A tenant moved before: its schedules must stay exactly as they are.
    const done = await makeTenant("Done");
    await makeObjects(done, "Done", ["dan"]);
    await schedule("done.backup", done, { kind: "backup", intervalMinutes: 480 });
    await owner.update(tenants).set({ backupJobsMigratedAt: NOW }).where(eq(tenants.id, done));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await providerDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  const jobsOf = (tenant: string, kind?: "mail" | "endpoint") =>
    owner
      .select()
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.tenantId, tenantIds[tenant] ?? ""),
          kind ? eq(backupJobs.kind, kind) : undefined,
        ),
      )
      .orderBy(asc(backupJobs.name));

  const membersOf = (jobId: string) =>
    owner.select().from(backupJobMembers).where(eq(backupJobMembers.jobId, jobId));

  const scheduleRow = async (key: string) => {
    const [row] = await owner
      .select()
      .from(schedules)
      .where(eq(schedules.id, scheduleIds[key] ?? ""));
    return row;
  };

  let summary: Awaited<ReturnType<typeof migrate.migrateToBackupJobs>>;
  let before: Awaited<ReturnType<typeof snapshotOfDatabase>>;

  it("runs once over every tenant that was not moved yet and reports the totals", async () => {
    before = await snapshotOfDatabase();
    summary = await migrate.migrateToBackupJobs(providerDb, { now: NOW });
    expect(summary).not.toBeNull();
    // Done was moved before and is not looked at; Umbrella and Hooli are (nothing / one machine).
    expect(summary).toMatchObject({ tenants: 6, failed: 0 });
    // Mail jobs: Contoso, Fabrikam, Globex, Initech. Machine jobs: Contoso's three groups and
    // Hooli's one.
    expect(summary?.mailJobs).toBe(4);
    expect(summary?.endpointJobs).toBe(4);
    expect(summary?.schedulesLeft).toBe(2);
    expect(summary?.tenantsWithJobs).toBe(5);
    expect(summary?.machinesReconfigured).toBe(0);
  });

  it("turns the recommended schedules of Contoso into one job over every mailbox", async () => {
    const mail = await jobsOf("Contoso", "mail");
    expect(mail).toHaveLength(1);
    const job = mail[0];
    expect(job).toMatchObject({
      name: "Mail backup",
      scopeMode: "all",
      enabled: true,
      origin: "migration",
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: ZONE },
      verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: ZONE },
    });
    // The timers carry over: nothing runs early or is skipped by the switch.
    const backup = await scheduleRow("contoso.backup");
    expect(job?.nextRunAt?.toISOString()).toBe(backup?.nextRunAt?.toISOString());
    expect(job?.lastRunAt?.toISOString()).toBe(backup?.lastRunAt?.toISOString());
    const members = await membersOf(job?.id ?? "");
    const byObject = new Map(members.map((member) => [member.protectedObjectId, member]));
    // Anna runs hourly, Ben has a daily restore check: overrides with their own timers.
    expect(byObject.get(objectIds["Contoso/anna"] ?? "")?.overrides).toEqual({
      schedule: { kind: "interval", intervalMinutes: 60, timeZone: ZONE },
    });
    expect(byObject.get(objectIds["Contoso/anna"] ?? "")?.nextRunAt?.toISOString()).toBe(
      "2026-10-02T12:30:00.000Z",
    );
    expect(byObject.get(objectIds["Contoso/ben"] ?? "")?.overrides).toEqual({
      verifySchedule: { kind: "cron", cron: "0 3 * * *", timeZone: ZONE },
    });
    // Clara's weekly backup is less often than the job's: it keeps running as it was.
    expect(byObject.has(objectIds["Contoso/clara"] ?? "")).toBe(false);
    expect((await scheduleRow("contoso.weekly.clara"))?.supersededByJobId).toBeNull();
    expect(members).toHaveLength(2);
  });

  it("marks the schedules a job took over and leaves every other schedule as it was", async () => {
    const [job] = await jobsOf("Contoso", "mail");
    for (const key of ["contoso.backup", "contoso.verify", "contoso.ceo", "contoso.verify.ben"]) {
      expect((await scheduleRow(key))?.supersededByJobId, key).toBe(job?.id);
    }
    // Maintenance is not a job's business.
    for (const key of ["contoso.retention", "contoso.scrub", "contoso.directory"]) {
      expect((await scheduleRow(key))?.supersededByJobId, key).toBeNull();
    }
    // Nothing was deleted, and nothing about a schedule but the marker changed.
    const after = await owner.select().from(schedules).orderBy(asc(schedules.id));
    expect(after).toHaveLength(before.schedules.length);
    for (const row of after) {
      const old = before.schedules.find((candidate) => candidate.id === row.id);
      expect({ ...row, supersededByJobId: null, updatedAt: null }).toEqual({
        ...old,
        supersededByJobId: null,
        updatedAt: null,
      });
    }
  });

  it("groups the machines of Contoso by profile, system and schedule and keeps their configurations", async () => {
    const jobs = await jobsOf("Contoso", "endpoint");
    expect(jobs.map((job) => job.name)).toEqual([
      "Linux servers · daily 02:00",
      "Linux servers · daily 22:00",
      "macOS clients · on connect, at most every 4 h",
    ]);
    const main = jobs.find((job) => job.name === "Linux servers · daily 22:00");
    const members = await membersOf(main?.id ?? "");
    expect(members).toHaveLength(3);
    const ids = new Map(members.map((member) => [member.endpointId, member]));
    expect(ids.has(machineIds.web01 ?? "")).toBe(true);
    expect(ids.has(machineIds.web02 ?? "")).toBe(true);
    // The file server's differences are its override, and only those.
    expect(ids.get(machineIds.files01 ?? "")?.overrides).toEqual({
      paths: ["/srv", "/data/projects"],
      excludes: ["*.iso"],
      bandwidthKbps: 5000,
      retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
    });
    expect(ids.get(machineIds.web01 ?? "")?.overrides).toEqual({});
    expect(main?.schedule).toMatchObject({ kind: "daily", timeOfDay: "22:00" });
    expect(main?.scopeMode).toBe("selected");
    // The revoked machine is not scheduled and in no job.
    const all = await owner.select().from(backupJobMembers);
    expect(all.some((member) => member.endpointId === machineIds.old01)).toBe(false);
  });

  it("loses no machine: each is in exactly one job and gets back the configuration it has", async () => {
    const members = await owner.select().from(backupJobMembers);
    const jobRows = await owner.select().from(backupJobs);
    const seen = new Map<string, number>();
    for (const member of members) {
      if (member.endpointId) {
        seen.set(member.endpointId, (seen.get(member.endpointId) ?? 0) + 1);
      }
    }
    for (const [key, id] of Object.entries(machineIds)) {
      if (key === "old01") continue;
      expect(seen.get(id), key).toBe(1);
      const member = members.find((candidate) => candidate.endpointId === id);
      const job = jobRows.find((candidate) => candidate.id === member?.jobId);
      const [row] = await owner.select().from(endpoints).where(eq(endpoints.id, id));
      const wanted = machineConfigs.get(key);
      // Untouched: the same configuration and version as before the migration.
      expect(row?.config, key).toEqual(wanted?.config);
      expect(row?.configVersion, key).toBe(wanted?.configVersion);
      // And the job with the machine's override reproduces it exactly.
      const built = buildEndpointConfig(
        row?.config as never,
        effectiveSchedule(job?.schedule ?? null, member?.overrides ?? {}),
        effectiveSettings(job?.settings ?? {}, member?.overrides ?? {}),
      );
      expect(sameEndpointConfig(built, row?.config as never), key).toBe(true);
    }
    expect(seen.size).toBe(Object.keys(machineIds).length - 1);
  });

  it("covers every schedule of Fabrikam by objects that share the commonest cadence, and names jobs in the tenant's language", async () => {
    const mail = await jobsOf("Fabrikam", "mail");
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      name: "Mail-Sicherung",
      scopeMode: "selected",
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: ZONE },
      verifySchedule: null,
    });
    const members = await membersOf(mail[0]?.id ?? "");
    expect(members).toHaveLength(3);
    const own = members.filter((member) => Object.keys(member.overrides).length > 0);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      protectedObjectId: objectIds["Fabrikam/fritz"],
      overrides: { schedule: { kind: "cron", cron: "0 2 * * *", timeZone: ZONE } },
    });
    // The two that share the job's cadence share its timer: the earlier of theirs.
    expect(mail[0]?.nextRunAt?.toISOString()).toBe("2026-10-02T13:00:00.000Z");
    for (const key of ["fabrikam.dora", "fabrikam.emil", "fabrikam.fritz"]) {
      expect((await scheduleRow(key))?.supersededByJobId, key).toBe(mail[0]?.id);
    }
  });

  it("keeps restore checks when backups were switched off", async () => {
    const [job] = await jobsOf("Globex", "mail");
    expect(job).toMatchObject({
      scopeMode: "all",
      schedule: null,
      verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: ZONE },
    });
    // The switched-off schedule never ran; it is replaced too, and stays on record.
    expect((await scheduleRow("globex.backup"))?.supersededByJobId).toBe(job?.id);
  });

  it("leaves what one job cannot show running, and replaces a duplicate", async () => {
    const [job] = await jobsOf("Initech", "mail");
    expect(job?.schedule).toMatchObject({ kind: "interval", intervalMinutes: 480 });
    expect((await scheduleRow("initech.first"))?.supersededByJobId).toBe(job?.id);
    expect((await scheduleRow("initech.twin"))?.supersededByJobId).toBe(job?.id);
    expect((await scheduleRow("initech.night"))?.supersededByJobId).toBeNull();
    expect((await scheduleRow("initech.night"))?.enabled).toBe(true);
  });

  it("makes a job of a lone machine and nothing for a tenant with nothing", async () => {
    expect(await jobsOf("Hooli", "mail")).toHaveLength(0);
    const jobs = await jobsOf("Hooli", "endpoint");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.settings).toMatchObject({ paths: ["/home"], excludes: [] });
    expect(await jobsOf("Umbrella")).toHaveLength(0);
  });

  it("does not touch a tenant that was moved before", async () => {
    expect(await jobsOf("Done")).toHaveLength(0);
    expect((await scheduleRow("done.backup"))?.supersededByJobId).toBeNull();
    const [tenant] = await owner
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantIds.Done ?? ""));
    expect(tenant?.backupJobsMigratedAt?.toISOString()).toBe(NOW.toISOString());
    // Every other tenant carries the marker now, Umbrella (nothing to do) included.
    const open = await owner.select().from(tenants).where(isNull(tenants.backupJobsMigratedAt));
    expect(open).toHaveLength(0);
  });

  it("writes an audit entry of the system for each tenant and one for the installation", async () => {
    const entries = await owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "backup_job.migrated"));
    const byTenant = new Map(entries.map((entry) => [entry.tenantId, entry]));
    for (const key of ["Contoso", "Fabrikam", "Globex", "Initech", "Hooli"]) {
      const entry = byTenant.get(tenantIds[key] ?? "");
      expect(entry, key).toBeDefined();
      expect(entry).toMatchObject({ actor: "system", targetType: "tenant" });
    }
    // Nothing to report for the tenant with nothing to carry over.
    expect(byTenant.has(tenantIds.Umbrella ?? "")).toBe(false);
    const contoso = byTenant.get(tenantIds.Contoso ?? "")?.details as {
      mail: { schedulesSuperseded: number; left: unknown[]; members: number; overrides: number };
      endpoints: { jobs: { machines: number }[]; machinesReconfigured: number };
    };
    expect(contoso.mail).toMatchObject({ schedulesSuperseded: 4, members: 2, overrides: 2 });
    expect(contoso.mail.left).toHaveLength(1);
    expect(contoso.endpoints.jobs.map((job) => job.machines).sort()).toEqual([1, 1, 3]);
    expect(contoso.endpoints.machinesReconfigured).toBe(0);
    const installation = entries.find((entry) => entry.tenantId === null);
    expect(installation).toMatchObject({ actor: "system", targetType: "installation" });
    expect(installation?.details).toMatchObject({ tenants: 6, mailJobs: 4, endpointJobs: 4 });
  });

  it("changes nothing when it runs again", async () => {
    const afterFirst = await snapshotOfDatabase();
    const again = await migrate.migrateToBackupJobs(providerDb, {
      now: new Date(NOW.getTime() + 3_600_000),
    });
    expect(again).toBeNull();
    expect(await snapshotOfDatabase()).toEqual(afterFirst);
    // Not even when asked for one tenant directly.
    expect(await migrate.migrateTenantToJobs(providerDb, tenantIds.Contoso ?? "", NOW)).toBeNull();
    expect(await snapshotOfDatabase()).toEqual(afterFirst);
  });

  it("does not turn a tenant created after the upgrade into jobs it never asked for", async () => {
    // A tenant made by the api carries the marker from the start (features/tenants/service.ts).
    const [provider] = await owner.select().from(providers).limit(1);
    const [fresh] = await owner
      .insert(tenants)
      .values({
        providerId: provider?.id ?? "",
        name: "Fresh",
        slug: "fresh",
        backupJobsMigratedAt: NOW,
      })
      .returning();
    const [row] = await owner
      .insert(endpoints)
      .values({
        tenantId: fresh?.id ?? "",
        hostname: "late01",
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: randomUUID(),
        config: defaultEndpointConfig("linux", "server", { timeZone: ZONE }),
      })
      .returning();
    expect(await migrate.migrateToBackupJobs(providerDb, { now: NOW })).toBeNull();
    const members = await owner
      .select()
      .from(backupJobMembers)
      .where(eq(backupJobMembers.endpointId, row?.id ?? ""));
    expect(members).toHaveLength(0);
  });

  it("waits for a scheduler that is running a schedule of the tenant, without a deadlock, and carries the timer it advanced", async () => {
    // The scheduler (apps/scheduler store.ts `enqueue`) locks the schedule first, then writes
    // the run (`jobs`, whose foreign key takes a key-share lock on the tenant) and advances the
    // timer. The migration must neither deadlock with it (the tenant would stay unmigrated until
    // the next start) nor copy the timer from before that run (the job would run it again).
    const racing = await makeTenant("Racing", "en");
    await makeObjects(racing, "Racing", ["rita"]);
    await schedule("racing.backup", racing, {
      kind: "backup",
      intervalMinutes: 480,
      nextRunAt: new Date("2026-10-02T11:00:00Z"),
    });
    const scheduleId = scheduleIds["racing.backup"] ?? "";
    const advanced = new Date("2026-10-02T20:00:00Z");
    const scheduler = await owner.$client.connect();
    const waitingForLock = async () => {
      for (let attempt = 0; attempt < 250; attempt++) {
        const { rows } = await owner.$client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if ((rows[0]?.n ?? 0) > 0) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("the migration never waited for the scheduler's lock");
    };
    try {
      await scheduler.query("BEGIN");
      await scheduler.query("SELECT superseded_by_job_id FROM schedules WHERE id = $1 FOR UPDATE", [
        scheduleId,
      ]);
      const migration = migrate.migrateTenantToJobs(providerDb, racing, NOW);
      // Keep a rejection from surfacing as unhandled before it is awaited below.
      migration.catch(() => undefined);
      await waitingForLock();
      await scheduler.query("INSERT INTO jobs (tenant_id, queue) VALUES ($1, 'backup')", [racing]);
      await scheduler.query(
        "UPDATE schedules SET last_run_at = $2, next_run_at = $3 WHERE id = $1",
        [scheduleId, NOW, advanced],
      );
      await scheduler.query("COMMIT");
      const result = await migration;
      expect(result?.mailJobId).toBeTruthy();
    } finally {
      await scheduler.query("ROLLBACK").catch(() => undefined);
      scheduler.release();
    }
    const [job] = await jobsOf("Racing", "mail");
    expect(job?.nextRunAt?.toISOString()).toBe(advanced.toISOString());
    expect(job?.lastRunAt?.toISOString()).toBe(NOW.toISOString());
    expect((await scheduleRow("racing.backup"))?.supersededByJobId).toBe(job?.id);
  });

  it("reports the schedules it leaves running when the tenant has a mail job already", async () => {
    // Only possible when the step failed for the tenant at an earlier start and an administrator
    // made a job by hand meanwhile: the old schedules stay and run next to that job, so the
    // operator must be told, in the tenant's audit and in the totals.
    const handmade = await makeTenant("Handmade", "en");
    await makeObjects(handmade, "Handmade", ["hank"]);
    await schedule("handmade.backup", handmade, { kind: "backup", intervalMinutes: 480 });
    await schedule("handmade.verify", handmade, { kind: "verify", cron: "0 3 * * 0" });
    await schedule("handmade.off", handmade, {
      kind: "backup",
      intervalMinutes: 60,
      enabled: false,
    });
    await owner.insert(backupJobs).values({
      tenantId: handmade,
      kind: "mail",
      name: "By hand",
      scopeMode: "all",
      schedule: { kind: "interval", intervalMinutes: 240, timeZone: ZONE },
    });
    const result = await migrate.migrateTenantToJobs(providerDb, handmade, NOW);
    expect(result?.mailJobId).toBeNull();
    expect(result?.leftover.map((left) => [left.id, left.kind, left.reason]).sort()).toEqual(
      [
        [scheduleIds["handmade.backup"], "backup", "mail_job_exists"],
        [scheduleIds["handmade.verify"], "verify", "mail_job_exists"],
      ].sort(),
    );
    expect((await scheduleRow("handmade.backup"))?.supersededByJobId).toBeNull();
    const [entry] = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "backup_job.migrated"), eq(auditLog.tenantId, handmade)));
    expect((entry?.details as { mail: { left: unknown[] } }).mail.left).toHaveLength(2);
  });

  it("makes one set of jobs when two api replicas start together", async () => {
    const parallel = await makeTenant("Parallel", "en");
    await makeObjects(parallel, "Parallel", ["pat"]);
    await schedule("parallel.backup", parallel, { kind: "backup", intervalMinutes: 480 });
    await machine("par01", parallel);
    await machine("par02", parallel);
    const results = await Promise.all([
      migrate.migrateToBackupJobs(providerDb, { now: NOW }),
      migrate.migrateToBackupJobs(providerDb, { now: NOW }),
      migrate.migrateToBackupJobs(providerDb, { now: NOW }),
    ]);
    // Exactly one of them did the work for the tenant.
    expect(results.filter((result) => result !== null && result.tenants > 0)).toHaveLength(1);
    expect(await jobsOf("Parallel", "mail")).toHaveLength(1);
    const machineJobs = await jobsOf("Parallel", "endpoint");
    expect(machineJobs).toHaveLength(1);
    expect(await membersOf(machineJobs[0]?.id ?? "")).toHaveLength(2);
    expect(
      await owner
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "backup_job.migrated"), eq(auditLog.tenantId, parallel))),
    ).toHaveLength(1);
  });
});
