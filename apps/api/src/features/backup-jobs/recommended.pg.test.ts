/**
 * Postgres-backed tests of "Create recommended job" (#52), through the backup jobs routes: the
 * preview writes nothing; the apply makes one job per kind and group (mail over all objects,
 * machines per system and profile, one Proxmox VE job) and adds to it later; a double click
 * makes nothing twice; objects in a job are skipped, never moved; another tenant's ids are not
 * found (Row Level Security); only administrators may apply; every job is audited. Where the
 * installation offers the archive capture (a test gate), the mail job over all objects archives
 * too: a new one is made archiving, an existing one is switched on, a hand-picked way is kept.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the database
 * `restow_api_recommended_jobs_test` is recreated there and dropped after, the roles with it).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { defaultEndpointConfig } from "@restow/core";
import {
  auditLog,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  endpoints,
  protectedObjects,
  providers,
  pveClusters,
  pveGuests,
  pveJobs,
  sources,
  tenants,
  user,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { type Role, roleSatisfies, type TenantRole } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { RecommendedAppliedDto, RecommendedPlanDto } from "./recommended.js";

const DATABASE = "restow_api_recommended_jobs_test";
const ROLE_HEADER = "x-test-role";
const ZONE = "Europe/Berlin";

function stand(minimum: TenantRole, userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role");
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    c.set("user", { id: userId, email: `${role}@contoso.example` } as unknown as SessionUser);
    c.set("auth", {
      session: { createdAt: new Date(Date.now() - 5000), authMethod: "passkey" },
    } as never);
    await next();
  };
}

describe.skipIf(!testDatabaseAdminUrl)("recommended jobs against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  const machines: Record<string, string> = {};
  const guests: Record<string, string> = {};
  const adminId = randomUUID();
  const clock = new Date("2026-10-02T10:00:00.000Z");
  // The archive capture gate (lib/features.ts): closed until the archive tests open it.
  let gateOpen = false;

  async function machine(
    tenantId: string,
    hostname: string,
    os: "linux" | "windows" | "darwin",
    profile: "server" | "client",
  ) {
    const [row] = await owner
      .insert(endpoints)
      .values({
        tenantId,
        hostname,
        os,
        arch: "amd64",
        profile,
        secretHash: randomUUID(),
        config: defaultEndpointConfig(os, profile, { timeZone: ZONE }),
      })
      .returning();
    return row?.id ?? "";
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { buildBackupJobsRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");
    const { registerApiExtension } = await import("../../extensions.js");
    registerApiExtension({
      name: "test-gate",
      featureGate: {
        isEnabled: async (_pool, feature) => gateOpen && feature === "archive.mailboxCapture",
      },
    });

    await owner
      .insert(user)
      .values({ id: adminId, name: "Admin", email: "admin@contoso.example", emailVerified: true });
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const made = await owner
      .insert(tenants)
      .values([
        {
          providerId: provider?.id ?? "",
          name: "Contoso",
          slug: "contoso",
          language: "en",
          timeZone: ZONE,
          backupJobsMigratedAt: clock,
        },
        {
          providerId: provider?.id ?? "",
          name: "Fabrikam",
          slug: "fabrikam",
          backupJobsMigratedAt: clock,
        },
      ])
      .returning();
    contoso = made[0]?.id ?? "";
    fabrikam = made[1]?.id ?? "";
    const [m365] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    for (const name of ["anna", "ben"]) {
      await owner.insert(protectedObjects).values({
        tenantId: contoso,
        sourceId: m365?.id ?? "",
        kind: "mailbox",
        externalId: `${name}@contoso.example`,
        displayName: name,
      });
    }
    machines.web01 = await machine(contoso, "web01", "linux", "server");
    machines.web02 = await machine(contoso, "web02", "linux", "server");
    machines.laptop = await machine(contoso, "laptop", "windows", "client");
    machines.db01 = await machine(contoso, "db01", "linux", "server");
    machines.foreign = await machine(fabrikam, "foreign", "linux", "server");
    // db01 is in a job of its own already.
    const [own] = await owner
      .insert(backupJobs)
      .values({
        tenantId: contoso,
        kind: "endpoint",
        name: "Databases",
        schedule: { kind: "daily", timeOfDay: "01:00", timeZone: ZONE },
        settings: { paths: ["/var/lib/postgresql"] },
      })
      .returning();
    await owner
      .insert(backupJobMembers)
      .values({ tenantId: contoso, jobId: own?.id ?? "", endpointId: machines.db01 });

    const [cluster] = await owner
      .insert(pveClusters)
      .values({ tenantId: contoso, name: "lab", fingerprint: randomUUID(), storageId: "restow" })
      .returning();
    for (const [name, vmid, template] of [
      ["app", 101, false],
      ["mail", 102, false],
      ["golden", 9000, true],
    ] as const) {
      const [row] = await owner
        .insert(pveGuests)
        .values({
          tenantId: contoso,
          clusterId: cluster?.id ?? "",
          vmid,
          kind: "vm",
          name,
          node: "pve1",
          template,
        })
        .returning();
      guests[name] = row?.id ?? "";
    }

    app = new Hono();
    app.onError((error, c) => {
      if (!(error instanceof ProblemError)) {
        console.error(error);
      }
      return errorHandler(error, c);
    });
    app.route(
      "/backup-jobs",
      buildBackupJobsRoutes({
        db: appDb,
        requireAdmin: stand("tenant_admin", adminId),
        now: () => clock,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    const { resetExtensionsForTesting } = await import("../../extensions.js");
    resetExtensionsForTesting();
    const shared = await import("../../db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  function call(
    method: string,
    path: string,
    options: { tenant?: string; role?: Role; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {
      "x-restow-tenant": options.tenant ?? contoso,
      [ROLE_HEADER]: options.role ?? "tenant_admin",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return app.request(`/backup-jobs${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function json<T>(response: Response, status: number): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  it("previews everything without a job and writes nothing", async () => {
    const preview = await json<RecommendedPlanDto>(
      await call("GET", "/recommended?everything=1"),
      200,
    );
    expect(
      preview.items.map((item) => [item.kind, item.key, item.action, item.memberCount]),
    ).toEqual([
      ["mail", "mail", "create", 2],
      ["endpoint", "endpoint:linux:server", "create", 2],
      ["endpoint", "endpoint:windows:client", "create", 1],
      ["pve", "pve", "create", 2],
    ]);
    const [mail, linux, windows, pve] = preview.items;
    expect(mail).toMatchObject({
      name: "Mail backup",
      schedule: { kind: "interval", intervalMinutes: 480, timeZone: ZONE },
      verifySchedule: { kind: "cron", cron: "0 3 * * 0", timeZone: ZONE },
      repository: { kind: "installation_default" },
    });
    expect(linux).toMatchObject({
      name: "Linux servers · daily 22:00",
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: ZONE },
      retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
    });
    expect(linux?.members.map((member) => member.name).sort()).toEqual(["web01", "web02"]);
    expect(windows).toMatchObject({
      name: "Windows clients · on connect, at most every 4 h",
      schedule: { kind: "on_connect", intervalMinutes: 240 },
    });
    expect(pve).toMatchObject({
      name: "VMs & containers · daily 22:00",
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: ZONE },
      mode: "snapshot",
      retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
    });
    // The template is not news for "everything"; db01 is in its job and stays out.
    expect(pve?.members.map((member) => member.name).sort()).toEqual(["app", "mail"]);
    expect(preview.skipped).toEqual([]);
    expect(await owner.select().from(pveJobs)).toHaveLength(0);
    expect(
      (await owner.select().from(backupJobs)).filter((job) => job.recommended !== null),
    ).toHaveLength(0);
  });

  it("narrows everything to the kinds a list's notice is about", async () => {
    const preview = await json<RecommendedPlanDto>(
      await call("GET", "/recommended?everything=1&kinds=endpoint"),
      200,
    );
    expect(preview.items.map((item) => item.key)).toEqual([
      "endpoint:linux:server",
      "endpoint:windows:client",
    ]);
    expect((await call("GET", "/recommended?everything=1&kinds=tapes")).status).toBe(422);
  });

  it("names what it skips when asked for objects that are in a job or cannot be backed up", async () => {
    const preview = await json<RecommendedPlanDto>(
      await call(
        "GET",
        `/recommended?endpointIds=${machines.db01},${machines.foreign}&guestIds=${guests.golden}`,
      ),
      200,
    );
    expect(preview.items).toEqual([]);
    expect(preview.skipped.map((entry) => [entry.kind, entry.id, entry.reason])).toEqual(
      expect.arrayContaining([
        ["endpoint", machines.db01, "in_job"],
        // Another tenant's machine is not found under Row Level Security.
        ["endpoint", machines.foreign, "unavailable"],
        ["pve", guests.golden, "unavailable"],
      ]),
    );
  });

  it("refuses an empty scope and a role that may not change jobs", async () => {
    expect((await call("POST", "/recommended", { body: {} })).status).toBe(422);
    expect(
      (await call("POST", "/recommended", { role: "tenant_restore", body: { mail: true } })).status,
    ).toBe(403);
  });

  it("makes one job per group on two clicks at once, and adds to it afterwards", async () => {
    const body = { endpointIds: [machines.web01], guestIds: [guests.app] };
    const [first, second] = await Promise.all([
      call("POST", "/recommended", { body }),
      call("POST", "/recommended", { body }),
    ]);
    const results = [
      await json<RecommendedAppliedDto>(first as Response, 200),
      await json<RecommendedAppliedDto>(second as Response, 200),
    ];
    const created = results.flatMap((result) => result.items.filter((item) => item.created));
    expect(created.map((item) => item.key).sort()).toEqual(["endpoint:linux:server", "pve"]);
    // The click that waited found the machine and the guest in the jobs and did nothing.
    const later = results.find((result) => result.items.length === 0);
    expect(later?.skipped.map((entry) => entry.reason).sort()).toEqual(["in_job", "in_job"]);

    const linux = (await owner.select().from(backupJobs)).filter(
      (job) => job.recommended === "endpoint:linux:server",
    );
    expect(linux).toHaveLength(1);
    expect(linux[0]).toMatchObject({
      name: "Linux servers · daily 22:00",
      kind: "endpoint",
      createdBy: adminId,
      settings: expect.objectContaining({
        retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      }),
    });
    const pve = await owner.select().from(pveJobs);
    expect(pve).toHaveLength(1);
    expect(pve[0]).toMatchObject({
      recommended: true,
      scopeAll: false,
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: ZONE },
      settings: { mode: "snapshot", retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 } },
    });
    expect(pve[0]?.nextRunAt).not.toBeNull();
    const [app] = await owner.select().from(pveGuests).where(eq(pveGuests.id, guests.app));
    expect(app?.jobId).toBe(pve[0]?.id);

    // A second machine of the same group and the second guest join the jobs that exist.
    const added = await json<RecommendedAppliedDto>(
      await call("POST", "/recommended", {
        body: { endpointIds: [machines.web02], guestIds: [guests.mail] },
      }),
      200,
    );
    expect(added.items.map((item) => [item.key, item.created, item.added, item.jobId])).toEqual([
      ["endpoint:linux:server", false, 1, linux[0]?.id],
      ["pve", false, 1, pve[0]?.id],
    ]);
    const members = await owner
      .select()
      .from(backupJobMembers)
      .where(eq(backupJobMembers.jobId, linux[0]?.id ?? ""));
    expect(members.map((member) => member.endpointId).sort()).toEqual(
      [machines.web01, machines.web02].sort(),
    );

    const audits = await owner.select().from(auditLog);
    expect(
      audits.filter((row) => row.action === "backup_job.created" && row.target === linux[0]?.id),
    ).toHaveLength(1);
    expect(
      audits.filter((row) => row.action === "pve.job.changed" && row.target === pve[0]?.id),
    ).toHaveLength(1);
    expect(audits.filter((row) => row.action === "backup_job.recommended_applied")).toHaveLength(2);
  });

  it("protects everything left with one click, then has nothing left to do", async () => {
    const applied = await json<RecommendedAppliedDto>(
      await call("POST", "/recommended", { body: { everything: true } }),
      200,
    );
    expect(applied.items.map((item) => [item.kind, item.key, item.created])).toEqual([
      ["mail", "mail", true],
      ["endpoint", "endpoint:windows:client", true],
    ]);
    const [mail] = (await owner.select().from(backupJobs)).filter(
      (job) => job.recommended === "mail",
    );
    expect(mail).toMatchObject({ kind: "mail", scopeMode: "all", name: "Mail backup" });
    const again = await json<RecommendedPlanDto>(
      await call("GET", "/recommended?everything=1"),
      200,
    );
    expect(again.items).toEqual([]);
    // Asked for mail explicitly, the job over all objects is named as the reason.
    const asked = await json<RecommendedPlanDto>(await call("GET", "/recommended?mail=1"), 200);
    expect(asked.skipped).toEqual([
      { kind: "mail", id: mail?.id, name: "Mail backup", reason: "covered" },
    ]);
  });

  it("keeps another tenant's jobs apart", async () => {
    const preview = await json<RecommendedPlanDto>(
      await call("GET", "/recommended?everything=1", { tenant: fabrikam }),
      200,
    );
    expect(preview.items.map((item) => [item.key, item.action, item.memberCount])).toEqual([
      ["endpoint:linux:server", "create", 1],
    ]);
  });
  it("makes the recommended mail job archiving where the installation offers the capture", async () => {
    const [provider] = await owner.select().from(providers).limit(1);
    const [tailspin] = await owner
      .insert(tenants)
      .values({
        providerId: provider?.id ?? "",
        name: "Tailspin",
        slug: "tailspin",
        language: "en",
        timeZone: ZONE,
        backupJobsMigratedAt: clock,
      })
      .returning();
    const tenant = tailspin?.id ?? "";
    const [m365] = await owner
      .insert(sources)
      .values({ tenantId: tenant, kind: "m365", name: "Tailspin M365", status: "active" })
      .returning();
    const [imap] = await owner
      .insert(sources)
      .values({
        tenantId: tenant,
        kind: "imap",
        name: "Tailspin IMAP",
        host: "mail.tailspin.example",
        status: "active",
      })
      .returning();
    await owner.insert(protectedObjects).values([
      {
        tenantId: tenant,
        sourceId: m365?.id ?? "",
        kind: "mailbox",
        externalId: "cara@tailspin.example",
      },
      {
        tenantId: tenant,
        sourceId: imap?.id ?? "",
        kind: "imap",
        externalId: "dan@tailspin.example",
      },
    ]);

    // Without the capture nothing about archiving changes.
    const closed = await json<RecommendedPlanDto>(
      await call("GET", "/recommended?everything=1", { tenant }),
      200,
    );
    expect(closed.items.map((item) => [item.kind, item.action, item.archive])).toEqual([
      ["mail", "create", false],
    ]);

    gateOpen = true;
    try {
      const preview = await json<RecommendedPlanDto>(
        await call("GET", "/recommended?everything=1", { tenant }),
        200,
      );
      // One job over all objects that backs up and archives: no second archive item.
      expect(
        preview.items.map((item) => [item.kind, item.action, item.archive, item.captureKinds]),
      ).toEqual([["mail", "create", true, ["imap", "m365"]]]);
      // Asked for the archive alone, the same job is made.
      const alone = await json<RecommendedPlanDto>(
        await call("GET", "/recommended?everything=1&kinds=archive", { tenant }),
        200,
      );
      expect(alone.items.map((item) => [item.kind, item.key, item.action, item.archive])).toEqual([
        ["archive", "archive", "create", true],
      ]);

      const applied = await json<RecommendedAppliedDto>(
        await call("POST", "/recommended", { tenant, body: { everything: true } }),
        200,
      );
      expect(applied.items.map((item) => [item.kind, item.created])).toEqual([["mail", true]]);
      const [job] = (await owner.select().from(backupJobs)).filter(
        (row) => row.tenantId === tenant,
      );
      expect(job).toMatchObject({
        kind: "mail",
        scopeMode: "all",
        recommended: "mail",
        archive: true,
        archiveCapture: {},
      });
      const created = (await owner.select().from(auditLog)).find(
        (row) => row.action === "backup_job.created" && row.target === job?.id,
      );
      expect(created?.details).toMatchObject({ recommended: "mail", archive: true });
      const again = await json<RecommendedPlanDto>(
        await call("GET", "/recommended?everything=1&kinds=archive", { tenant }),
        200,
      );
      expect(again.items).toEqual([]);
      expect(again.skipped).toEqual([
        { kind: "archive", id: job?.id, name: job?.name, reason: "covered" },
      ]);
    } finally {
      gateOpen = false;
    }
  });

  it("switches archiving on in the job over all objects, never in a hand-picked one", async () => {
    const [mail] = (await owner.select().from(backupJobs)).filter(
      (job) => job.tenantId === contoso && job.recommended === "mail",
    );
    expect(mail?.archive).toBe(false);
    const [picked] = await owner
      .insert(backupJobs)
      .values({
        tenantId: contoso,
        kind: "mail",
        name: "Board mailboxes",
        scopeMode: "selected",
        schedule: { kind: "interval", intervalMinutes: 240, timeZone: ZONE },
      })
      .returning();
    gateOpen = true;
    try {
      // A way switched off by hand is a choice: the click leaves the job as it is.
      await owner
        .update(backupJobs)
        .set({ archiveCapture: { m365: { graph: false, journal: false } } })
        .where(eq(backupJobs.id, mail?.id ?? ""));
      const blocked = await json<RecommendedPlanDto>(
        await call("GET", "/recommended?everything=1&kinds=archive"),
        200,
      );
      expect(blocked.items).toEqual([]);
      expect(blocked.skipped).toContainEqual({
        kind: "archive",
        id: mail?.id,
        name: "Mail backup",
        reason: "no_capture_way",
      });
      await owner
        .update(backupJobs)
        .set({ archiveCapture: {} })
        .where(eq(backupJobs.id, mail?.id ?? ""));

      const preview = await json<RecommendedPlanDto>(
        await call("GET", "/recommended?everything=1"),
        200,
      );
      expect(preview.items.map((item) => [item.kind, item.action, item.jobId])).toEqual([
        ["archive", "enable", mail?.id],
      ]);
      // It keeps its schedules.
      expect(preview.items[0]).toMatchObject({
        name: "Mail backup",
        schedule: mail?.schedule,
        captureKinds: ["m365"],
      });
      const applied = await json<RecommendedAppliedDto>(
        await call("POST", "/recommended", { body: { everything: true } }),
        200,
      );
      expect(applied.items.map((item) => [item.kind, item.jobId, item.created])).toEqual([
        ["archive", mail?.id, false],
      ]);
      const [after] = await owner
        .select()
        .from(backupJobs)
        .where(eq(backupJobs.id, mail?.id ?? ""));
      expect(after).toMatchObject({ archive: true, schedule: mail?.schedule });
      const [untouched] = await owner
        .select()
        .from(backupJobs)
        .where(eq(backupJobs.id, picked?.id ?? ""));
      expect(untouched?.archive).toBe(false);
      const updated = (await owner.select().from(auditLog)).filter(
        (row) => row.action === "backup_job.updated" && row.target === mail?.id,
      );
      expect(updated).toHaveLength(1);
      expect(JSON.stringify(updated[0]?.details)).toContain("archive");
      const again = await json<RecommendedPlanDto>(
        await call("GET", "/recommended?everything=1&kinds=archive"),
        200,
      );
      expect(again.items).toEqual([]);
      expect(again.skipped).toEqual([
        { kind: "archive", id: mail?.id, name: "Mail backup", reason: "covered" },
        { kind: "archive", id: picked?.id, name: "Board mailboxes", reason: "in_job" },
      ]);
    } finally {
      gateOpen = false;
    }
  });
});
