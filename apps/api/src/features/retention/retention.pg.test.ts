/**
 * Postgres-backed tests of the retention surface, through the same Hono
 * routes the web UI calls: CRUD for the tenant default and per-object
 * overrides, 422 problems naming the field, tenant isolation under Row Level
 * Security, audit entries written in the same transaction as the change, and
 * a preview computed by the exact @restow/core function the worker's
 * retention handler runs, against restore points, a legal hold and a
 * recovery-readiness check inserted the same way those features would.
 *
 * This is *not* the parity test between the preview and what the worker
 * actually removes — the two loaders below duplicate the worker's query
 * shape by hand, so a real divergence between them (a column one side reads
 * and the other does not, say) would pass here unnoticed. That test runs the
 * worker's own `pgRetentionStore` for real, against a Postgres database, in
 * apps/worker/src/handlers/retention.pg.test.ts.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_retention_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { type LegalHoldScope, planRetentionRun, presetTiers, totalBytes } from "@restow/core";
import {
  type Database,
  auditLog,
  createDb,
  legalHolds,
  protectedObjects,
  providers,
  retentionPolicies,
  snapshots,
  sources,
  tenants,
  verifyReports,
} from "@restow/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../auth.js";
import { type Role, type TenantRole, roleSatisfies } from "../../middleware/rbac.js";
import type { TenantEnv } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { RetentionPolicyDto, RetentionPreviewDto } from "./service.js";

const DATABASE = "restow_api_retention_test";
const ROLE_HEADER = "x-test-role";

function testTenantAccess(minimum: TenantRole, userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    const role = (c.req.header(ROLE_HEADER) ?? "tenant_admin") as Role;
    if (!roleSatisfies(role, minimum)) {
      throw new ProblemError(403, "Insufficient role", {
        detail: `This endpoint requires the ${minimum} role.`,
      });
    }
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", role);
    c.set("user", { id: userId, email: `${role}@contoso.example` } as unknown as SessionUser);
    await next();
  };
}

interface Problem {
  status: number;
  field?: string;
  code?: string;
  issues?: { path: string[] }[];
}

const NOW = new Date("2026-06-01T12:00:00.000Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

describe.skipIf(!testDatabaseAdminUrl)("retention against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let mailboxA: string;
  let mailboxB: string;
  let foreignMailbox: string;
  const adminId = randomUUID();

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);

    const { buildRetentionRoutes } = await import("./routes.js");
    const { errorHandler } = await import("../../problem.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    const [m365] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    const [imap] = await owner
      .insert(sources)
      .values({ tenantId: fabrikam, kind: "imap", name: "Fabrikam IMAP", status: "active" })
      .returning();
    const [a] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: contoso,
        sourceId: m365?.id ?? "",
        kind: "mailbox",
        externalId: "anna@contoso.example",
        displayName: "Anna Berg",
      })
      .returning();
    mailboxA = a?.id ?? "";
    const [b] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: contoso,
        sourceId: m365?.id ?? "",
        kind: "mailbox",
        externalId: "bo@contoso.example",
        displayName: "Bo Nilsson",
      })
      .returning();
    mailboxB = b?.id ?? "";
    const [foreign] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: fabrikam,
        sourceId: imap?.id ?? "",
        kind: "imap",
        externalId: "ben@fabrikam.example",
      })
      .returning();
    foreignMailbox = foreign?.id ?? "";

    app = new Hono();
    app.onError(errorHandler);
    app.route(
      "/retention",
      buildRetentionRoutes({
        db: appDb,
        requireAdmin: testTenantAccess("tenant_admin", adminId),
        now: () => NOW,
      }),
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
    method: string,
    path: string,
    options: { tenant?: string; role?: Role; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {
      "x-restow-tenant": options.tenant ?? contoso,
      [ROLE_HEADER]: options.role ?? "tenant_admin",
      "x-forwarded-for": "192.0.2.10",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return app.request(`/retention${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function auditEntries(action: string, target: string) {
    return owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.target, target)));
  }

  async function create(
    body: Record<string, unknown>,
    tenant = contoso,
  ): Promise<RetentionPolicyDto> {
    const response = await call("POST", "/policies", { body, tenant });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as RetentionPolicyDto;
  }

  it("creates the tenant default, audits it and shows the resolved tiers", async () => {
    const policy = await create({ name: "Standard", preset: "default", protectedObjectIds: null });
    expect(policy).toMatchObject({
      name: "Standard",
      preset: "default",
      isDefault: true,
      cutoffDays: 365,
      protectedObjects: [],
    });
    expect(policy.tiers).toEqual([
      { fromDays: 0, toDays: 30, keepEveryDays: 0 },
      { fromDays: 30, toDays: 90, keepEveryDays: 1 },
      { fromDays: 90, toDays: 365, keepEveryDays: 7 },
    ]);

    const [entry] = await auditEntries("retention_policy.created", policy.id);
    expect(entry).toMatchObject({
      tenantId: contoso,
      actorUserId: adminId,
      targetType: "retention_policy",
      ip: "192.0.2.10",
    });
    expect(entry?.details).toMatchObject({ name: "Standard", preset: "default", isDefault: true });

    const list = await call("GET", "/policies");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: RetentionPolicyDto[]; recommendedPreset: string };
    expect(body.items.map((item) => item.id)).toContain(policy.id);
    expect(body.recommendedPreset).toBe("default");

    // Clean up so later tests can create their own default.
    await call("DELETE", `/policies/${policy.id}`);
  });

  it("refuses a second tenant-wide default", async () => {
    const first = await create({ name: "Standard", preset: "30d", protectedObjectIds: null });
    const response = await call("POST", "/policies", {
      body: { name: "Another", preset: "1y", protectedObjectIds: null },
    });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as Problem;
    expect(problem.code).toBe("default_exists");
    await call("DELETE", `/policies/${first.id}`);
  });

  it("creates a per-object override, naming the object and its restore-point wording", async () => {
    const override = await create({
      name: "Bo — keep everything",
      preset: "keep_all",
      protectedObjectIds: [mailboxB],
    });
    expect(override.isDefault).toBe(false);
    expect(override.protectedObjects).toEqual([
      { id: mailboxB, name: "Bo Nilsson", kind: "mailbox" },
    ]);

    // A second policy cannot also claim the same object.
    const conflict = await call("POST", "/policies", {
      body: { name: "Conflict", preset: "7y", protectedObjectIds: [mailboxB] },
    });
    expect(conflict.status).toBe(422);
    expect(((await conflict.json()) as Problem).code).toBe("object_already_scoped");

    // Nor an object that does not exist in this tenant.
    const missing = await call("POST", "/policies", {
      body: { name: "Missing", preset: "7y", protectedObjectIds: [randomUUID()] },
    });
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as Problem).code).toBe("object_not_found");

    // Nor an object of another tenant, even with a real id.
    const foreign = await call("POST", "/policies", {
      body: { name: "Foreign", preset: "7y", protectedObjectIds: [foreignMailbox] },
    });
    expect(foreign.status).toBe(422);

    await call("DELETE", `/policies/${override.id}`);
  });

  it("refuses to preview a draft that targets an object another policy already scopes", async () => {
    const existing = await create({
      name: "Bo — keep everything",
      preset: "keep_all",
      protectedObjectIds: [mailboxB],
    });

    // A new draft claiming the same object must surface the conflict the
    // save would hit, not silently preview under the existing policy.
    const conflict = await call("POST", "/policies/preview", {
      body: { preset: "7y", protectedObjectIds: [mailboxB] },
    });
    expect(conflict.status).toBe(422);
    expect(((await conflict.json()) as Problem).code).toBe("object_already_scoped");

    // Editing that same policy (excluding itself) must still preview fine.
    const editingItself = await call("POST", "/policies/preview", {
      body: { id: existing.id, preset: "7y", protectedObjectIds: [mailboxB] },
    });
    expect(editingItself.status, await editingItself.clone().text()).toBe(200);

    await call("DELETE", `/policies/${existing.id}`);
  });

  it("rejects a custom policy with a gap or a preset request without a name", async () => {
    const gap = await call("POST", "/policies", {
      body: {
        name: "Custom",
        preset: "custom",
        protectedObjectIds: null,
        tiers: [
          { fromDays: 0, toDays: 10, keepEveryDays: 0 },
          { fromDays: 20, toDays: null, keepEveryDays: 1 },
        ],
      },
    });
    expect(gap.status).toBe(422);
    const problem = (await gap.json()) as Problem;
    expect(problem.field).toBe("tiers");
    expect(problem.issues?.[0]?.path).toEqual(["tiers"]);

    const noName = await call("POST", "/policies", {
      body: { preset: "30d", protectedObjectIds: null },
    });
    expect(noName.status).toBe(422);
    expect(((await noName.json()) as Problem).issues?.[0]?.path).toEqual(["name"]);
  });

  it("updates and deletes a policy, both audited", async () => {
    const policy = await create({ name: "Original", preset: "90d", protectedObjectIds: null });
    const patched = await call("PATCH", `/policies/${policy.id}`, {
      body: { name: "Renamed", preset: "1y" },
    });
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as RetentionPolicyDto;
    expect(patchedBody).toMatchObject({ name: "Renamed", preset: "1y", cutoffDays: 365 });
    const [updateEntry] = await auditEntries("retention_policy.updated", policy.id);
    expect(updateEntry?.details).toMatchObject({ name: "Renamed", preset: "1y" });

    const deleted = await call("DELETE", `/policies/${policy.id}`);
    expect(deleted.status).toBe(204);
    const [deleteEntry] = await auditEntries("retention_policy.deleted", policy.id);
    expect(deleteEntry).toBeTruthy();
    const after = await owner
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.id, policy.id));
    expect(after).toEqual([]);
  });

  it("renames a legacy row (no preset, its own keepDays) without requiring tiers", async () => {
    // A row saved before presets existed: no `preset` key, no `tiers`, just
    // its own flat keepDays — as the dashboard widget and the worker still
    // read it (parseSnapshotPolicy's legacy fallback).
    const [legacy] = await owner
      .insert(retentionPolicies)
      .values({
        tenantId: contoso,
        name: "Old policy",
        isDefault: true,
        appliesTo: { target: "snapshots", keepDays: 90 },
      })
      .returning();
    const id = legacy?.id as string;

    const renamed = await call("PATCH", `/policies/${id}`, {
      body: { name: "Old policy, renamed" },
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    const body = (await renamed.json()) as RetentionPolicyDto;
    expect(body.name).toBe("Old policy, renamed");
    expect(body.cutoffDays).toBe(90);

    await call("DELETE", `/policies/${id}`);
  });

  it("never lets an archive default policy block, or be listed alongside, the snapshot default", async () => {
    await owner.insert(retentionPolicies).values({
      tenantId: contoso,
      name: "Archive default",
      isDefault: true,
      years: 10,
      appliesTo: { target: "archive" },
    });

    // The archive module's own default must not trip "a tenant already has one".
    const policy = await create({ name: "Standard", preset: "30d", protectedObjectIds: null });

    // Nor does the snapshot list surface the archive row.
    const list = await call("GET", "/policies");
    const body = (await list.json()) as { items: RetentionPolicyDto[] };
    expect(body.items.map((item) => item.name)).not.toContain("Archive default");

    await call("DELETE", `/policies/${policy.id}`);
    await owner
      .delete(retentionPolicies)
      .where(
        and(eq(retentionPolicies.tenantId, contoso), eq(retentionPolicies.name, "Archive default")),
      );
  });

  it("keeps tenants apart: Fabrikam sees none of Contoso's policies and cannot reach its objects", async () => {
    const policy = await create({ name: "Contoso only", preset: "30d", protectedObjectIds: null });
    const list = await call("GET", "/policies", { tenant: fabrikam });
    expect((await list.json()) as { items: unknown[] }).toMatchObject({ items: [] });

    const cannotCreate = await call("POST", "/policies", {
      tenant: fabrikam,
      body: { name: "Cross-tenant", preset: "30d", protectedObjectIds: [mailboxA] },
    });
    expect(cannotCreate.status).toBe(422); // mailboxA is not in Fabrikam

    const cannotEdit = await call("PATCH", `/policies/${policy.id}`, {
      tenant: fabrikam,
      body: { name: "Hijacked" },
    });
    expect(cannotEdit.status).toBe(404);

    await call("DELETE", `/policies/${policy.id}`);
  });

  it("refuses tenant users (retention is tenant-administrator only)", async () => {
    const response = await call("GET", "/policies", { role: "tenant_user" });
    expect(response.status).toBe(403);
  });

  it("previews exactly what a retention run would remove, honouring the verified and legal-hold guards", async () => {
    // v1: the sole verified restore point, past every tier — must survive.
    // s2: past the tier's cutoff, unverified — due.
    // s3: newest, unverified — always kept.
    const rows = await owner
      .insert(snapshots)
      .values([
        {
          tenantId: contoso,
          protectedObjectId: mailboxA,
          sequence: 1,
          manifestPath: "v1",
          status: "active",
          byteSize: 1000,
          completedAt: daysAgo(400),
        },
        {
          tenantId: contoso,
          protectedObjectId: mailboxA,
          sequence: 2,
          manifestPath: "s2",
          status: "active",
          byteSize: 2000,
          completedAt: daysAgo(50),
        },
        {
          tenantId: contoso,
          protectedObjectId: mailboxA,
          sequence: 3,
          manifestPath: "s3",
          status: "active",
          byteSize: 500,
          completedAt: daysAgo(1),
        },
        // Bo's mailbox is under legal hold; its overdue restore point is set aside.
        {
          tenantId: contoso,
          protectedObjectId: mailboxB,
          sequence: 1,
          manifestPath: "h1",
          status: "active",
          byteSize: 4000,
          completedAt: daysAgo(400),
        },
        {
          tenantId: contoso,
          protectedObjectId: mailboxB,
          sequence: 2,
          manifestPath: "h2",
          status: "active",
          byteSize: 4000,
          completedAt: daysAgo(1),
        },
      ])
      .returning({ id: snapshots.id, manifestPath: snapshots.manifestPath });
    const v1 = rows.find((row) => row.manifestPath === "v1");
    await owner.insert(verifyReports).values({
      tenantId: contoso,
      protectedObjectId: mailboxA,
      snapshotId: v1?.id ?? null,
      kind: "verify",
      recoveryReadiness: "green",
      checkedAt: daysAgo(399),
    });
    await owner.insert(legalHolds).values({
      tenantId: contoso,
      reason: "Litigation",
      protectedObjectId: mailboxB,
      active: true,
    });

    const response = await call("POST", "/policies/preview", {
      body: { preset: "30d", protectedObjectIds: null },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const preview = (await response.json()) as RetentionPreviewDto;
    // Only s2 (mailboxA) is actually due: v1 is the sole verified point, s3 is
    // the newest, and mailboxB's overdue point is held.
    expect(preview).toEqual({
      objects: 1,
      restorePoints: 1,
      bytesLogical: 2000,
      heldRestorePoints: 1,
    });
  });

  it("previews exactly what a direct run of the retention rule finds, including an in-flight backup", async () => {
    // apps/worker/src/handlers/retention.ts is a separate app (not a package
    // this one may depend on, per docs/ARCHITECTURE.md), so this loads the
    // tenant's restore point history and legal holds with the exact same
    // filters pgRetentionStore uses there, and runs the same @restow/core
    // `planRetentionRun` the worker runs, so a divergence between the two
    // loaders (e.g. an in-flight backup counted as "newest" on one side but
    // not the other) fails here instead of only showing up in production.
    const objectId = mailboxA;
    await owner.insert(snapshots).values([
      // In-flight: no manifest yet, must not be treated as the newest restore
      // point by either loader.
      {
        tenantId: contoso,
        protectedObjectId: objectId,
        sequence: 900,
        manifestPath: null,
        status: "active",
        byteSize: 999,
        completedAt: null,
      },
      {
        tenantId: contoso,
        protectedObjectId: objectId,
        sequence: 901,
        manifestPath: "parity-1",
        status: "active",
        byteSize: 1500,
        completedAt: daysAgo(200),
      },
      {
        tenantId: contoso,
        protectedObjectId: objectId,
        sequence: 902,
        manifestPath: "parity-2",
        status: "active",
        byteSize: 800,
        completedAt: daysAgo(1),
      },
    ]);

    const rows = await owner
      .select({
        id: snapshots.id,
        protectedObjectId: snapshots.protectedObjectId,
        sequence: snapshots.sequence,
        byteSize: snapshots.byteSize,
        completedAt: snapshots.completedAt,
      })
      .from(snapshots)
      .where(
        and(
          eq(snapshots.tenantId, contoso),
          eq(snapshots.status, "active"),
          isNotNull(snapshots.manifestPath),
        ),
      );
    const ids = rows.map((row) => row.id);
    const verifiedRows =
      ids.length === 0
        ? []
        : await owner
            .selectDistinct({ snapshotId: verifyReports.snapshotId })
            .from(verifyReports)
            .where(
              and(
                eq(verifyReports.tenantId, contoso),
                inArray(verifyReports.snapshotId, ids),
                eq(verifyReports.recoveryReadiness, "green"),
              ),
            );
    const verified = new Set(
      verifiedRows.flatMap((row) => (row.snapshotId ? [row.snapshotId] : [])),
    );
    const history = rows.map((row) => ({ ...row, verified: verified.has(row.id) }));

    const holdRows = await owner
      .select({ protectedObjectId: legalHolds.protectedObjectId })
      .from(legalHolds)
      .where(and(eq(legalHolds.tenantId, contoso), eq(legalHolds.active, true)));
    const holdIds = new Set<string>();
    let tenantWide = false;
    for (const row of holdRows) {
      if (row.protectedObjectId === null) {
        tenantWide = true;
      } else {
        holdIds.add(row.protectedObjectId);
      }
    }
    const holds: LegalHoldScope = { tenantWide, protectedObjectIds: holdIds };

    const draft = {
      policyId: "draft",
      tiers: presetTiers("30d"),
      protectedObjectIds: null,
      isDefault: true,
    };
    const directPlan = planRetentionRun(history, [draft], holds, NOW);

    const response = await call("POST", "/policies/preview", {
      body: { preset: "30d", protectedObjectIds: null },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const preview = (await response.json()) as RetentionPreviewDto;

    expect(preview.restorePoints).toBe(directPlan.expired.length);
    expect(preview.objects).toBe(
      new Set(directPlan.expired.map((snapshot) => snapshot.protectedObjectId)).size,
    );
    expect(preview.bytesLogical).toBe(totalBytes(directPlan.expired));
    expect(preview.heldRestorePoints).toBe(directPlan.held.length);
    // The in-flight backup must never appear as due: it has no manifest, so
    // neither loader admits it as a candidate in the first place.
    expect(directPlan.expired.some((snapshot) => snapshot.byteSize === 999)).toBe(false);
  });
});
