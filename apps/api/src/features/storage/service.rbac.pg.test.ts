/**
 * Postgres-backed RBAC coverage for storage-migration actions (docs/
 * STORAGE.md, "RBAC and audit"): starting a "replace the primary" migration
 * (POST /targets with a `migrationMode`), cancelling one and retrying a
 * failed one, through the same Hono routes the web UI calls. Only
 * `tenant_admin` and `provider_admin` may do any of the three; a `tenant_user`
 * is refused, and an admin signed in for a different tenant finds nothing to
 * act on (Row Level Security plus the explicit tenant filter every query in
 * `service.ts` carries). Every allowed step lands in the tenant's audit log.
 *
 * The routes run on the application role that Row Level Security binds
 * (src/testing/database-roles.ts); the suite's own handle is the owner, for
 * fixtures and assertions. Authentication is replaced by a stand-in that
 * admits a role named in a test header and refuses a role below the route's
 * minimum, the same way `requireTenant` does (see schedules.pg.test.ts);
 * `requireTenant` itself is covered by the session tests.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_storage_rbac_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDek, kekFromBase64, wrapDek } from "@restow/core";
import {
  type Database,
  auditLog,
  createDb,
  jobs,
  providers,
  storageMigrations,
  storageTargets,
  tenantKeys,
  tenants,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import PgBoss from "pg-boss";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import type { StorageMigrationDto, StorageTargetDto } from "./dto.js";

const DATABASE = "restow_api_storage_rbac_test";
const ROLE_HEADER = "x-test-role";

/** Stand-in for requireTenant(minimum): the role comes from a header, the tenant from X-Restow-Tenant. */
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

/** An S3 target with no custom endpoint (real AWS): `enforceEndpointPolicy` skips its DNS check, so a plain tenant admin can create one too. */
function startBody(name: string): Record<string, unknown> {
  return {
    kind: "s3",
    name,
    role: "primary",
    config: { bucket: `contoso-${name}`.toLowerCase() },
    credentials: {
      accessKeyId: "AKIAEXAMPLEACCESSKEY",
      secretAccessKey: "example-secret-access-1",
    },
    migrationMode: "move",
  };
}

/**
 * A "keep" start body: local, not S3, since `verifyKeepTarget` (service.ts)
 * really probes the location with a write/read/delete before the switch
 * commits, and only a real writable directory (`keepRoot`, below) passes
 * that — a fake `/mnt` path or a live S3 endpoint would not.
 */
function keepStartBody(name: string, basePath: string): Record<string, unknown> {
  return {
    kind: "local",
    name,
    role: "primary",
    config: { basePath },
    migrationMode: "keep",
  };
}

describe.skipIf(!testDatabaseAdminUrl)("storage migration RBAC against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let keepRoot: string;
  const adminId = randomUUID();

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    // The API's shared handles and configuration read the environment on import.
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    const masterKey = randomBytes(32).toString("base64");
    process.env.RESTOW_MASTER_KEY = masterKey;
    owner = createDb(url);
    appDb = createDb(roles.appUrl);

    // pg-boss owns its schema as the installation role (apps/worker/src/index.ts);
    // the API only ever enqueues into it, on the application role.
    const boss = new PgBoss({ connectionString: roles.providerUrl });
    await boss.start();
    await boss.createQueue("storage_migration");
    await boss.stop({ graceful: false, wait: true });

    const { buildStorageRoutes } = await import("./routes.js");
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
    // "start" creates an S3 target with credentials (storeSecret), which needs
    // a tenant data-encryption key first (apps/api/src/lib/secrets.ts).
    const kek = kekFromBase64(masterKey);
    for (const tenantId of [contoso, fabrikam]) {
      await owner.insert(tenantKeys).values({
        tenantId,
        keyVersion: 1,
        encryptedDek: wrapDek(kek, generateDek(1)).toString("base64"),
        kekId: "env:RESTOW_MASTER_KEY",
      });
    }

    app = new Hono();
    app.onError(errorHandler);
    app.route(
      "/storage",
      buildStorageRoutes({ db: appDb, requireAdmin: testTenantAccess("tenant_admin", adminId) }),
    );

    // A "keep" switch probes the new location with a real write/read/delete
    // (verifyKeepTarget, service.ts) before it commits: a writable directory,
    // not a fake path or a live S3 endpoint.
    keepRoot = await mkdtemp(join(tmpdir(), "restow-storage-rbac-"));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
    if (keepRoot) {
      await rm(keepRoot, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    for (const tenantId of [contoso, fabrikam]) {
      await owner.delete(jobs).where(eq(jobs.tenantId, tenantId));
      await owner.delete(storageMigrations).where(eq(storageMigrations.tenantId, tenantId));
      await owner.delete(storageTargets).where(eq(storageTargets.tenantId, tenantId));
    }
  });

  function call(
    tenantId: string,
    method: string,
    path: string,
    options: { role?: Role; body?: unknown } = {},
  ) {
    const headers: Record<string, string> = {
      "x-restow-tenant": tenantId,
      [ROLE_HEADER]: options.role ?? "tenant_admin",
      "x-forwarded-for": "203.0.113.9",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    return app.request(`/storage${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async function auditEntries(tenantId: string, action: string, target: string) {
    return owner
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, action),
          eq(auditLog.target, target),
        ),
      );
  }

  /** A primary local target straight in the database, so "start" has something to replace. */
  async function seedPrimary(tenantId: string): Promise<void> {
    await owner.insert(storageTargets).values({
      tenantId,
      kind: "local",
      role: "primary",
      config: { basePath: `/mnt/${randomUUID()}` },
    });
  }

  /** A queued "move" migration, started for real through the route (as an admin), for cancel/retry fixtures. */
  async function seedQueuedMigration(tenantId: string): Promise<string> {
    await seedPrimary(tenantId);
    const response = await call(tenantId, "POST", "/targets", {
      role: "tenant_admin",
      body: startBody(`Queued-${randomUUID()}`),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return ((await response.json()) as StorageTargetDto).id;
  }

  /** A failed "move" migration set up directly, so retry has something to act on. */
  async function seedFailedMigration(tenantId: string): Promise<string> {
    const [primary] = await owner
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "primary",
        config: { basePath: `/mnt/${randomUUID()}` },
      })
      .returning();
    const [destination] = await owner
      .insert(storageTargets)
      .values({
        tenantId,
        kind: "local",
        role: "copy",
        config: { basePath: `/mnt/${randomUUID()}` },
      })
      .returning();
    await owner.insert(storageMigrations).values({
      tenantId,
      sourceTargetId: primary?.id as string,
      destinationTargetId: destination?.id as string,
      mode: "move",
      status: "failed",
      errorMessage: "S3StorageBackend: connect ECONNREFUSED",
    });
    return destination?.id as string;
  }

  describe("starting a migration (POST /targets)", () => {
    it("refuses a tenant user; nothing beyond the seeded primary is created", async () => {
      await seedPrimary(contoso);
      const response = await call(contoso, "POST", "/targets", {
        role: "tenant_user",
        body: startBody("Refused"),
      });
      expect(response.status).toBe(403);
      const targets = await owner
        .select()
        .from(storageTargets)
        .where(eq(storageTargets.tenantId, contoso));
      expect(targets).toHaveLength(1);
      expect(
        await owner.select().from(storageMigrations).where(eq(storageMigrations.tenantId, contoso)),
      ).toHaveLength(0);
    });

    it("lets a tenant admin start one, audited", async () => {
      await seedPrimary(contoso);
      const response = await call(contoso, "POST", "/targets", {
        role: "tenant_admin",
        body: startBody("TenantAdminStart"),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const dto = (await response.json()) as StorageTargetDto;
      expect(dto.migration).toMatchObject({ mode: "move", status: "queued" });
      const [entry] = await auditEntries(contoso, "storage.migration.started", dto.id);
      expect(entry).toBeDefined();
    });

    it("lets a provider admin start one too, audited", async () => {
      await seedPrimary(contoso);
      const response = await call(contoso, "POST", "/targets", {
        role: "provider_admin",
        body: startBody("ProviderAdminStart"),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const dto = (await response.json()) as StorageTargetDto;
      const [entry] = await auditEntries(contoso, "storage.migration.started", dto.id);
      expect(entry).toBeDefined();
    });

    it("refuses a tenant user starting a 'keep' switch; the primary is unchanged", async () => {
      await seedPrimary(contoso);
      const response = await call(contoso, "POST", "/targets", {
        role: "tenant_user",
        body: keepStartBody("KeepRefused", join(keepRoot, `refused-${randomUUID()}`)),
      });
      expect(response.status).toBe(403);
      const [primary] = await owner
        .select()
        .from(storageTargets)
        .where(and(eq(storageTargets.tenantId, contoso), eq(storageTargets.role, "primary")));
      expect(primary).toBeDefined();
    });

    // A tenant admin passes the migration RBAC gate for "keep" exactly like for
    // "move" (both run on the same POST /targets, `requireTenant("tenant_admin")`),
    // but a local target is server infrastructure a tenant admin never manages
    // (`local_requires_provider_admin`, unrelated to the migration mode and not
    // owned by this item) — a different, more specific refusal than the plain
    // role gate below proves the two rules compose rather than one hiding the
    // other. `keepTargetUnreachable` never runs: local-ownership is checked
    // first, before the reachability probe a "keep" switch would otherwise do.
    it("refuses a tenant admin a 'keep' switch onto a local target, for local-target ownership, not the migration gate", async () => {
      await seedPrimary(contoso);
      const response = await call(contoso, "POST", "/targets", {
        role: "tenant_admin",
        body: keepStartBody("KeepTenantAdmin", join(keepRoot, `tenant-admin-${randomUUID()}`)),
      });
      const body = (await response.clone().json()) as { code?: string };
      expect(response.status, await response.clone().text()).toBe(403);
      expect(body.code).toBe("local_requires_provider_admin");
      const [primary] = await owner
        .select()
        .from(storageTargets)
        .where(and(eq(storageTargets.tenantId, contoso), eq(storageTargets.role, "primary")));
      expect(primary).toBeDefined();
    });

    it("lets a provider admin switch with 'keep' too, audited", async () => {
      await seedPrimary(contoso);
      const response = await call(contoso, "POST", "/targets", {
        role: "provider_admin",
        body: keepStartBody("KeepProviderAdmin", join(keepRoot, `provider-admin-${randomUUID()}`)),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const dto = (await response.json()) as StorageTargetDto;
      expect(dto.migration).toMatchObject({ mode: "keep", status: "completed" });
      const [entry] = await auditEntries(contoso, "storage.migration.started", dto.id);
      expect(entry).toBeDefined();
    });
  });

  describe("cancelling a migration (POST /targets/:id/migration/cancel)", () => {
    it("refuses a tenant user, leaving the migration queued", async () => {
      const destinationId = await seedQueuedMigration(contoso);
      const response = await call(contoso, "POST", `/targets/${destinationId}/migration/cancel`, {
        role: "tenant_user",
      });
      expect(response.status).toBe(403);
      const [migration] = await owner
        .select()
        .from(storageMigrations)
        .where(eq(storageMigrations.destinationTargetId, destinationId));
      expect(migration?.status).toBe("queued");
    });

    it("finds nothing for another tenant's admin, leaving the migration queued", async () => {
      const destinationId = await seedQueuedMigration(contoso);
      const response = await call(fabrikam, "POST", `/targets/${destinationId}/migration/cancel`, {
        role: "tenant_admin",
      });
      expect(response.status).toBe(404);
      const [migration] = await owner
        .select()
        .from(storageMigrations)
        .where(eq(storageMigrations.destinationTargetId, destinationId));
      expect(migration?.status).toBe("queued");
    });

    it("lets a tenant admin cancel, audited", async () => {
      const destinationId = await seedQueuedMigration(contoso);
      const response = await call(contoso, "POST", `/targets/${destinationId}/migration/cancel`, {
        role: "tenant_admin",
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as StorageMigrationDto;
      expect(body.status).toBe("cancelled");
      const [entry] = await auditEntries(contoso, "storage.migration.cancelled", destinationId);
      expect(entry).toBeDefined();
    });

    it("lets a provider admin cancel too, audited", async () => {
      const destinationId = await seedQueuedMigration(contoso);
      const response = await call(contoso, "POST", `/targets/${destinationId}/migration/cancel`, {
        role: "provider_admin",
      });
      expect(response.status).toBe(200);
      const [entry] = await auditEntries(contoso, "storage.migration.cancelled", destinationId);
      expect(entry).toBeDefined();
    });
  });

  describe("retrying a failed migration (POST /targets/:id/migration/retry)", () => {
    it("refuses a tenant user, leaving the migration failed", async () => {
      const destinationId = await seedFailedMigration(contoso);
      const response = await call(contoso, "POST", `/targets/${destinationId}/migration/retry`, {
        role: "tenant_user",
      });
      expect(response.status).toBe(403);
      const [migration] = await owner
        .select()
        .from(storageMigrations)
        .where(eq(storageMigrations.destinationTargetId, destinationId));
      expect(migration?.status).toBe("failed");
    });

    it("finds nothing for another tenant's admin, leaving the migration failed", async () => {
      const destinationId = await seedFailedMigration(contoso);
      const response = await call(fabrikam, "POST", `/targets/${destinationId}/migration/retry`, {
        role: "tenant_admin",
      });
      expect(response.status).toBe(404);
      const [migration] = await owner
        .select()
        .from(storageMigrations)
        .where(eq(storageMigrations.destinationTargetId, destinationId));
      expect(migration?.status).toBe("failed");
    });

    it("lets a tenant admin retry, audited", async () => {
      const destinationId = await seedFailedMigration(contoso);
      const response = await call(contoso, "POST", `/targets/${destinationId}/migration/retry`, {
        role: "tenant_admin",
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as StorageMigrationDto;
      expect(body.status).toBe("queued");
      const [entry] = await auditEntries(contoso, "storage.migration.started", destinationId);
      expect(entry).toBeDefined();
      expect(entry?.details).toMatchObject({ retry: true });
    });

    it("lets a provider admin retry too, audited", async () => {
      const destinationId = await seedFailedMigration(contoso);
      const response = await call(contoso, "POST", `/targets/${destinationId}/migration/retry`, {
        role: "provider_admin",
      });
      expect(response.status).toBe(200);
      const [entry] = await auditEntries(contoso, "storage.migration.started", destinationId);
      expect(entry).toBeDefined();
    });
  });
});
