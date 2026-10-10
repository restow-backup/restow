/**
 * A scratch installation for the Postgres suites of file share backup (docs/FILESHARES.md 16.2):
 * a migrated database with the provisioned application and installation roles (as in
 * production, so Row Level Security binds the jobs), two tenants with keys, a local storage
 * folder as their primary target, the worker's dependencies with a pinned clock, and a fake
 * mounter that records what it was asked and lets a test decide what each run does.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvKeyProvider,
  LocalStorageBackend,
  type RunnerCapabilities,
  type RunnerClient,
  type RunnerExecRequest,
  type RunnerExecResult,
  type RunnerRunDetail,
  type RunnerRunRequest,
  type RunnerRunView,
  type StorageTargets,
  type TenantKeyring,
  generateDek,
  noopLogger,
  sealSecret,
} from "@restow/core";
import {
  type BackupJobSchedule,
  type Database,
  type FileShare,
  type NewFileShare,
  type RoleLogin,
  backupJobMembers,
  backupJobs,
  createDb,
  fileShares,
  secrets,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { TenantCache, loadTenantKeyring, withTenantTx } from "../../handlers/framework.js";
import { dropTestDatabase } from "../../testing/database.js";
import type { FileShareDeps } from "../common.js";

export const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

/** What a fake run does when it is started. */
export type FakeRunBehaviour = (request: RunnerRunRequest) => Promise<void> | void;

/** A mounter that records its requests; `onStart` decides what a run does. */
export class FakeRunner implements RunnerClient {
  readonly enabled = true;
  readonly started: RunnerRunRequest[] = [];
  readonly stopped: string[] = [];
  readonly runs = new Map<string, RunnerRunDetail>();
  readonly cachesRemoved: string[] = [];
  /** Throw this from start() (a refusal, the mounter unreachable). */
  failStart: Error | null = null;
  onStart: FakeRunBehaviour = () => undefined;
  /** Throw this from get() (the mounter unreachable). */
  failGet: Error | null = null;

  async capabilities(): Promise<RunnerCapabilities | null> {
    return {
      ready: true,
      blockers: [],
      protocols: ["smb", "nfs"],
      running: 0,
      limit: 8,
      image: "x",
    };
  }
  async exec(_request: RunnerExecRequest): Promise<RunnerExecResult> {
    return { ok: true, code: null, detail: null };
  }
  async start(request: RunnerRunRequest): Promise<{ runId: string; startedAt: string }> {
    if (this.failStart) {
      throw this.failStart;
    }
    this.started.push(request);
    const startedAt = new Date().toISOString();
    this.runs.set(request.runId, {
      runId: request.runId,
      kind: request.kind,
      state: "running",
      startedAt,
      deadline: request.limits.deadline,
      exitCode: null,
      finishedAt: null,
      stopReason: null,
      stderrTail: null,
    });
    await this.onStart(request);
    return { runId: request.runId, startedAt };
  }
  /** Let a fake run end with an exit code (and a stderr tail). */
  exit(runId: string, exitCode: number, at: Date, stderrTail: string | null = null): void {
    const run = this.runs.get(runId);
    if (run) {
      this.runs.set(runId, {
        ...run,
        state: "exited",
        exitCode,
        finishedAt: at.toISOString(),
        stderrTail,
      });
    }
  }
  async list(): Promise<RunnerRunView[]> {
    return [...this.runs.values()];
  }
  async get(runId: string): Promise<RunnerRunDetail | null> {
    if (this.failGet) {
      throw this.failGet;
    }
    return this.runs.get(runId) ?? null;
  }
  async stop(runId: string): Promise<void> {
    this.stopped.push(runId);
    const run = this.runs.get(runId);
    if (run && run.state === "running") {
      this.runs.set(runId, {
        ...run,
        state: "exited",
        exitCode: 143,
        finishedAt: new Date().toISOString(),
        stopReason: "stopped",
      });
    }
  }
  async removeCache(shareId: string): Promise<void> {
    this.cachesRemoved.push(shareId);
  }
}

export interface ShareFixture {
  owner: Database;
  appDb: Database;
  providerDb: Database;
  /** Base64 of the master key the tenant keys are wrapped with (RESTOW_MASTER_KEY). */
  masterKey: string;
  url: string;
  roles: { tenant: RoleLogin; installation: RoleLogin };
  work: string;
  storageDir: string;
  contoso: string;
  fabrikam: string;
  runner: FakeRunner;
  deps: FileShareDeps;
  clock: { now: Date };
  cleanup(): Promise<void>;
}

export async function startShareFixture(database: string): Promise<ShareFixture> {
  const admin = createDb(adminUrl as string);
  await admin.$client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.$client.query(`CREATE DATABASE ${database}`);
  await admin.$client.end();
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  const suffix = randomBytes(4).toString("hex");
  const roles = {
    tenant: { name: `restow_fs_app_${suffix}`, password: randomBytes(12).toString("hex") },
    installation: { name: `restow_fs_inst_${suffix}`, password: randomBytes(12).toString("hex") },
  };
  await runMigrations(url.toString(), { roles });
  const owner = createDb(url.toString());
  const asRole = (login: RoleLogin) => {
    const copy = new URL(url);
    copy.username = login.name;
    copy.password = login.password;
    return createDb(copy.toString());
  };
  const appDb = asRole(roles.tenant);
  const providerDb = asRole(roles.installation);
  const work = await mkdtemp(join(tmpdir(), "restow-file-shares-"));
  const storageDir = join(work, "storage");

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    owner.$client.query<T>(text, values).then((result) => result.rows);
  const [provider] = await q<{ id: string }>(
    "INSERT INTO providers (name) VALUES ('p') RETURNING id",
  );
  const created = await q<{ id: string }>(
    "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso'), ($1, 'Fabrikam', 'fabrikam') RETURNING id",
    [provider?.id],
  );
  const contoso = created[0]?.id ?? "";
  const fabrikam = created[1]?.id ?? "";
  await q("INSERT INTO settings (singleton) VALUES (true) ON CONFLICT DO NOTHING");
  const kek = randomBytes(32);
  const provideKeys = new EnvKeyProvider(kek);
  for (const tenantId of [contoso, fabrikam]) {
    const dek = generateDek(1);
    await q(
      "INSERT INTO tenant_keys (tenant_id, key_version, encrypted_dek, kek_id) VALUES ($1, 1, $2, 'env:RESTOW_MASTER_KEY')",
      [tenantId, (await provideKeys.wrapDek(dek)).toString("base64")],
    );
  }
  const keyrings = new TenantCache<TenantKeyring>((tenantId) =>
    loadTenantKeyring({ db: appDb, tenantId, keyProvider: provideKeys }),
  );
  const storage = new TenantCache<StorageTargets>(async () => ({
    primary: new LocalStorageBackend(storageDir),
    copies: [],
  }));
  const clock = { now: new Date() };
  const runner = new FakeRunner();
  const deps: FileShareDeps = {
    db: appDb,
    providerDb,
    runtime: {
      keyrings,
      storage,
      logger: noopLogger,
      now: () => clock.now,
      shutdownSignal: new AbortController().signal,
    },
    runner,
    mounterCaps: { maxRunners: 8, maxMemoryMiB: 16384 },
    resolve: async () => ["10.20.30.40"],
    maintenanceLockWaitMs: 5_000,
  };
  return {
    owner,
    appDb,
    providerDb,
    masterKey: kek.toString("base64"),
    url: url.toString(),
    roles,
    work,
    storageDir,
    contoso,
    fabrikam,
    runner,
    deps,
    clock,
    async cleanup() {
      await Promise.all([appDb.$client.end(), providerDb.$client.end(), owner.$client.end()]);
      await dropTestDatabase(adminUrl as string, database);
      const dropper = createDb(adminUrl as string);
      for (const role of [roles.tenant.name, roles.installation.name]) {
        await dropper.$client.query(`DROP ROLE IF EXISTS ${role}`);
      }
      await dropper.$client.end();
      await rm(work, { recursive: true, force: true });
    },
  };
}

/** The URL of the database as one of the provisioned roles. */
export function roleUrl(fixture: ShareFixture, login: RoleLogin): string {
  const copy = new URL(fixture.url);
  copy.username = login.name;
  copy.password = login.password;
  return copy.toString();
}

/** Seal a tenant secret as the api does. */
export async function storeTenantSecret(
  fixture: ShareFixture,
  tenantId: string,
  kind: string,
  plaintext: string,
): Promise<string> {
  const keys = await fixture.deps.runtime.keyrings.get(tenantId);
  const id = randomUUID();
  await withTenantTx(fixture.appDb, tenantId, (tx) =>
    tx.insert(secrets).values({
      id,
      tenantId,
      kind,
      ciphertext: sealSecret(keys.current, id, plaintext),
      keyVersion: keys.current.version,
    }),
  );
  return id;
}

/** A share of the tenant (NFS on an approved private address unless said otherwise). */
export async function addShare(
  fixture: ShareFixture,
  tenantId: string,
  values: Partial<NewFileShare> = {},
): Promise<FileShare> {
  const [row] = await withTenantTx(fixture.appDb, tenantId, (tx) =>
    tx
      .insert(fileShares)
      .values({
        tenantId,
        name: `Share ${randomBytes(3).toString("hex")}`,
        protocol: "nfs",
        server: "nfs.example.test",
        exportPath: "/srv/data",
        nfsVersion: "4.1",
        privateNetworkApproval: {
          by: "admin@provider.test",
          at: new Date().toISOString(),
          address: "10.20.30.1",
          range: "10.20.30.0/24",
        },
        ...values,
      })
      .returning(),
  );
  return row as FileShare;
}

/** A share job with these shares as members. */
export async function addShareJob(
  fixture: ShareFixture,
  tenantId: string,
  shareIds: string[],
  options: {
    schedule?: BackupJobSchedule | null;
    settings?: Record<string, unknown>;
    enabled?: boolean;
    nextRunAt?: Date | null;
    memberOverrides?: Record<string, unknown>;
  } = {},
): Promise<string> {
  return withTenantTx(fixture.appDb, tenantId, async (tx) => {
    const [job] = await tx
      .insert(backupJobs)
      .values({
        tenantId,
        kind: "share",
        name: `Shares ${randomBytes(3).toString("hex")}`,
        schedule:
          options.schedule === undefined
            ? { kind: "daily", timeOfDay: "02:00", timeZone: "UTC" }
            : options.schedule,
        settings: options.settings ?? {},
        enabled: options.enabled ?? true,
        nextRunAt: options.nextRunAt ?? null,
      })
      .returning({ id: backupJobs.id });
    for (const shareId of shareIds) {
      await tx.insert(backupJobMembers).values({
        tenantId,
        jobId: job?.id as string,
        fileShareId: shareId,
        overrides: options.memberOverrides ?? {},
      });
    }
    return job?.id as string;
  });
}

/** Read a share again. */
export async function reloadShare(fixture: ShareFixture, share: FileShare): Promise<FileShare> {
  const [row] = await fixture.owner.select().from(fileShares).where(eq(fileShares.id, share.id));
  return row as FileShare;
}
