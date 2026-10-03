/**
 * Postgres-backed tests of the installation's default storage as the
 * installation page uses it: the view (location from the environment, the
 * tenants that keep their data on the default, the last test), the test itself
 * against a real directory, and its record in the installation audit chain.
 *
 * The API's pools run on the provisioned database roles, as in production
 * (src/testing/database-roles.ts): the installation chain is only readable
 * through the installation role.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_defstorage_test` is recreated there and
 * dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBackend } from "@restow/core";
import {
  type Database,
  auditLog,
  createDb,
  providers,
  secrets,
  settings,
  storageTargets,
  tenants,
} from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_defstorage_test";

type Service = typeof import("./default-storage.js");
type DefaultStorageDeps = import("./default-storage.js").DefaultStorageDeps;

const actor = { id: "provider-admin", email: "admin@provider.test", ip: "192.0.2.10" };

describe.skipIf(!testDatabaseAdminUrl)("default storage against Postgres", () => {
  let db: Database;
  let roles: TestDatabaseRoles | undefined;
  let service: Service;
  let providerDb: Database;
  let root: string;
  let withoutOwnTarget: string;
  let withOwnTarget: string;

  const tested = () =>
    db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "settings.default_storage.tested"), isNull(auditLog.tenantId)),
      );

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);
    root = await mkdtemp(join(tmpdir(), "restow-default-storage-"));
    await db.insert(settings).values({
      singleton: true,
      operatingMode: "public",
      publicUrl: "https://restow.example.com",
    });
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const created = await db
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
        { providerId: provider?.id ?? "", name: "Northwind", slug: "northwind" },
      ])
      .returning();
    withoutOwnTarget = created[0]?.id ?? "";
    withOwnTarget = created[1]?.id ?? "";
    await db.insert(storageTargets).values({
      tenantId: withOwnTarget,
      kind: "local",
      role: "primary",
      config: { basePath: join(root, "fabrikam") },
    });
    // A copy is not a primary: the tenant still keeps its data on the default.
    await db.insert(storageTargets).values({
      tenantId: withoutOwnTarget,
      kind: "local",
      role: "copy",
      config: { basePath: join(root, "contoso-copy") },
    });
    service = await import("./default-storage.js");
    providerDb = (await import("../../db.js")).providerDb;
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
    await rm(root, { recursive: true, force: true });
  });

  it("describes the default from the environment and counts the tenants that use it", async () => {
    const view = await service.getDefaultStorage(providerDb, {
      env: { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: join(root, "chunks") },
    });
    expect(view).toMatchObject({
      configured: true,
      kind: "local",
      location: join(root, "chunks"),
      copyLocation: null,
      tenants: { total: 3, usingDefault: 2 },
      lastTest: null,
    });
  });

  it("shows the copy path of the environment", async () => {
    const view = await service.getDefaultStorage(providerDb, {
      env: {
        STORAGE_LOCAL_PATH: join(root, "chunks"),
        STORAGE_COPY_LOCAL_PATH: join(root, "copy"),
      },
    });
    expect(view.copyLocation).toBe(join(root, "copy"));
  });

  it("reports an invalid environment instead of throwing", async () => {
    const view = await service.getDefaultStorage(providerDb, {
      env: { STORAGE_TARGET: "ftp" },
    });
    expect(view).toMatchObject({ configured: false, kind: null, location: null });
  });

  it("refuses to test a default the environment does not describe", async () => {
    await expect(
      service.testDefaultStorage(providerDb, actor, { env: { STORAGE_TARGET: "ftp" } }),
    ).rejects.toMatchObject({
      status: 503,
      type: "urn:restow:problem:settings-default-storage-misconfigured",
    });
    expect(await tested()).toHaveLength(0);
  });

  it("tests a default whose directory does not exist yet and records it in the installation chain", async () => {
    const path = join(root, "fresh", "chunks");
    const result = await service.testDefaultStorage(providerDb, actor, {
      env: { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: path },
      now: () => new Date("2026-10-02T10:00:00.000Z"),
    });
    expect(result.probe).toMatchObject({ ok: true, failedStep: null });
    expect(result.objectLock).toMatchObject({ status: "unsupported", reason: "filesystem" });
    expect(result.view.lastTest).toMatchObject({
      ok: true,
      testedBy: "admin@provider.test",
      failedStep: null,
      errorCode: null,
    });

    const [entry] = await tested();
    expect(entry).toMatchObject({
      actor: "admin@provider.test",
      actorUserId: "provider-admin",
      target: "installation_default",
      targetType: "storage_location",
      ip: "192.0.2.10",
      details: { ok: true, failedStep: null, objectLock: "unsupported" },
    });
    // The probe cleans up after itself and stays below the installation's own area.
    expect(await readdir(join(path, "installation", "probes"))).toEqual([]);
    expect(await readdir(path)).toEqual(["installation"]);
  });

  it("records a failed test with the step it stopped at, and the newest test wins", async () => {
    const blocked = join(root, "blocked");
    await mkdir(blocked, { recursive: true });
    // A file where the store's area must be created: the write cannot succeed.
    await writeFile(join(blocked, "installation"), "not a directory");
    const result = await service.testDefaultStorage(providerDb, actor, {
      env: { STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: blocked },
      now: () => new Date("2026-10-02T11:00:00.000Z"),
    });
    expect(result.probe.ok).toBe(false);
    expect(result.view.lastTest).toMatchObject({
      ok: false,
      failedStep: result.probe.failedStep,
      errorCode: result.probe.errorCode,
    });
    expect(result.view.lastTest?.failedStep).not.toBeNull();

    const view = await service.getDefaultStorage(providerDb, {
      env: { STORAGE_LOCAL_PATH: blocked },
    });
    expect(view.lastTest?.ok).toBe(false);
    expect(await tested()).toHaveLength(2);
  });

  it("keeps a tenant's own chain free of the installation test", async () => {
    const own = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "settings.default_storage.tested"));
    expect(own.every((entry) => entry.tenantId === null)).toBe(true);
  });

  describe("saving the default in the web UI", () => {
    const env = () => ({ STORAGE_TARGET: "local", STORAGE_LOCAL_PATH: join(root, "env-chunks") });
    const saved = () =>
      db
        .select()
        .from(secrets)
        .where(and(isNull(secrets.tenantId), eq(secrets.kind, "default_storage")));
    const fakeOpen: NonNullable<DefaultStorageDeps["open"]> = (location) => ({
      location,
      backend: new LocalStorageBackend(join(root, "unused")),
      probe: async () => ({
        ok: true,
        checkedAt: "2026-10-02T12:00:00.000Z",
        durationMs: 1,
        failedStep: null,
        errorCode: null,
        error: null,
        steps: [],
        warnings: [],
      }),
      detectObjectLock: async () => ({
        status: "disabled",
        mode: null,
        defaultRetentionDays: null,
        defaultRetentionYears: null,
        reason: null,
        detail: null,
        checkedAt: "2026-10-02T12:00:00.000Z",
      }),
    });

    it("refuses a location that fails the probe and saves nothing", async () => {
      await expect(
        service.saveDefaultStorage(
          providerDb,
          { kind: "local", config: { basePath: join(root, "does-not-exist") } },
          actor,
          { env: env() },
        ),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:settings-default-storage-unreachable",
      });
      expect(await saved()).toHaveLength(0);
    });

    it("saves a reachable local path; it wins over the environment and the view says so", async () => {
      const path = join(root, "gui-chunks");
      await mkdir(path, { recursive: true });
      const result = await service.saveDefaultStorage(
        providerDb,
        { kind: "local", config: { basePath: path } },
        actor,
        { env: env() },
      );
      expect(result.probe?.ok).toBe(true);
      expect(result.view).toMatchObject({
        configured: true,
        source: "database",
        location: path,
        saved: { kind: "local", local: { basePath: path }, updatedBy: "admin@provider.test" },
        environment: { configured: true, location: join(root, "env-chunks") },
      });
      expect(await saved()).toHaveLength(1);
      const [entry] = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.default_storage.saved"));
      expect(entry).toMatchObject({
        tenantId: null,
        details: { ok: true, location: path, previousSource: "environment" },
      });
    });

    it("keeps an S3 key pair write-only and only for the endpoint it was saved for", async () => {
      const config = {
        bucket: "restow-default",
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
      };
      // The current default (gui-chunks) holds no tenant data yet, so it may move.
      const result = await service.saveDefaultStorage(
        providerDb,
        {
          kind: "s3",
          config,
          credentials: { accessKeyId: "AKIAEXAMPLE1234", secretAccessKey: "very-secret-key" },
        },
        actor,
        { env: env(), open: fakeOpen },
      );
      expect(result.view.saved?.s3).toMatchObject({
        hasCredentials: true,
        accessKeyIdHint: "1234",
      });
      expect(JSON.stringify(result)).not.toContain("very-secret-key");

      // Same endpoint, no pair: the saved one is kept.
      await expect(
        service.saveDefaultStorage(
          providerDb,
          { kind: "s3", config: { ...config, region: "nbg1" } },
          actor,
          { env: env(), open: fakeOpen },
        ),
      ).resolves.toMatchObject({
        view: { saved: { s3: { region: "nbg1", hasCredentials: true } } },
      });

      // Another endpoint needs the pair again.
      await expect(
        service.saveDefaultStorage(
          providerDb,
          { kind: "s3", config: { ...config, endpoint: "https://s3.example.net" } },
          actor,
          { env: env(), open: fakeOpen },
        ),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:settings-default-storage-credentials-required",
      });
    });

    it("refuses to move the default while a tenant keeps data on it, naming the tenant", async () => {
      const path = join(root, "gui-chunks");
      await service.saveDefaultStorage(
        providerDb,
        { kind: "local", config: { basePath: path } },
        actor,
        { env: env() },
      );
      // Northwind retired the default with a "keep" replacement: its older backups still live there.
      const [northwind] = await db.select().from(tenants).where(eq(tenants.slug, "northwind"));
      await db.insert(storageTargets).values({
        tenantId: northwind?.id ?? "",
        kind: "installation_default",
        role: "previous",
        config: {},
      });
      const elsewhere = join(root, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      const refused = service.saveDefaultStorage(
        providerDb,
        { kind: "local", config: { basePath: elsewhere } },
        actor,
        { env: env() },
      );
      await expect(refused).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:settings-default-storage-in-use",
        extensions: {
          blockers: [{ tenantId: northwind?.id, tenantName: "Northwind", reasons: ["previous"] }],
        },
      });
      // The view lists the same tenant; removing the saved default (back to the environment) is refused too.
      const view = await service.getDefaultStorage(providerDb, { env: env() });
      expect(view.blockers.map((blocker) => blocker.tenantName)).toEqual(["Northwind"]);
      await mkdir(join(root, "env-chunks"), { recursive: true });
      await expect(
        service.removeDefaultStorage(providerDb, actor, { env: env() }),
      ).rejects.toMatchObject({
        status: 409,
      });
      // Saving the same location again (nothing moves) stays possible.
      await expect(
        service.saveDefaultStorage(
          providerDb,
          { kind: "local", config: { basePath: path } },
          actor,
          { env: env() },
        ),
      ).resolves.toMatchObject({ view: { location: path } });

      await db.delete(storageTargets).where(eq(storageTargets.kind, "installation_default"));
    });

    it("removes the saved default, so the environment applies again", async () => {
      const result = await service.removeDefaultStorage(providerDb, actor, { env: env() });
      expect(result.view).toMatchObject({
        source: "environment",
        location: join(root, "env-chunks"),
        saved: null,
      });
      expect(await saved()).toHaveLength(0);
      const removed = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "settings.default_storage.removed"));
      expect(removed).toHaveLength(1);
    });
  });
});
