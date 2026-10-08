/**
 * Postgres-backed tests of warnings and their acknowledgements: why a mailbox has a warning (its
 * failed items with folder, subject, date, cause and the raw message), acknowledging it, the
 * warning coming back for a new cause or after a failed run, a failed backup that cannot be
 * acknowledged, revoking, the audit trail, the counts of the status summary and the directory,
 * machines, and tenant isolation (through the application role, which Row Level Security
 * binds).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the database
 * `restow_api_warnings_test` is recreated there and dropped after).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { buildCause, defaultEndpointConfig, toFailureRecord } from "@restow/core";
import {
  type Database,
  type FailureRecordJson,
  auditLog,
  createDb,
  endpointRuns,
  endpoints,
  itemFailures,
  jobProgress,
  jobs,
  protectedObjects,
  providers,
  sources,
  tenants,
  user,
  warningAcknowledgements,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { type Role, roleSatisfies } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { loadTenantSummary } from "../../routes/v1/status.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import { listObjects } from "../directory/service.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { AcknowledgeResultDto, WarningDetailDto, WarningListDto } from "./dto.js";
import { buildWarningsRoutes } from "./routes.js";
import { WARNING_AUDIT_ACTIONS } from "./service.js";

const DATABASE = "restow_api_warnings_test";
const ROLE_HEADER = "x-test-role";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const minutes = (count: number) => new Date(NOW.getTime() - count * 60_000);

function stand(minimum: "tenant_admin", userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role", {
        detail: `This endpoint requires the ${minimum} role.`,
      });
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    c.set("user", { id: userId, email: "admin@contoso.example" } as unknown as SessionUser);
    await next();
  };
}

function cause(code: Parameters<typeof buildCause>[0], technical = {}): FailureRecordJson {
  return toFailureRecord(buildCause(code, {}, technical), {
    now: minutes(30),
    step: "download",
  }) as FailureRecordJson;
}

describe.skipIf(!testDatabaseAdminUrl)("warnings against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let sourceId: string;
  let machine: string;
  const adminId = randomUUID();
  const objects: Record<string, string> = {};

  async function backup(
    objectId: string,
    status: "completed" | "failed",
    at: Date,
    failed = 0,
    extra: Partial<typeof jobs.$inferInsert> = {},
  ): Promise<string> {
    const [row] = await owner
      .insert(jobs)
      .values({
        tenantId: contoso,
        queue: "backup",
        status,
        protectedObjectId: objectId,
        createdAt: new Date(at.getTime() - 60_000),
        startedAt: new Date(at.getTime() - 60_000),
        completedAt: at,
        ...extra,
      })
      .returning();
    const id = row?.id ?? "";
    await owner.insert(jobProgress).values({ tenantId: contoso, jobId: id, failed });
    return id;
  }

  async function failItems(
    jobId: string,
    objectId: string,
    items: { ref: string; code: Parameters<typeof buildCause>[0] | null; date?: Date }[],
  ) {
    await owner.insert(itemFailures).values(
      items.map((item) => ({
        tenantId: contoso,
        jobId,
        protectedObjectId: objectId,
        itemRef: item.ref,
        reason: `Graph 413 ErrorMessageSizeExceeded: ${item.ref} is too large`,
        failure: item.code
          ? cause(item.code, { httpStatus: 413, errorCode: "ErrorMessageSizeExceeded" })
          : null,
        itemDate: item.date ?? null,
        lastAttemptAt: minutes(30),
      })),
    );
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    const { errorHandler } = await import("../../problem.js");

    await owner
      .insert(user)
      .values({ id: adminId, name: "Admin", email: "admin@contoso.example", emailVerified: true });
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const made = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = made[0]?.id ?? "";
    fabrikam = made[1]?.id ?? "";
    const [m365] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    sourceId = m365?.id ?? "";
    for (const name of ["anna", "ben", "clara", "dora"]) {
      const [row] = await owner
        .insert(protectedObjects)
        .values({
          tenantId: contoso,
          sourceId,
          kind: "mailbox",
          externalId: `${name}@contoso.example`,
          displayName: name,
        })
        .returning();
      objects[name] = row?.id ?? "";
    }
    const [server] = await owner
      .insert(endpoints)
      .values({
        tenantId: contoso,
        hostname: "fs-bergisch",
        displayName: "Fileserver",
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: randomUUID(),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
        lastSeenAt: new Date(),
      })
      .returning();
    machine = server?.id ?? "";

    // anna: the newest backup left two messages behind, too large.
    const annaRun = await backup(objects.anna as string, "completed", minutes(30), 2, {
      itemFailureSummary: { total: 2, stored: 2, byCause: { "graph.item_too_large": 2 } },
    });
    await failItems(annaRun, objects.anna as string, [
      {
        ref: "mail/Inbox/Projects/Quarterly report.0123456789abcdef.eml",
        code: "graph.item_too_large",
        date: new Date("2026-09-01T08:00:00.000Z"),
      },
      { ref: "mail/Sent Items/Big scan.fedcba9876543210.eml", code: "graph.item_too_large" },
    ]);
    // ben: the newest backup failed outright.
    await backup(objects.ben as string, "completed", minutes(300), 1);
    await backup(objects.ben as string, "failed", minutes(20), 0, {
      errorMessage: "Graph 403",
      failure: cause("graph.access_denied", { httpStatus: 403 }),
    });
    // clara: complete. dora: an older run from before failure records (text only).
    await backup(objects.clara as string, "completed", minutes(40), 0);
    const doraRun = await backup(objects.dora as string, "completed", minutes(50), 1);
    await failItems(doraRun, objects.dora as string, [{ ref: "mail/Inbox/old.eml", code: null }]);

    // The machine: its newest backup is partial (a locked file).
    await owner.insert(endpointRuns).values({
      tenantId: contoso,
      endpointId: machine,
      kind: "backup",
      status: "partial",
      startedAt: minutes(70),
      finishedAt: minutes(60),
      errors: [{ path: "/srv/db/locked.mdf", message: "permission denied", code: "read_error" }],
    });

    app = new Hono();
    app.onError(errorHandler);
    app.route(
      "/warnings",
      buildWarningsRoutes({ db: appDb, requireAdmin: stand("tenant_admin", adminId) }),
    );
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  });

  function call(
    path: string,
    options: { tenant?: string; role?: Role; method?: string; body?: unknown } = {},
  ) {
    return app.request(path, {
      method: options.method ?? "GET",
      headers: {
        "x-restow-tenant": options.tenant ?? contoso,
        [ROLE_HEADER]: options.role ?? "tenant_admin",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }

  async function json<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return (await response.json()) as T;
  }

  const acknowledge = (targets: { kind: string; id: string }[], note?: string, tenant?: string) =>
    call("/warnings/acknowledge", { method: "POST", body: { targets, note }, tenant });

  it("explains the warning of a mailbox: runs, failed items with folder, subject, date and cause", async () => {
    const detail = await json<WarningDetailDto>(await call(`/warnings/object/${objects.anna}`));
    expect(detail.state).toBe("open");
    expect(detail.target).toMatchObject({ kind: "object", subjectKind: "mailbox", name: "anna" });
    expect(detail.runs[0]).toMatchObject({ outcome: "partial", failedItems: 2 });
    expect(detail.itemCount).toBe(2);
    const report = detail.items.find((item) => item.location.name === "Quarterly report");
    expect(report).toMatchObject({
      location: { area: "mail", folder: "Inbox/Projects", itemId: "0123456789abcdef" },
      itemDate: "2026-09-01T08:00:00.000Z",
      failure: {
        code: "graph.item_too_large",
        technical: { errorCode: "ErrorMessageSizeExceeded" },
      },
    });
    expect(report?.message).toContain("ErrorMessageSizeExceeded");
    expect(detail.groups).toHaveLength(1);
    expect(detail.groups[0]).toMatchObject({ count: 2, failure: { code: "graph.item_too_large" } });
    expect(detail.groups[0]?.failure.steps.map((step) => step.id)).toEqual(["item_stays_failed"]);
    expect(detail.acknowledge).toEqual({ allowed: true, refusal: null });
  });

  it("reads failed items without a classified cause as one unknown cause", async () => {
    const detail = await json<WarningDetailDto>(await call(`/warnings/object/${objects.dora}`));
    expect(detail.state).toBe("open");
    expect(detail.causes).toEqual([{ code: "unknown", count: 1 }]);
    expect(detail.groups[0]?.failure.code).toBe("unknown");
    expect(detail.items[0]?.message).toContain("too large");
  });

  it("lists open warnings of mailboxes and machines and counts the failed backups apart", async () => {
    const list = await json<WarningListDto>(await call("/warnings"));
    expect(list.counts).toEqual({ open: 3, acknowledged: 0, failed: 1, failedGuests: 0 });
    expect(list.items.map((item) => item.target.name).sort()).toEqual([
      "Fileserver",
      "anna",
      "dora",
    ]);
    const server = list.items.find((item) => item.target.kind === "machine");
    expect(server?.causes).toEqual([{ code: "endpoint.read_error", count: 1 }]);
  });

  it("refuses to acknowledge a failed backup or an object without a warning", async () => {
    const result = await json<AcknowledgeResultDto>(
      await acknowledge([
        { kind: "object", id: objects.ben as string },
        { kind: "object", id: objects.clara as string },
        { kind: "object", id: randomUUID() },
      ]),
    );
    expect(result.acknowledged).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { kind: "object", id: objects.ben, reason: "failed" },
        { kind: "object", id: objects.clara, reason: "no_warning" },
        expect.objectContaining({ reason: "not_found" }),
      ]),
    );
    const detail = await json<WarningDetailDto>(await call(`/warnings/object/${objects.ben}`));
    expect(detail.state).toBe("failed");
    expect(detail.acknowledge).toEqual({ allowed: false, refusal: "failed" });
    expect(detail.runs[0]?.failure?.code).toBe("graph.access_denied");
  });

  it("acknowledges in bulk with a note, audited, and the warning stops counting", async () => {
    const result = await json<AcknowledgeResultDto>(
      await acknowledge(
        [
          { kind: "object", id: objects.anna as string },
          { kind: "machine", id: machine },
        ],
        "  Too large for Microsoft to export, accepted.  ",
      ),
    );
    expect(result.skipped).toEqual([]);
    expect(result.acknowledged.map((item) => item.state)).toEqual(["acknowledged", "acknowledged"]);
    expect(result.acknowledged[0]?.acknowledgement).toMatchObject({
      acknowledgedBy: "admin@contoso.example",
      note: "Too large for Microsoft to export, accepted.",
      causes: ["graph.item_too_large"],
      superseded: false,
    });

    const audits = await owner
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, WARNING_AUDIT_ACTIONS.acknowledged));
    expect(audits.map((row) => row.target).sort()).toEqual(
      [objects.anna as string, machine].sort(),
    );
    expect(audits.find((row) => row.target === objects.anna)?.details).toMatchObject({
      causes: ["graph.item_too_large"],
      failedItems: 2,
    });

    const list = await json<WarningListDto>(await call("/warnings?state=open"));
    expect(list.counts).toEqual({ open: 1, acknowledged: 2, failed: 1, failedGuests: 0 });
    expect(list.items.map((item) => item.target.name)).toEqual(["dora"]);

    const summary = await loadTenantSummary(appDb, contoso, NOW);
    expect(summary.objects).toMatchObject({
      failed: 1,
      withItemFailures: 1,
      acknowledgedWarnings: 1,
    });

    const page = await listObjects(appDb, contoso, {
      page: 1,
      pageSize: 25,
      sort: "name",
      order: "asc",
    });
    const anna = page.items.find((item) => item.id === objects.anna);
    expect(anna?.warning).toMatchObject({
      state: "acknowledged",
      failedItems: 2,
      causes: [{ code: "graph.item_too_large", count: 2 }],
      acknowledgement: { note: "Too large for Microsoft to export, accepted." },
    });
    expect(page.items.find((item) => item.id === objects.ben)?.warning).toBeNull();
    expect(page.items.find((item) => item.id === objects.dora)?.warning?.state).toBe("open");
  });

  it("keeps the acknowledgement for the same cause in a later run", async () => {
    const run = await backup(objects.anna as string, "completed", minutes(10), 1, {
      itemFailureSummary: { total: 1, stored: 1, byCause: { "graph.item_too_large": 1 } },
    });
    await failItems(run, objects.anna as string, [
      { ref: "mail/Inbox/Another.aaaaaaaaaaaaaaaa.eml", code: "graph.item_too_large" },
    ]);
    const detail = await json<WarningDetailDto>(await call(`/warnings/object/${objects.anna}`));
    expect(detail.state).toBe("acknowledged");
    expect(detail.focusRunId).toBe(run);
  });

  it("shows the warning again for a new cause, naming it", async () => {
    const run = await backup(objects.anna as string, "completed", minutes(5), 2, {
      itemFailureSummary: {
        total: 2,
        stored: 2,
        byCause: { "graph.item_too_large": 1, "graph.item_unreadable": 1 },
      },
    });
    await failItems(run, objects.anna as string, [
      { ref: "mail/Inbox/Big.bbbbbbbbbbbbbbbb.eml", code: "graph.item_too_large" },
      { ref: "mail/Inbox/Broken.cccccccccccccccc.eml", code: "graph.item_unreadable" },
    ]);
    const detail = await json<WarningDetailDto>(await call(`/warnings/object/${objects.anna}`));
    expect(detail.state).toBe("open");
    expect(detail.newCauses).toEqual(["graph.item_unreadable"]);
    expect(detail.acknowledgement?.superseded).toBe(true);
    const summary = await loadTenantSummary(appDb, contoso, NOW);
    expect(summary.objects).toMatchObject({ withItemFailures: 2, acknowledgedWarnings: 0 });
  });

  it("shows the warning again after a backup that failed outright, even if the next one went through", async () => {
    const dora = objects.dora as string;
    await json<AcknowledgeResultDto>(await acknowledge([{ kind: "object", id: dora }]));
    expect((await json<WarningDetailDto>(await call(`/warnings/object/${dora}`))).state).toBe(
      "acknowledged",
    );
    // Acknowledged a moment ago (the real clock); the failure and the new partial run come after it.
    const later = new Date(Date.now() + 60_000);
    await backup(dora, "failed", later, 0, { failure: cause("graph.service_unavailable") });
    const failedDetail = await json<WarningDetailDto>(await call(`/warnings/object/${dora}`));
    expect(failedDetail.state).toBe("failed");
    const run = await backup(dora, "completed", new Date(later.getTime() + 60_000), 1);
    await failItems(run, dora, [{ ref: "mail/Inbox/old.eml", code: null }]);
    const detail = await json<WarningDetailDto>(await call(`/warnings/object/${dora}`));
    expect(detail.state).toBe("open");
    expect(detail.newCauses).toEqual([]);
    expect(detail.acknowledgement?.superseded).toBe(true);
  });

  it("revokes an acknowledgement, audited, and 404s when there is none", async () => {
    const response = await call(`/warnings/machine/${machine}/acknowledgement`, {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
    const detail = await json<WarningDetailDto>(await call(`/warnings/machine/${machine}`));
    expect(detail.state).toBe("open");
    expect(detail.acknowledgement).toBeNull();
    expect(detail.items[0]).toMatchObject({
      ref: "/srv/db/locked.mdf",
      location: { folder: "srv/db", name: "locked.mdf" },
      failure: { code: "endpoint.read_error" },
    });
    const audits = await owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, WARNING_AUDIT_ACTIONS.revoked), eq(auditLog.target, machine)));
    expect(audits).toHaveLength(1);
    const again = await call(`/warnings/machine/${machine}/acknowledgement`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("keeps tenants apart", async () => {
    // Another tenant sees nothing of Contoso's, cannot acknowledge or revoke it.
    const foreign = await json<WarningListDto>(await call("/warnings", { tenant: fabrikam }));
    expect(foreign.items).toEqual([]);
    expect((await call(`/warnings/object/${objects.anna}`, { tenant: fabrikam })).status).toBe(404);
    const result = await json<AcknowledgeResultDto>(
      await acknowledge([{ kind: "object", id: objects.dora as string }], "x", fabrikam),
    );
    expect(result.acknowledged).toEqual([]);
    expect(result.skipped).toEqual([{ kind: "object", id: objects.dora, reason: "not_found" }]);
    const revoke = await call(`/warnings/object/${objects.dora}/acknowledgement`, {
      method: "DELETE",
      tenant: fabrikam,
    });
    expect(revoke.status).toBe(404);
    const rows = await owner
      .select()
      .from(warningAcknowledgements)
      .where(eq(warningAcknowledgements.tenantId, fabrikam));
    expect(rows).toEqual([]);
  });

  it("is for administrators only", async () => {
    expect((await call("/warnings", { role: "tenant_user" })).status).toBe(403);
    expect(
      (
        await call("/warnings/acknowledge", {
          role: "tenant_user",
          method: "POST",
          body: { targets: [{ kind: "object", id: objects.anna }] },
        })
      ).status,
    ).toBe(403);
  });

  it("validates the request", async () => {
    expect((await call("/warnings/mailbox/not-a-uuid")).status).toBe(422);
    const tooLong = await acknowledge(
      [{ kind: "object", id: objects.anna as string }],
      "x".repeat(1001),
    );
    expect(tooLong.status).toBe(422);
  });
});
