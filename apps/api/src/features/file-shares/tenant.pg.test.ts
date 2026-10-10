/**
 * The tenant side of file shares against Postgres (docs/FILESHARES.md 9.1, 10.1, 16.2): adding,
 * changing, testing and listing shares through a stand-in mounter, the private-network rule,
 * the sealed password (never in an answer or the audit log), backup now, restores and their
 * targets, cancel, retire, purge, the budget, the approval, the repository password, the
 * installation settings, and Row Level Security between two tenants. The worker's side (runs,
 * restic) is apps/worker/src/file-shares/*.pg.test.ts; reading backups with the real restic is
 * browse.pg.test.ts next to this file.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser); skipped otherwise.
 */
import { randomUUID } from "node:crypto";
import type { RunnerClient, RunnerExecRequest, RunnerExecResult, ShareSpec } from "@restow/core";
import {
  auditLog,
  backupJobs,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
  secrets,
  settings,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "../endpoints/testing/fixture.js";
import type { ShareContext } from "./service.js";

const DATABASE = "restow_api_file_shares_tenant_test";
const PASSWORD = "S3cret,with=comma";

type Service = typeof import("./service.js");
type Shared = typeof import("../../db.js");

const HOSTS: Record<string, string[]> = {
  "files.example.test": ["93.184.216.34"],
  "nas.lan": ["192.168.10.20"],
  "metadata.example.test": ["169.254.169.254"],
  "other.example.test": ["1.1.1.1"],
};

/** A mounter that answers what each test tells it and records what it was asked. */
class FakeRunner implements RunnerClient {
  readonly enabled = true;
  calls: RunnerExecRequest[] = [];
  next: (request: RunnerExecRequest) => RunnerExecResult = () => ({
    ok: true,
    code: null,
    detail: null,
    output: {
      ok: true,
      fsType: "cifs",
      readOnly: true,
      entries: [
        { name: "Finance", type: "dir", size: 0, mtime: "2026-10-09T08:12:00Z" },
        { name: "readme.txt", type: "file", size: 12, mtime: "2026-10-09T08:12:00Z" },
      ],
      truncated: false,
      permissions: { readable: true, xattr: "system.cifs_ntsd" },
      durationMs: 412,
    },
  });
  async capabilities() {
    return {
      ready: true,
      blockers: [],
      protocols: ["smb", "nfs"] as ("smb" | "nfs")[],
      running: 0,
      limit: 8,
      image: "img",
    };
  }
  async exec(request: RunnerExecRequest) {
    this.calls.push(request);
    return this.next(request);
  }
  async start(): Promise<never> {
    throw new Error("not used");
  }
  async list() {
    return [];
  }
  async get() {
    return null;
  }
  async stop() {}
  async removeCache() {}
}

describe.skipIf(!testDatabaseAdminUrl)("file shares of a tenant against Postgres", () => {
  let fixture: EndpointFixture;
  let service: Service;
  let shared: Shared;
  const runner = new FakeRunner();
  const sent: { queue: string; payload: object; key: string }[] = [];

  const resolve = async (host: string) => {
    const found = HOSTS[host];
    if (!found) throw new Error("ENOTFOUND");
    return found;
  };
  const tenantAdmin = (): ShareContext => ({
    actor: { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" },
    isProviderAdmin: false,
    providerRole: null,
    runner,
    resolve,
    send: async (queue, payload, key) => {
      sent.push({ queue, payload, key });
      return randomUUID();
    },
  });
  const providerAdmin = (role: "owner" | "administrator" | "technician" = "administrator") => ({
    ...tenantAdmin(),
    actor: { label: "operator@provider.example", userId: fixture.adminId, ip: "192.0.2.2" },
    isProviderAdmin: true,
    providerRole: role,
  });

  const smbInput = (name: string, server = "files.example.test") => ({
    protocol: "smb" as const,
    name,
    server,
    share: "data",
    subfolder: "",
    account: "CONTOSO\\backup",
    password: PASSWORD,
    smbVersion: "3.1.1" as const,
    seal: false,
    allowRestore: false,
    permissionsMode: "auto" as const,
    rereadPermissions: false,
  });

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    shared = await import("../../db.js");
    service = await import("./service.js");
    await fixture.db.insert(settings).values({}).onConflictDoNothing();
  }, 120_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  beforeEach(async () => {
    runner.calls = [];
    sent.length = 0;
    await fixture.db.delete(backupJobs);
    await fixture.db.delete(fileShares);
    await fixture.db.update(settings).set({ fileShareSettings: {} });
    (await import("./settings.js")).forgetFileShareSettings();
  });

  async function auditOf(action: string) {
    return fixture.db.select().from(auditLog).where(eq(auditLog.action, action));
  }

  it("adds an SMB share, seals the password and never answers with it", async () => {
    const created = await service.createShare(
      shared.db,
      fixture.tenantId,
      smbInput("Data"),
      tenantAdmin(),
    );
    expect(created).toMatchObject({
      name: "Data",
      protocol: "smb",
      server: "files.example.test",
      shareName: "data",
      username: "backup",
      domain: "CONTOSO",
      hasPassword: true,
      location: "\\\\files.example.test\\data",
      privateNetworkApproval: null,
      standing: "no_job",
      readiness: { state: "no_backup" },
    });
    expect(JSON.stringify(created)).not.toContain(PASSWORD);
    const [row] = await fixture.db.select().from(fileShares).where(eq(fileShares.id, created.id));
    const [secret] = await fixture.db
      .select()
      .from(secrets)
      .where(eq(secrets.id, row?.credentialSecretId as string));
    expect(secret?.kind).toBe("file_share_password");
    expect(secret?.ciphertext).not.toContain(PASSWORD);
    const entries = await auditOf("file_share.created");
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.details)).not.toContain("S3cret");
    expect(entries[0]).toMatchObject({ targetType: "file_share", target: created.id });
  });

  it("refuses a second share of the same name, but not of a retired one", async () => {
    const first = await service.createShare(
      shared.db,
      fixture.tenantId,
      smbInput("Data"),
      tenantAdmin(),
    );
    await expect(
      service.createShare(shared.db, fixture.tenantId, smbInput("data"), tenantAdmin()),
    ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:file-share-name-taken" });
    await service.retireShare(shared.db, fixture.tenantId, first.id, tenantAdmin());
    await expect(
      service.createShare(shared.db, fixture.tenantId, smbInput("Data"), tenantAdmin()),
    ).resolves.toMatchObject({ name: "Data" });
  });

  describe("private networks (10.1)", () => {
    it("refuses a tenant admin's private address, records a provider admin's approval", async () => {
      await expect(
        service.createShare(shared.db, fixture.tenantId, smbInput("NAS", "nas.lan"), tenantAdmin()),
      ).rejects.toMatchObject({
        status: 422,
        type: "urn:restow:problem:file-share-host-not-allowed",
        extensions: { reason: "private_network" },
      });
      const approved = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("NAS", "nas.lan"),
        providerAdmin(),
      );
      expect(approved.privateNetworkApproval).toMatchObject({
        by: "operator@provider.example",
        address: "192.168.10.20",
        range: "192.168.10.0/24",
      });
      expect(await auditOf("file_share.private_network_approved")).toHaveLength(1);
      // A tenant admin may change the approved share; the approval stays.
      const renamed = await service.updateShare(
        shared.db,
        fixture.tenantId,
        approved.id,
        { name: "NAS 1" },
        tenantAdmin(),
      );
      expect(renamed.privateNetworkApproval?.address).toBe("192.168.10.20");
      // ... and withdrawing it is the provider admin's.
      const withdrawn = await service.setPrivateNetworkApproval(
        shared.db,
        fixture.tenantId,
        approved.id,
        false,
        providerAdmin(),
      );
      expect(withdrawn.privateNetworkApproval).toBeNull();
    });

    it("lets tenant admins use private networks when the installation allows it", async () => {
      await service.updateInstallationShareSettings(
        { tenantsMayUsePrivateNetworks: true },
        providerAdmin("owner"),
      );
      const created = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("NAS", "nas.lan"),
        tenantAdmin(),
      );
      expect(created.privateNetworkApproval).toBeNull();
    });

    it("leaves the installation switch to the owner", async () => {
      await expect(
        service.updateInstallationShareSettings(
          { tenantsMayUsePrivateNetworks: true },
          providerAdmin("administrator"),
        ),
      ).rejects.toMatchObject({ status: 403 });
      const changed = await service.updateInstallationShareSettings(
        { maxConcurrentRunners: 3, tenantShareQuotaGibByTenant: { [fixture.tenantId]: 50 } },
        providerAdmin("administrator"),
      );
      expect(changed.settings).toMatchObject({
        maxConcurrentRunners: 3,
        tenantShareQuotaGibByTenant: { [fixture.tenantId]: 50 },
      });
      expect((await service.tenantShareSettings(fixture.tenantId, { runner })).tenantQuotaGib).toBe(
        50,
      );
    });

    it("refuses link-local and reserved addresses for everyone", async () => {
      await expect(
        service.createShare(
          shared.db,
          fixture.tenantId,
          smbInput("Meta", "metadata.example.test"),
          providerAdmin("owner"),
        ),
      ).rejects.toMatchObject({ status: 422, extensions: { reason: "forbidden_address" } });
    });
  });

  describe("testing and listing through the runner", () => {
    it("tests unsaved settings with the pinned address and the password", async () => {
      const result = await service.testUnsavedShare(
        shared.db,
        fixture.tenantId,
        {
          protocol: "smb",
          server: "files.example.test",
          share: "data",
          subfolder: "Finance",
          account: "backup@contoso.example",
          password: PASSWORD,
          smbVersion: "3.0",
          seal: true,
        },
        tenantAdmin(),
      );
      expect(result).toMatchObject({ ok: true, cause: null, permissions: { readable: true } });
      expect(result.entries.map((entry) => entry.name)).toEqual(["Finance", "readme.txt"]);
      const call = runner.calls[0] as { op: string; share: ShareSpec };
      expect(call.op).toBe("probe");
      expect(call.share).toMatchObject({
        protocol: "smb",
        address: "93.184.216.34",
        subfolder: "Finance",
        username: "backup@contoso.example",
        password: PASSWORD,
        smbVersion: "3.0",
        seal: true,
      });
      const audit = await auditOf("file_share.tested");
      expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    });

    it("classifies a refused password and keeps it on the share until a success", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      runner.next = () => ({
        ok: false,
        code: "mount.auth_failed",
        detail: `mount error: permission denied (password=${PASSWORD})`,
        output: null,
      });
      const failed = await service.testStoredShare(
        shared.db,
        fixture.tenantId,
        share.id,
        tenantAdmin(),
      );
      expect(failed).toMatchObject({
        ok: false,
        code: "mount.auth_failed",
        cause: "share.auth_failed",
      });
      expect(failed.detail ?? "").not.toContain(PASSWORD);
      let [row] = await fixture.db.select().from(fileShares).where(eq(fileShares.id, share.id));
      expect(row?.credentialFailedAt).not.toBeNull();
      expect(row?.lastTest).toMatchObject({ ok: false, code: "share.auth_failed" });
      runner.next = new FakeRunner().next;
      await service.testStoredShare(shared.db, fixture.tenantId, share.id, tenantAdmin());
      [row] = await fixture.db.select().from(fileShares).where(eq(fileShares.id, share.id));
      expect(row?.credentialFailedAt).toBeNull();
      expect(row?.lastTest?.ok).toBe(true);
    });

    it("lists one folder of the live share", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      const listing = await service.listShareSource(
        shared.db,
        fixture.tenantId,
        share.id,
        { path: "Finance/2026", limit: 100 },
        tenantAdmin(),
      );
      expect(listing.ok).toBe(true);
      expect(runner.calls[0]).toMatchObject({ op: "list", path: "Finance/2026", limit: 100 });
    });

    it("says the mounter is not there instead of failing", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      const { RunnerUnavailableError } = await import("@restow/core");
      const absent = new FakeRunner();
      absent.exec = async () => {
        throw new RunnerUnavailableError("unreachable");
      };
      await expect(
        service.testStoredShare(shared.db, fixture.tenantId, share.id, {
          ...tenantAdmin(),
          runner: absent,
        }),
      ).rejects.toMatchObject({
        status: 503,
        type: "urn:restow:problem:file-share-mounter-unavailable",
        extensions: { command: "docker compose --profile mounts up -d mounter" },
      });
    });
  });

  describe("changing a share", () => {
    it("replaces the password, clears the credential warning, audits without the password", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      await fixture.db
        .update(fileShares)
        .set({ credentialFailedAt: new Date() })
        .where(eq(fileShares.id, share.id));
      const [before] = await fixture.db
        .select()
        .from(fileShares)
        .where(eq(fileShares.id, share.id));
      const updated = await service.updateShare(
        shared.db,
        fixture.tenantId,
        share.id,
        { password: "New,pass" },
        tenantAdmin(),
      );
      expect(updated.credentialFailedAt).toBeNull();
      const [after] = await fixture.db.select().from(fileShares).where(eq(fileShares.id, share.id));
      expect(after?.credentialSecretId).toBe(before?.credentialSecretId);
      const audit = await auditOf("file_share.password_changed");
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]?.details)).not.toContain("New,pass");
    });

    it("asks to confirm a new location once there are restore points", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      await fixture.db.insert(fileShareSnapshots).values({
        tenantId: fixture.tenantId,
        fileShareId: share.id,
        sequence: 1,
        resticSnapshotId: "a".repeat(64),
        snapshotTime: new Date(),
        files: 3,
      });
      await expect(
        service.updateShare(
          shared.db,
          fixture.tenantId,
          share.id,
          { subfolder: "Finance" },
          tenantAdmin(),
        ),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:file-share-location-change",
      });
      const moved = await service.updateShare(
        shared.db,
        fixture.tenantId,
        share.id,
        { subfolder: "Finance", confirmNewLocation: true },
        tenantAdmin(),
      );
      expect(moved.subfolder).toBe("Finance");
      const audit = await auditOf("file_share.updated");
      expect(audit.at(-1)?.details).toMatchObject({ changed: ["subfolder"], newLocation: true });
    });

    it("refuses fields of the other protocol", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      await expect(
        service.updateShare(
          shared.db,
          fixture.tenantId,
          share.id,
          { export: "/srv" },
          tenantAdmin(),
        ),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("sets the budget for provider administrators only", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      await expect(
        service.setShareQuota(shared.db, fixture.tenantId, share.id, 100, tenantAdmin()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.setShareQuota(
          shared.db,
          fixture.tenantId,
          share.id,
          100,
          providerAdmin("technician"),
        ),
      ).rejects.toMatchObject({ status: 403 });
      const set = await service.setShareQuota(
        shared.db,
        fixture.tenantId,
        share.id,
        100,
        providerAdmin(),
      );
      expect(set.quota).toMatchObject({ quotaGib: 100, level: "ok" });
      expect(await auditOf("file_share.quota_changed")).toHaveLength(1);
    });
  });

  describe("runs", () => {
    it("queues a manual backup once and refuses a retired share", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      const first = await service.backupNow(
        shared.db,
        fixture.tenantId,
        share.id,
        { allowEmptyOnce: false },
        tenantAdmin(),
      );
      expect(first).toMatchObject({
        alreadyQueued: false,
        run: { kind: "backup", status: "queued", trigger: "manual" },
      });
      const second = await service.backupNow(
        shared.db,
        fixture.tenantId,
        share.id,
        { allowEmptyOnce: true },
        tenantAdmin(),
      );
      expect(second.alreadyQueued).toBe(true);
      const [run] = await fixture.db
        .select()
        .from(fileShareRuns)
        .where(eq(fileShareRuns.id, first.run.id));
      expect(run?.params.allowEmptyOnce).toBe(true);
      const cancelled = await service.cancelRun(
        shared.db,
        fixture.tenantId,
        share.id,
        first.run.id,
        tenantAdmin(),
      );
      expect(cancelled.status).toBe("cancelled");
      await service.retireShare(shared.db, fixture.tenantId, share.id, tenantAdmin());
      await expect(
        service.backupNow(
          shared.db,
          fixture.tenantId,
          share.id,
          { allowEmptyOnce: false },
          tenantAdmin(),
        ),
      ).rejects.toMatchObject({ status: 409, type: "urn:restow:problem:file-share-retired" });
    });

    it("restores only into shares that allow it, with the defaults of 4.7", async () => {
      const source = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      const target = await service.createShare(
        shared.db,
        fixture.tenantId,
        { ...smbInput("Archive", "other.example.test"), allowRestore: true },
        tenantAdmin(),
      );
      const [snapshot] = await fixture.db
        .insert(fileShareSnapshots)
        .values({
          tenantId: fixture.tenantId,
          fileShareId: source.id,
          sequence: 1,
          resticSnapshotId: "b".repeat(64),
          snapshotTime: new Date(),
          files: 3,
        })
        .returning();
      const snapshotId = snapshot?.id as string;
      await expect(
        service.requestRestore(
          shared.db,
          fixture.tenantId,
          source.id,
          { snapshotId, paths: ["/Finance"], destination: "original", conflict: "keep_both" },
          tenantAdmin(),
        ),
      ).rejects.toMatchObject({
        status: 409,
        type: "urn:restow:problem:file-share-restore-not-allowed",
      });
      const elsewhere = await service.requestRestore(
        shared.db,
        fixture.tenantId,
        source.id,
        {
          snapshotId,
          paths: ["/Finance", "/HR/a.txt"],
          destination: "other_share",
          targetShareId: target.id,
          folder: "From Data",
        },
        tenantAdmin(),
      );
      expect(elsewhere).toMatchObject({
        kind: "restore",
        status: "queued",
        fileShareId: source.id,
        targetShareId: target.id,
        sourceSnapshotId: snapshotId,
        params: {
          destination: "folder",
          folder: "From Data",
          paths: ["Finance", "HR/a.txt"],
          restorePermissions: false,
          verify: false,
        },
      });
      const [row] = await fixture.db
        .select()
        .from(fileShareRuns)
        .where(eq(fileShareRuns.id, elsewhere.id));
      expect(row?.lockShareId).toBe(target.id);
      await service.updateShare(
        shared.db,
        fixture.tenantId,
        source.id,
        { allowRestore: true },
        tenantAdmin(),
      );
      const original = await service.requestRestore(
        shared.db,
        fixture.tenantId,
        source.id,
        { snapshotId, paths: [], destination: "original", conflict: "overwrite" },
        tenantAdmin(),
      );
      expect(original.params).toMatchObject({
        destination: "original",
        conflict: "overwrite",
        restorePermissions: true,
      });
      const audit = await auditOf("file_share.restore_requested");
      expect(audit.at(-1)?.details).toMatchObject({ destination: "original", paths: 0 });
      expect(
        (await service.restoreTargets(shared.db, fixture.tenantId)).items
          .map((item) => item.name)
          .sort(),
      ).toEqual(["Archive", "Data"]);
    });

    it("asks for a restore check only with a restore point", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      await expect(
        service.requestVerify(shared.db, fixture.tenantId, share.id, tenantAdmin()),
      ).rejects.toMatchObject({ status: 409 });
      const [snapshot] = await fixture.db
        .insert(fileShareSnapshots)
        .values({
          tenantId: fixture.tenantId,
          fileShareId: share.id,
          sequence: 1,
          resticSnapshotId: "c".repeat(64),
          snapshotTime: new Date(),
        })
        .returning();
      await fixture.db
        .update(fileShares)
        .set({ lastSnapshotId: snapshot?.id })
        .where(eq(fileShares.id, share.id));
      await expect(
        service.requestVerify(shared.db, fixture.tenantId, share.id, tenantAdmin()),
      ).resolves.toEqual({
        queued: true,
      });
      expect(sent[0]).toMatchObject({
        queue: "file-share-verify",
        payload: { tenantId: fixture.tenantId, fileShareId: share.id, force: true },
        key: `file-share-verify:${share.id}`,
      });
    });
  });

  describe("retire and purge", () => {
    it("retiring stops the copy jobs of the share", async () => {
      const source = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      const target = await service.createShare(
        shared.db,
        fixture.tenantId,
        { ...smbInput("Archive", "other.example.test"), allowRestore: true },
        tenantAdmin(),
      );
      const [job] = await fixture.db
        .insert(backupJobs)
        .values({
          tenantId: fixture.tenantId,
          kind: "copy",
          name: "Copy",
          sourceFileShareId: source.id,
          targetFileShareId: target.id,
          settings: { mode: "overwrite", targetFolder: "copy" },
        })
        .returning();
      const retired = await service.retireShare(
        shared.db,
        fixture.tenantId,
        target.id,
        tenantAdmin(),
      );
      expect(retired.retiredAt).not.toBeNull();
      const [after] = await fixture.db
        .select()
        .from(backupJobs)
        .where(eq(backupJobs.id, job?.id as string));
      expect(after?.enabled).toBe(false);
      const back = await service.reactivateShare(
        shared.db,
        fixture.tenantId,
        target.id,
        tenantAdmin(),
      );
      expect(back.retiredAt).toBeNull();
    });

    it("purges only with the exact name and queues the worker's job", async () => {
      const share = await service.createShare(
        shared.db,
        fixture.tenantId,
        smbInput("Data"),
        tenantAdmin(),
      );
      await expect(
        service.purgeShare(shared.db, fixture.tenantId, share.id, "data", tenantAdmin()),
      ).rejects.toMatchObject({ status: 422, type: "urn:restow:problem:file-share-confirm-name" });
      await expect(
        service.purgeShare(shared.db, fixture.tenantId, share.id, "Data", tenantAdmin()),
      ).resolves.toEqual({ queued: true });
      expect(sent[0]).toMatchObject({
        queue: "file-share-purge",
        payload: { fileShareId: share.id },
      });
      const [row] = await fixture.db.select().from(fileShares).where(eq(fileShares.id, share.id));
      expect(row?.retiredAt).not.toBeNull();
      expect(await auditOf("file_share.purge_requested")).toHaveLength(1);
    });
  });

  it("hands out the repository password only once the repository exists, audited", async () => {
    const share = await service.createShare(
      shared.db,
      fixture.tenantId,
      smbInput("Data"),
      tenantAdmin(),
    );
    await expect(
      service.revealRepositoryPassword(shared.db, fixture.tenantId, share.id, tenantAdmin()),
    ).rejects.toMatchObject({ status: 409 });
    const secretStore = await import("../../lib/secrets.js");
    const ref = await secretStore.storeSecret(shared.db, {
      tenantId: fixture.tenantId,
      kind: "file_share_repository",
      plaintext: "repo-password",
    });
    await fixture.db
      .update(fileShares)
      .set({ repositorySecretId: ref.id })
      .where(eq(fileShares.id, share.id));
    await expect(
      service.revealRepositoryPassword(shared.db, fixture.tenantId, share.id, tenantAdmin()),
    ).resolves.toEqual({ password: "repo-password", storagePrefix: `file-shares/${share.id}/` });
    const audit = await auditOf("file_share.repository_password_shown");
    expect(JSON.stringify(audit)).not.toContain("repo-password");
  });

  it("keeps tenants apart (Row Level Security)", async () => {
    const share = await service.createShare(
      shared.db,
      fixture.tenantId,
      smbInput("Data"),
      tenantAdmin(),
    );
    await expect(
      service.getShare(shared.db, fixture.otherTenantId, share.id),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await service.listShares(shared.db, fixture.otherTenantId, { retired: "include" })).items,
    ).toEqual([]);
    const listed = await service.listShares(shared.db, fixture.tenantId, { retired: "exclude" });
    expect(listed.items.map((item) => item.id)).toEqual([share.id]);
    expect(listed.counts).toMatchObject({ total: 1, protected: 0, withoutJob: 1 });
    await expect(
      service.backupNow(
        shared.db,
        fixture.otherTenantId,
        share.id,
        { allowEmptyOnce: false },
        tenantAdmin(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const runs = await fixture.db
      .select()
      .from(fileShareRuns)
      .where(and(eq(fileShareRuns.tenantId, fixture.otherTenantId)));
    expect(runs).toEqual([]);
  });
});
