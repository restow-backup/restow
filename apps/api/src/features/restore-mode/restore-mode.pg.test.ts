/**
 * Restore mode in the api and on the command line (service.ts, cli/restore-mode.ts) against
 * Postgres and a local default repository: switching it on records the audit entry once; the
 * comparison sees a storage ahead of the database; ending it refuses a short description and key
 * versions in storage the database lacks, imports them, lifts each tenant's progress value above
 * the storage's and writes the installation's audit entry with what was checked; a deleting
 * action answers 409 meanwhile; a new key version is allocated above every version in storage.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvKeyProvider,
  generateDek,
  installDeletionEnforcement,
  kekFromBase64,
  LocalStorageBackend,
  progressMarkerKey,
} from "@restow/core";
import {
  createDb,
  type Database,
  providers,
  readStorageProgress,
  tenantKeys,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionTestRoles, type TestDatabaseRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_api_restore_mode_test";

describe.skipIf(!testDatabaseAdminUrl)("restore mode in the api against Postgres", () => {
  let owner: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let root: string;
  let tenantId: string;
  let installationId: string;
  let kek: Buffer;
  let service: typeof import("./service.js");
  let guardModule: typeof import("./guard.js");
  let cli: typeof import("../../cli/restore-mode.js");
  let args: typeof import("../../cli/restore-mode-args.js");

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    root = await mkdtemp(join(tmpdir(), "restow-api-restore-mode-"));
    const masterKey = randomBytes(32).toString("base64");
    kek = kekFromBase64(masterKey);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = masterKey;
    process.env.STORAGE_TARGET = "local";
    process.env.STORAGE_LOCAL_PATH = root;
    owner = createDb(url);
    providerDb = createDb(roles.providerUrl);
    const [settingsRow] = await owner.$client
      .query<{ id: string }>("INSERT INTO settings DEFAULT VALUES RETURNING id::text AS id")
      .then((result) => result.rows);
    installationId = settingsRow?.id ?? "";
    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await owner
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";
    await owner.insert(tenantKeys).values({
      tenantId,
      keyVersion: 1,
      encryptedDek: (await new EnvKeyProvider(kek).wrapDek(generateDek(1))).toString("base64"),
      kekId: "env:RESTOW_MASTER_KEY",
    });
    service = await import("./service.js");
    guardModule = await import("./guard.js");
    cli = await import("../../cli/restore-mode.js");
    args = await import("../../cli/restore-mode-args.js");
  }, 120_000);

  afterAll(async () => {
    const shared = await import("../../db.js").catch(() => null);
    await Promise.allSettled([
      owner?.$client.end(),
      providerDb?.$client.end(),
      shared?.db.$client.end(),
      shared?.providerDb.$client.end(),
      shared?.authDb.$client.end(),
    ]);
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("switches restore mode on from the command line, once, with its audit entry", async () => {
    const out: string[] = [];
    const io = {
      confirm: async () => true,
      out: (text: string) => out.push(text),
      err: () => undefined,
    };
    const on = args.parseRestoreModeCommand("on", ["--reason", "rollback to 0.5.0", "--yes"]);
    expect(await cli.runRestoreModeCommand(on, providerDb, io)).toBe(0);
    expect(await cli.runRestoreModeCommand(on, providerDb, io)).toBe(0);
    expect(out.join("")).toMatch(/Restore mode is on\. Start the installation/);
    expect(out.join("")).toMatch(/on already/);
    const audit = await owner.$client.query(
      "SELECT actor, details FROM audit_log WHERE action = 'installation.restore_mode.started'",
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.details).toMatchObject({ source: "cli", reason: "rollback to 0.5.0" });
    expect((await service.restoreModeBanner(providerDb)).active).toBe(true);

    const status: string[] = [];
    await cli.runRestoreModeCommand(args.parseRestoreModeCommand("status", []), providerDb, {
      ...io,
      out: (text) => status.push(text),
    });
    expect(status.join("")).toMatch(/Restore mode is ON/);
  });

  it("answers 409 for a deleting action while restore mode is on", async () => {
    const guard = guardModule.createApiRestoreModeGuard(providerDb, () => undefined);
    const uninstall = installDeletionEnforcement(guard);
    try {
      await expect(
        service.assertNotInRestoreMode("file_share_purge", tenantId),
      ).rejects.toMatchObject({
        status: 409,
        type: service.RESTORE_MODE_PROBLEM,
      });
    } finally {
      uninstall();
    }
  });

  it("ends restore mode only after keys are imported, lifting the progress value above storage", async () => {
    const storage = new LocalStorageBackend(root);
    // Written after the dump: a marker above the database's value and key version 2.
    await storage.put(
      progressMarkerKey(tenantId, 42),
      Buffer.from(JSON.stringify({ format: 1, installationId, tenantId, seq: 42 })),
    );
    const newerKey = await new EnvKeyProvider(kek).wrapDek(generateDek(2));
    await storage.put(`tenants/${tenantId}/keys/2`, newerKey);
    const guard = guardModule.createApiRestoreModeGuard(providerDb, () => undefined);

    const checks = await service.checkRestoreMode(providerDb, guard);
    expect(checks.find((check) => check.tenantId === tenantId)?.outcome).toBe("ahead");
    const view = await service.restoreModeView(providerDb);
    expect(view.unknownKeyVersions).toEqual([
      { tenantId, targetId: expect.any(String), versions: [2] },
    ]);

    const actor = { label: "owner@provider.test", email: "owner@provider.test" };
    await expect(
      service.endRestoreModeConfirmed(providerDb, guard, {
        checked: "short",
        confirmation: "END",
        storageOnlyData: "keep",
        actor,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.endRestoreModeConfirmed(providerDb, guard, {
        checked: "Compared every restore point with the dump's date.",
        confirmation: "END",
        storageOnlyData: "keep",
        actor,
      }),
    ).rejects.toMatchObject({
      status: 409,
      title: "Key versions in storage are not in the database",
    });

    const imported = await service.importRestoreModeKeys(providerDb, {
      actor,
      provider: new EnvKeyProvider(kek),
    });
    expect(imported).toEqual({ imported: [{ tenantId, keyVersion: 2 }], refused: [] });
    const [stored] = await owner.select().from(tenantKeys).where(eq(tenantKeys.keyVersion, 2));
    expect(Buffer.from(stored?.encryptedDek ?? "", "base64").equals(newerKey)).toBe(true);

    const ended = await service.endRestoreModeConfirmed(providerDb, guard, {
      checked: "Compared every restore point with the dump's date.",
      confirmation: "END",
      storageOnlyData: "keep",
      actor,
    });
    expect(ended.rebase.find((entry) => entry.tenantId === tenantId)?.to).toBeGreaterThanOrEqual(
      42 + 1_000_000,
    );
    expect(await readStorageProgress(providerDb.$client, tenantId)).toBeGreaterThan(42);
    const row = await owner.$client.query(
      "SELECT ended_at, checked, storage_only_data, keep_unknown_before FROM installation_restore_mode",
    );
    expect(row.rows[0]).toMatchObject({
      checked: "Compared every restore point with the dump's date.",
      storage_only_data: "keep",
    });
    expect(row.rows[0]?.keep_unknown_before).not.toBeNull();
    const audit = await owner.$client.query(
      "SELECT actor, details FROM audit_log WHERE action = 'installation.restore_mode.ended'",
    );
    expect(audit.rows[0]).toMatchObject({
      actor: "owner@provider.test",
      details: {
        checked: "Compared every restore point with the dump's date.",
        storageOnlyData: "keep",
      },
    });
    // A comparison after the end: the storage is no longer ahead.
    expect((await service.checkRestoreMode(providerDb, guard))[0]?.outcome).toBe("ok");
    expect((await service.restoreModeBanner(providerDb)).active).toBe(false);
  });

  it("allocates a new key version above every version stored for the tenant", async () => {
    const secrets = await import("../../lib/secrets.js");
    const storage = new LocalStorageBackend(root);
    await storage.put(`tenants/${tenantId}/keys/7`, Buffer.from("a key the database lost"));
    // Without its storage a tenant that has a key gets no new version.
    await expect(owner.transaction((tx) => secrets.createTenantKey(tx, tenantId))).rejects.toThrow(
      /storage/,
    );
    const created = await owner.transaction((tx) =>
      secrets.createTenantKey(tx, tenantId, {
        storage: { backends: [storage] },
        provider: new EnvKeyProvider(kek),
      }),
    );
    expect(created.keyVersion).toBe(8);
    // A target that cannot be listed refuses: the version could collide with one stored there.
    await expect(
      owner.transaction((tx) =>
        secrets.createTenantKey(tx, tenantId, {
          storage: {
            backends: [
              {
                list: async () => {
                  throw new Error("offline");
                },
              },
            ],
          },
          provider: new EnvKeyProvider(kek),
        }),
      ),
    ).rejects.toMatchObject({ status: 503, type: secrets.KEY_VERSION_UNSAFE_PROBLEM });
  });
});
