import { isIP } from "node:net";
import {
  FILE_SHARE_QUEUES,
  type FailureCause,
  type FileShareJobPayload,
  type FileShareSettings,
  type HostResolver,
  type RunnerClient,
  type RunnerListOutput,
  RunnerRefusedError,
  RunnerUnavailableError,
  type ShareSpec,
  approvalRange,
  classifyAddress,
  fileShareRepositoryPrefix,
  fileShareSettingsOf,
  fileShareSingletonKey,
  judgeShareAddresses,
  shareBudgetBytes,
  shareCauseOfCode,
  shareQuotaLevel,
  shareQuotaPercent,
  splitAccount,
  tenantShareBudgetBytes,
} from "@restow/core";
import {
  type Database,
  type FileShare,
  type FileShareRun,
  type FileShareRunParams,
  backupJobs,
  fileShareRunItems,
  fileShareRuns,
  fileShareSnapshots,
  fileShares,
  runSamples,
  secrets,
  settings,
} from "@restow/db";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { providerDb } from "../../db.js";
import { type ProviderRole, providerRoleSatisfies } from "../../lib/provider-access.js";
import { readSecret, replaceSecret, storeSecret } from "../../lib/secrets.js";
import { type DbExecutor, type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { type FailureDto, causeToFailureDto } from "../failures/dto.js";
import { pgBossExecutor } from "../jobs/pg-boss-tx.js";
import { isMissingQueueSchema, jobQueue } from "../jobs/queue.js";
import { ENABLE_MOUNTER_COMMAND } from "../mounts/service.js";
import { FILE_SHARE_TENANT_AUDIT_ACTIONS as A, type FileShareActor, auditShare } from "./audit.js";
import { FILE_SHARE_PROBLEMS } from "./constants.js";
import {
  type FileShareSummaryDto,
  type ShareQuotaDto,
  type ShareRunDetailDto,
  type ShareRunDto,
  locationOf,
  shareRunDto,
  shareSummaryDto,
} from "./dto.js";
import { type ShareCounts, loadShareFacts, shareCountsOf } from "./protection.js";
import { fileShareResolver, fileShareRunner } from "./runner.js";
import type {
  CreateShareInput,
  InstallationSettingsInput,
  RestoreInput,
  TestConnectionInput,
  UpdateShareInput,
} from "./schemas.js";
import { forgetFileShareSettings } from "./settings.js";

/**
 * File shares of a tenant (docs/FILESHARES.md 9.1): add, change, test, browse the live share,
 * back up now, restore, retire and purge. Nothing here restarts anything: a test and a folder
 * listing run in a short-lived runner container through the mounter (3.1), backups and restores
 * are rows the worker's dispatcher starts (8.2). Every change is audited (9.2), in the
 * transaction that makes it. Passwords are sealed with the tenant key and opened only for the
 * one mounter request that needs them.
 */

/** Who acts, and in which capacity: a provider admin approves private addresses by saving them. */
export interface ShareContext {
  actor: FileShareActor;
  isProviderAdmin: boolean;
  /** The provider admin's team role; null for a tenant admin. */
  providerRole: ProviderRole | null;
  now?: Date;
  /** Tests: the mounter and the name resolution. */
  runner?: RunnerClient;
  resolve?: HostResolver;
  /** Tests: where pg-boss jobs go (default: the queue, in the request's transaction). */
  send?: (queue: string, payload: object, singletonKey: string) => Promise<string | null>;
}

const nowOf = (ctx: Pick<ShareContext, "now">) => ctx.now ?? new Date();
const runnerOf = (ctx: Pick<ShareContext, "runner">) => ctx.runner ?? fileShareRunner();
const resolverOf = (ctx: Pick<ShareContext, "resolve">) => ctx.resolve ?? fileShareResolver();

function notFound(): ProblemError {
  return new ProblemError(404, "File share not found");
}

function invalid(field: string, message: string, extensions: Record<string, unknown> = {}) {
  return new ProblemError(422, "Invalid file share", {
    type: FILE_SHARE_PROBLEMS.invalid,
    detail: `${field}: ${message}`,
    extensions: { field, issues: [{ path: [field], message }], ...extensions },
  });
}

function isUnique(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

function nameTaken(name: string): ProblemError {
  return new ProblemError(409, "Name in use", {
    type: FILE_SHARE_PROBLEMS.nameTaken,
    detail: `Another file share of this tenant is named "${name}".`,
    extensions: { field: "name" },
  });
}

export async function loadShare(tx: Transaction, tenantId: string, id: string): Promise<FileShare> {
  const [row] = await tx
    .select()
    .from(fileShares)
    .where(and(eq(fileShares.tenantId, tenantId), eq(fileShares.id, id)))
    .limit(1);
  if (!row) {
    throw notFound();
  }
  return row;
}

// ---------------------------------------------------------------------------
// Installation settings (7.4)
// ---------------------------------------------------------------------------

export async function readInstallationSettings(): Promise<FileShareSettings> {
  const [row] = await providerDb
    .select({ value: settings.fileShareSettings })
    .from(settings)
    .limit(1);
  return fileShareSettingsOf(row?.value ?? {});
}

async function rawInstallationSettings(): Promise<Record<string, unknown>> {
  const [row] = await providerDb
    .select({ value: settings.fileShareSettings })
    .from(settings)
    .limit(1);
  return { ...(row?.value ?? {}) };
}

export interface FileShareRunnerStateDto {
  /** The mounter answered. */
  available: boolean;
  /** Its runner can start containers. */
  ready: boolean;
  blockers: { code: string; detail: string }[];
  running: number;
  limit: number | null;
}

async function runnerState(runner: RunnerClient): Promise<FileShareRunnerStateDto> {
  if (!runner.enabled) {
    return { available: false, ready: false, blockers: [], running: 0, limit: null };
  }
  const caps = await runner.capabilities().catch(() => null);
  if (!caps) {
    return { available: false, ready: false, blockers: [], running: 0, limit: null };
  }
  return {
    available: true,
    ready: caps.ready,
    blockers: caps.blockers.map((blocker) => ({ code: blocker.code, detail: blocker.detail })),
    running: caps.running,
    limit: caps.limit,
  };
}

export interface TenantShareSettingsDto {
  runner: FileShareRunnerStateDto;
  /** The one command that starts the mounter (docs/MOUNTS.md). */
  enableCommand: string;
  tenantsMayUsePrivateNetworks: boolean;
  maxRunHours: number;
  catalogEnabled: boolean;
  /** The budget of all shares of this tenant in GiB; null = none. */
  tenantQuotaGib: number | null;
  /** What a new share gets as its budget in GiB; null = none. */
  defaultShareQuotaGib: number | null;
}

/** GET /settings: what of the installation concerns a tenant's shares. */
export async function tenantShareSettings(
  tenantId: string,
  ctx: Pick<ShareContext, "runner">,
): Promise<TenantShareSettingsDto> {
  const value = await readInstallationSettings();
  const own = value.tenantShareQuotaGibByTenant[tenantId];
  const tenantQuota = own !== undefined ? own : value.tenantShareQuotaGib;
  return {
    runner: await runnerState(runnerOf(ctx)),
    enableCommand: ENABLE_MOUNTER_COMMAND,
    tenantsMayUsePrivateNetworks: value.tenantsMayUsePrivateNetworks,
    maxRunHours: value.maxRunHours,
    catalogEnabled: value.catalog.enabled,
    tenantQuotaGib: tenantQuota > 0 ? tenantQuota : null,
    defaultShareQuotaGib: value.defaultShareQuotaGib > 0 ? value.defaultShareQuotaGib : null,
  };
}

export interface InstallationShareSettingsDto {
  settings: FileShareSettings;
  runner: FileShareRunnerStateDto;
  enableCommand: string;
}

export async function getInstallationShareSettings(
  ctx: Pick<ShareContext, "runner">,
): Promise<InstallationShareSettingsDto> {
  return {
    settings: await readInstallationSettings(),
    runner: await runnerState(runnerOf(ctx)),
    enableCommand: ENABLE_MOUNTER_COMMAND,
  };
}

/**
 * PUT /installation-settings: provider administrators with every tenant; switching
 * "Tenants may use private networks" is the provider owner's (10.1).
 */
export async function updateInstallationShareSettings(
  input: InstallationSettingsInput,
  ctx: ShareContext,
): Promise<InstallationShareSettingsDto> {
  if (
    input.tenantsMayUsePrivateNetworks !== undefined &&
    ctx.providerRole !== null &&
    ctx.providerRole !== "owner"
  ) {
    throw new ProblemError(403, "Owner only", {
      type: FILE_SHARE_PROBLEMS.providerOnly,
      detail: "Only the provider owner decides whether tenants may use private networks.",
      extensions: { field: "tenantsMayUsePrivateNetworks", required: "owner" },
    });
  }
  const before = await rawInstallationSettings();
  const next: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || key === "tenantShareQuotaGibByTenant" || key === "catalog") {
      continue;
    }
    next[key] = value;
  }
  if (input.catalog) {
    next.catalog = { ...((before.catalog as Record<string, unknown>) ?? {}), ...input.catalog };
  }
  if (input.tenantShareQuotaGibByTenant) {
    const byTenant = { ...((before.tenantShareQuotaGibByTenant as Record<string, number>) ?? {}) };
    for (const [tenantId, gib] of Object.entries(input.tenantShareQuotaGibByTenant)) {
      if (gib === null) {
        delete byTenant[tenantId];
      } else {
        byTenant[tenantId] = gib;
      }
    }
    next.tenantShareQuotaGibByTenant = byTenant;
  }
  const changed = Object.keys(input).filter(
    (key) => input[key as keyof InstallationSettingsInput] !== undefined,
  );
  await providerDb.transaction(async (tx) => {
    const [row] = await tx.select({ id: settings.id }).from(settings).limit(1);
    if (row) {
      await tx.update(settings).set({ fileShareSettings: next }).where(eq(settings.id, row.id));
    } else {
      await tx.insert(settings).values({ fileShareSettings: next });
    }
    await auditShare(tx, {
      tenantId: null,
      actor: ctx.actor,
      action: A.settingsChanged,
      shareId: null,
      details: { changed, values: input },
    });
  });
  forgetFileShareSettings();
  return getInstallationShareSettings(ctx);
}

// ---------------------------------------------------------------------------
// Addresses (10.1)
// ---------------------------------------------------------------------------

async function resolveServer(
  server: string,
  resolve: HostResolver,
): Promise<{ ok: true; addresses: readonly string[] } | { ok: false }> {
  const bare = server.replace(/^\[|\]$/g, "");
  if (isIP(bare) !== 0) {
    return { ok: true, addresses: [bare] };
  }
  try {
    const addresses = await resolve(bare);
    return addresses.length > 0 ? { ok: true, addresses } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function hostNotAllowed(reason: "private_network" | "forbidden_address"): ProblemError {
  return new ProblemError(422, "Server not allowed", {
    type: FILE_SHARE_PROBLEMS.hostNotAllowed,
    detail:
      reason === "private_network"
        ? "The server is in a loopback or private network. A provider admin has to approve this file share, or allow private networks for tenants."
        : "The server address is link-local, multicast or reserved; file shares are never mounted from there.",
    extensions: { field: "server", reason },
  });
}

/**
 * The private-network approval a share is saved with (10.1): public addresses need none; a
 * forbidden one is refused for everyone; a private one is approved by a provider admin's saving
 * it, allowed for a tenant admin under the installation switch or an approval that covers it,
 * refused otherwise. A name that does not resolve now is judged again on every run and test.
 */
async function approvalForSave(
  server: string,
  current: FileShare["privateNetworkApproval"],
  installation: FileShareSettings,
  ctx: ShareContext,
): Promise<FileShare["privateNetworkApproval"]> {
  const resolved = await resolveServer(server, resolverOf(ctx));
  if (!resolved.ok) {
    return current;
  }
  let firstPrivate: string | null = null;
  for (const address of resolved.addresses) {
    const kind = classifyAddress(address);
    if (kind === "public") {
      continue;
    }
    if (kind !== "private" && kind !== "loopback") {
      throw hostNotAllowed("forbidden_address");
    }
    firstPrivate ??= address;
  }
  if (firstPrivate === null) {
    return null;
  }
  if (ctx.isProviderAdmin) {
    return {
      by: ctx.actor.label,
      at: nowOf(ctx).toISOString(),
      address: firstPrivate,
      range: approvalRange(firstPrivate),
    };
  }
  const decision = judgeShareAddresses(resolved.addresses, {
    privateNetworksAllowed: installation.tenantsMayUsePrivateNetworks,
    approval: current,
  });
  if (!decision.ok) {
    throw hostNotAllowed(
      decision.reason === "forbidden_address" ? "forbidden_address" : "private_network",
    );
  }
  return current;
}

/** The address a test or listing pins, or why none (a result, not an error). */
async function pinForExec(
  server: string,
  approval: FileShare["privateNetworkApproval"],
  installation: FileShareSettings,
  ctx: ShareContext,
): Promise<{ ok: true; address: string } | { ok: false; cause: FailureCause }> {
  const resolved = await resolveServer(server, resolverOf(ctx));
  if (!resolved.ok) {
    return {
      ok: false,
      cause: shareCauseOfCode("unreachable", `the name ${server} does not resolve`),
    };
  }
  const decision = judgeShareAddresses(resolved.addresses, {
    // A provider admin tests and lists what they could approve by saving it.
    privateNetworksAllowed: installation.tenantsMayUsePrivateNetworks || ctx.isProviderAdmin,
    approval,
  });
  if (decision.ok) {
    return decision;
  }
  if (decision.reason === "unresolvable") {
    return {
      ok: false,
      cause: shareCauseOfCode("unreachable", `the name ${server} has no address`),
    };
  }
  throw hostNotAllowed(
    decision.reason === "forbidden_address" ? "forbidden_address" : "private_network",
  );
}

// ---------------------------------------------------------------------------
// The runner's test and listing
// ---------------------------------------------------------------------------

export interface ShareTestResultDto {
  ok: boolean;
  /** The runner's or restow-share's code; null on success. */
  code: string | null;
  /** The failure cause of the catalog (`failures:cause.share.*`); null on success. */
  cause: string | null;
  /** The cause with its steps, as every failure is shown; null on success. */
  failure: FailureDto | null;
  params: Record<string, unknown>;
  /** The redacted technical detail. */
  detail: string | null;
  fsType: string | null;
  entries: NonNullable<RunnerListOutput["entries"]>;
  truncated: boolean;
  permissions: { readable: boolean; xattr: string } | null;
  durationMs: number;
  /** The address the test connected to. */
  address: string | null;
  testedAt: string;
}

function mounterUnavailable(error: RunnerUnavailableError | RunnerRefusedError): ProblemError {
  return new ProblemError(503, "File share runner unavailable", {
    type: FILE_SHARE_PROBLEMS.mounterUnavailable,
    detail:
      "File share backup needs the mounter, which is not running in this installation. A provider owner starts it with the command shown.",
    extensions: {
      reason: error instanceof RunnerUnavailableError ? error.reason : error.code,
      command: ENABLE_MOUNTER_COMMAND,
    },
  });
}

function failedResult(cause: FailureCause, now: Date, address: string | null): ShareTestResultDto {
  return {
    ok: false,
    code: cause.technical?.code !== undefined ? String(cause.technical.code) : null,
    cause: cause.code,
    failure: causeToFailureDto(cause, now),
    params: cause.params ?? {},
    detail: cause.technical?.message !== undefined ? String(cause.technical.message) : null,
    fsType: null,
    entries: [],
    truncated: false,
    permissions: null,
    durationMs: 0,
    address,
    testedAt: now.toISOString(),
  };
}

async function execOnRunner(
  op: "probe" | "list",
  spec: ShareSpec,
  ctx: ShareContext,
  list: { path?: string; limit?: number } = {},
): Promise<ShareTestResultDto> {
  const started = Date.now();
  const now = nowOf(ctx);
  const passwords = spec.protocol === "smb" ? [spec.password] : [];
  let result: Awaited<ReturnType<RunnerClient["exec"]>>;
  try {
    result = await runnerOf(ctx).exec(
      op === "probe"
        ? { op, share: spec }
        : { op, share: spec, path: list.path, limit: list.limit },
    );
  } catch (error) {
    if (error instanceof RunnerUnavailableError) {
      throw mounterUnavailable(error);
    }
    if (error instanceof RunnerRefusedError) {
      if (error.code.startsWith("runner.") && error.code !== "runner.timeout") {
        throw mounterUnavailable(error);
      }
      return failedResult(shareCauseOfCode(error.code, error.detail, passwords), now, spec.address);
    }
    throw error;
  }
  const output = (result.output ?? null) as RunnerListOutput | null;
  if (!result.ok) {
    const cause = shareCauseOfCode(result.code ?? "runner.failed", result.detail, passwords);
    return { ...failedResult(cause, now, spec.address), durationMs: Date.now() - started };
  }
  return {
    ok: true,
    code: null,
    cause: null,
    failure: null,
    params: {},
    detail: null,
    fsType: output?.fsType ?? null,
    entries: (output?.entries ?? []).slice(0, 2000),
    truncated: output?.truncated === true,
    permissions: output?.permissions
      ? { readable: output.permissions.readable, xattr: output.permissions.xattr }
      : null,
    durationMs: output?.durationMs ?? Date.now() - started,
    address: spec.address,
    testedAt: now.toISOString(),
  };
}

interface ConnectionFields {
  protocol: "smb" | "nfs";
  server: string;
  shareName: string | null;
  exportPath: string | null;
  subfolder: string;
  username: string | null;
  domain: string | null;
  smbVersion: FileShare["smbVersion"];
  seal: boolean;
  nfsVersion: FileShare["nfsVersion"];
}

function connectionOfInput(input: TestConnectionInput | CreateShareInput): ConnectionFields {
  if (input.protocol === "smb") {
    const account = splitAccount(input.account);
    return {
      protocol: "smb",
      server: input.server,
      shareName: input.share,
      exportPath: null,
      subfolder: input.subfolder,
      username: account.username,
      domain: account.domain ?? input.domain ?? null,
      smbVersion: input.smbVersion,
      seal: input.seal,
      nfsVersion: null,
    };
  }
  return {
    protocol: "nfs",
    server: input.server,
    shareName: null,
    exportPath: input.export,
    subfolder: input.subfolder,
    username: null,
    domain: null,
    smbVersion: null,
    seal: false,
    nfsVersion: input.nfsVersion,
  };
}

function specOf(fields: ConnectionFields, address: string, password: string | null): ShareSpec {
  if (fields.protocol === "smb") {
    return {
      protocol: "smb",
      server: fields.server,
      address,
      share: fields.shareName ?? "",
      subfolder: fields.subfolder,
      username: fields.username ?? "",
      password: password ?? "",
      domain: fields.domain,
      smbVersion: fields.smbVersion ?? "3.1.1",
      seal: fields.seal,
    };
  }
  return {
    protocol: "nfs",
    server: fields.server,
    address,
    export: fields.exportPath ?? "/",
    subfolder: fields.subfolder,
    nfsVersion: fields.nfsVersion ?? "4.1",
  };
}

function fieldsOfShare(share: FileShare): ConnectionFields {
  return {
    protocol: share.protocol,
    server: share.server,
    shareName: share.shareName,
    exportPath: share.exportPath,
    subfolder: share.subfolder,
    username: share.username,
    domain: share.smbDomain,
    smbVersion: share.smbVersion,
    seal: share.smbEncryption,
    nfsVersion: share.nfsVersion,
  };
}

/** POST /test: test settings that are not saved yet (the add dialog, 12.2). */
export async function testUnsavedShare(
  db: Database,
  tenantId: string,
  input: TestConnectionInput,
  ctx: ShareContext,
): Promise<ShareTestResultDto> {
  const installation = await readInstallationSettings();
  const fields = connectionOfInput(input);
  const pinned = await pinForExec(fields.server, null, installation, ctx);
  const result = pinned.ok
    ? await execOnRunner(
        "probe",
        specOf(fields, pinned.address, input.protocol === "smb" ? input.password : null),
        ctx,
      )
    : failedResult(pinned.cause, nowOf(ctx), null);
  await withTenantTx(db, tenantId, (tx) =>
    auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.tested,
      shareId: null,
      details: {
        server: fields.server,
        protocol: fields.protocol,
        ok: result.ok,
        code: result.code,
      },
    }),
  );
  return result;
}

async function sharePassword(db: DbExecutor, share: FileShare): Promise<string | null> {
  if (share.protocol !== "smb" || !share.credentialSecretId) {
    return null;
  }
  return readSecret(db, { id: share.credentialSecretId, tenantId: share.tenantId });
}

/** POST /:id/test: test the stored settings; keeps the result on the share. */
export async function testStoredShare(
  db: Database,
  tenantId: string,
  id: string,
  ctx: ShareContext,
): Promise<ShareTestResultDto> {
  const share = await withTenantTx(db, tenantId, (tx) => loadShare(tx, tenantId, id));
  const installation = await readInstallationSettings();
  const pinned = await pinForExec(share.server, share.privateNetworkApproval, installation, ctx);
  let result: ShareTestResultDto;
  if (!pinned.ok) {
    result = failedResult(pinned.cause, nowOf(ctx), null);
  } else {
    const password = await sharePassword(db, share);
    if (share.protocol === "smb" && !password) {
      result = failedResult(
        shareCauseOfCode("mount.auth_failed", "no password is stored for the account"),
        nowOf(ctx),
        pinned.address,
      );
    } else {
      result = await execOnRunner(
        "probe",
        specOf(fieldsOfShare(share), pinned.address, password),
        ctx,
      );
    }
  }
  const now = nowOf(ctx);
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(fileShares)
      .set({
        lastTest: {
          ok: result.ok,
          code: result.cause,
          at: now.toISOString(),
          durationMs: result.durationMs,
        },
        ...(result.ok
          ? { credentialFailedAt: null }
          : result.cause === "share.auth_failed"
            ? { credentialFailedAt: now }
            : {}),
      })
      .where(eq(fileShares.id, id));
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.tested,
      shareId: id,
      details: { name: share.name, ok: result.ok, code: result.code },
    });
  });
  return result;
}

export interface ShareSourceDto {
  ok: boolean;
  path: string;
  entries: ShareTestResultDto["entries"];
  truncated: boolean;
  cause: string | null;
  failure: FailureDto | null;
  params: Record<string, unknown>;
  detail: string | null;
}

/** GET /:id/source: one folder of the live share, for picking include folders and targets. */
export async function listShareSource(
  db: Database,
  tenantId: string,
  id: string,
  query: { path: string; limit: number },
  ctx: ShareContext,
): Promise<ShareSourceDto> {
  const share = await withTenantTx(db, tenantId, (tx) => loadShare(tx, tenantId, id));
  const installation = await readInstallationSettings();
  const pinned = await pinForExec(share.server, share.privateNetworkApproval, installation, ctx);
  let result: ShareTestResultDto;
  if (!pinned.ok) {
    result = failedResult(pinned.cause, nowOf(ctx), null);
  } else {
    const password = await sharePassword(db, share);
    result = await execOnRunner(
      "list",
      specOf(fieldsOfShare(share), pinned.address, password),
      ctx,
      { path: query.path, limit: query.limit },
    );
  }
  return {
    ok: result.ok,
    path: query.path,
    entries: result.entries,
    truncated: result.truncated,
    cause: result.cause,
    failure: result.failure,
    params: result.params,
    detail: result.detail,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ShareListDto {
  items: FileShareSummaryDto[];
  counts: ShareCounts;
}

export async function listShares(
  db: Database,
  tenantId: string,
  query: { retired: "include" | "only" | "exclude" },
  now: Date = new Date(),
): Promise<ShareListDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const facts = await loadShareFacts(tx, tenantId, now);
    const shown = facts.filter((fact) =>
      query.retired === "include"
        ? true
        : query.retired === "only"
          ? fact.share.retiredAt !== null
          : fact.share.retiredAt === null,
    );
    return { items: shown.map(shareSummaryDto), counts: shareCountsOf(facts) };
  });
}

export interface ShareCopyJobDto {
  id: string;
  name: string;
  enabled: boolean;
  role: "source" | "target";
  mode: "overwrite" | "mirror";
  targetFolder: string;
  sourceShareId: string;
  targetShareId: string;
}

export interface FileShareDetailDto extends FileShareSummaryDto {
  runs: ShareRunDto[];
  copyJobs: ShareCopyJobDto[];
  quota: ShareQuotaDto;
}

async function quotaOf(
  tx: Transaction,
  share: FileShare,
  installation: FileShareSettings,
): Promise<ShareQuotaDto> {
  const [total] = await tx
    .select({ bytes: sql<string | null>`sum(${fileShares.repositoryBytes})` })
    .from(fileShares)
    .where(eq(fileShares.tenantId, share.tenantId));
  const tenantUsed = Number(total?.bytes ?? 0);
  const shareBudget = shareBudgetBytes(share.quotaGib);
  const tenantBudget = tenantShareBudgetBytes(installation, share.tenantId);
  const usage = {
    shareUsed: share.repositoryBytes ?? 0,
    shareBudget,
    tenantUsed,
    tenantBudget,
  };
  const own = installation.tenantShareQuotaGibByTenant[share.tenantId];
  const tenantGib = own !== undefined ? own : installation.tenantShareQuotaGib;
  return {
    usedBytes: share.repositoryBytes,
    quotaGib: share.quotaGib,
    tenantQuotaGib: tenantGib > 0 ? tenantGib : null,
    tenantUsedBytes: tenantUsed,
    percent: shareQuotaPercent(usage),
    level: shareQuotaLevel(usage),
    refusedAt: share.quotaRefusedAt ? share.quotaRefusedAt.toISOString() : null,
  };
}

export async function getShare(
  db: Database,
  tenantId: string,
  id: string,
  now: Date = new Date(),
): Promise<FileShareDetailDto> {
  const installation = await readInstallationSettings();
  return withTenantTx(db, tenantId, async (tx) => {
    const [fact] = await loadShareFacts(tx, tenantId, now, { shareIds: [id] });
    if (!fact) {
      throw notFound();
    }
    const runs = await tx
      .select()
      .from(fileShareRuns)
      .where(
        and(
          eq(fileShareRuns.tenantId, tenantId),
          or(eq(fileShareRuns.fileShareId, id), eq(fileShareRuns.lockShareId, id)),
        ),
      )
      .orderBy(desc(fileShareRuns.queuedAt))
      .limit(20);
    const copies = await tx
      .select()
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.tenantId, tenantId),
          eq(backupJobs.kind, "copy"),
          or(eq(backupJobs.sourceFileShareId, id), eq(backupJobs.targetFileShareId, id)),
        ),
      );
    return {
      ...shareSummaryDto(fact),
      runs: runs.map(shareRunDto),
      copyJobs: copies.map((job) => ({
        id: job.id,
        name: job.name,
        enabled: job.enabled,
        role: job.sourceFileShareId === id ? "source" : "target",
        mode: job.settings.mode ?? "overwrite",
        targetFolder: job.settings.targetFolder ?? "",
        sourceShareId: job.sourceFileShareId as string,
        targetShareId: job.targetFileShareId as string,
      })),
      quota: await quotaOf(tx, fact.share, installation),
    };
  });
}

/** GET /restore-targets: the tenant's shares that allow restores into them. */
export async function restoreTargets(
  db: Database,
  tenantId: string,
): Promise<{ items: { id: string; name: string; protocol: "smb" | "nfs"; location: string }[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(fileShares)
      .where(
        and(
          eq(fileShares.tenantId, tenantId),
          eq(fileShares.allowRestore, true),
          isNull(fileShares.retiredAt),
        ),
      )
      .orderBy(fileShares.name);
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        protocol: row.protocol,
        location: locationOf(row),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Adding and changing
// ---------------------------------------------------------------------------

const NAME_INDEX = "file_shares_tenant_name_uq";

export async function createShare(
  db: Database,
  tenantId: string,
  input: CreateShareInput,
  ctx: ShareContext,
): Promise<FileShareDetailDto> {
  const installation = await readInstallationSettings();
  const fields = connectionOfInput(input);
  const approval = await approvalForSave(fields.server, null, installation, ctx);
  let id: string;
  try {
    id = await withTenantTx(db, tenantId, async (tx) => {
      let credentialSecretId: string | null = null;
      if (input.protocol === "smb") {
        const ref = await storeSecret(tx, {
          tenantId,
          kind: "file_share_password",
          plaintext: input.password,
        });
        credentialSecretId = ref.id;
      }
      const [row] = await tx
        .insert(fileShares)
        .values({
          tenantId,
          name: input.name,
          protocol: fields.protocol,
          server: fields.server,
          shareName: fields.shareName,
          exportPath: fields.exportPath,
          subfolder: fields.subfolder,
          smbVersion: fields.smbVersion,
          smbEncryption: fields.seal,
          smbDomain: fields.domain,
          username: fields.username,
          credentialSecretId,
          nfsVersion: fields.nfsVersion,
          allowRestore: input.allowRestore,
          permissionsMode: input.permissionsMode,
          rereadPermissions: input.rereadPermissions,
          privateNetworkApproval: approval,
          quotaGib:
            installation.defaultShareQuotaGib > 0 ? installation.defaultShareQuotaGib : null,
          createdBy: ctx.actor.userId,
        })
        .returning({ id: fileShares.id });
      if (!row) {
        throw new Error("file share insert returned no row");
      }
      await auditShare(tx, {
        tenantId,
        actor: ctx.actor,
        action: A.created,
        shareId: row.id,
        details: {
          name: input.name,
          protocol: fields.protocol,
          server: fields.server,
          share: fields.shareName ?? fields.exportPath,
          subfolder: fields.subfolder,
          username: fields.username,
          allowRestore: input.allowRestore,
        },
      });
      if (approval) {
        await auditShare(tx, {
          tenantId,
          actor: ctx.actor,
          action: A.privateNetworkApproved,
          shareId: row.id,
          details: { name: input.name, address: approval.address, range: approval.range },
        });
      }
      return row.id;
    });
  } catch (error) {
    if (isUnique(error, NAME_INDEX)) {
      throw nameTaken(input.name);
    }
    throw error;
  }
  return getShare(db, tenantId, id, nowOf(ctx));
}

function locationChanged(before: FileShare, after: ConnectionFields): boolean {
  return (
    before.server !== after.server ||
    (before.shareName ?? null) !== (after.shareName ?? null) ||
    (before.exportPath ?? null) !== (after.exportPath ?? null) ||
    before.subfolder !== after.subfolder
  );
}

export async function updateShare(
  db: Database,
  tenantId: string,
  id: string,
  patch: UpdateShareInput,
  ctx: ShareContext,
): Promise<FileShareDetailDto> {
  const installation = await readInstallationSettings();
  const before = await withTenantTx(db, tenantId, (tx) => loadShare(tx, tenantId, id));
  const smb = before.protocol === "smb";
  if (
    !smb &&
    (patch.share !== undefined ||
      patch.account !== undefined ||
      patch.password !== undefined ||
      patch.smbVersion !== undefined ||
      patch.seal !== undefined ||
      patch.domain !== undefined)
  ) {
    throw invalid(
      "protocol",
      "An NFS export has no share name, account, password, SMB version or encryption.",
    );
  }
  if (smb && (patch.export !== undefined || patch.nfsVersion !== undefined)) {
    throw invalid("protocol", "An SMB share has no export path or NFS version.");
  }
  const account = patch.account !== undefined ? splitAccount(patch.account) : null;
  const after: ConnectionFields = {
    ...fieldsOfShare(before),
    ...(patch.server !== undefined ? { server: patch.server } : {}),
    ...(patch.share !== undefined ? { shareName: patch.share } : {}),
    ...(patch.export !== undefined ? { exportPath: patch.export } : {}),
    ...(patch.subfolder !== undefined ? { subfolder: patch.subfolder } : {}),
    ...(account ? { username: account.username } : {}),
    ...(account?.domain
      ? { domain: account.domain }
      : patch.domain !== undefined
        ? { domain: patch.domain }
        : {}),
    ...(patch.smbVersion !== undefined ? { smbVersion: patch.smbVersion } : {}),
    ...(patch.seal !== undefined ? { seal: patch.seal } : {}),
    ...(patch.nfsVersion !== undefined ? { nfsVersion: patch.nfsVersion } : {}),
  };
  if (after.seal && after.smbVersion === "2.1") {
    throw invalid("seal", "Encryption needs SMB 3.0 or newer.");
  }
  const moved = locationChanged(before, after);
  const approval =
    before.server !== after.server || (ctx.isProviderAdmin && moved)
      ? await approvalForSave(after.server, before.privateNetworkApproval, installation, ctx)
      : before.privateNetworkApproval;
  try {
    await withTenantTx(db, tenantId, async (tx) => {
      if (moved && !patch.confirmNewLocation) {
        const [points] = await tx
          .select({ n: count() })
          .from(fileShareSnapshots)
          .where(eq(fileShareSnapshots.fileShareId, id));
        if (Number(points?.n ?? 0) > 0) {
          throw new ProblemError(409, "Confirm the new location", {
            type: FILE_SHARE_PROBLEMS.locationChange,
            detail:
              "This file share has restore points. After a change of server, share, export or folder the next backup reads every file again.",
            extensions: { restorePoints: Number(points?.n ?? 0) },
          });
        }
      }
      const changed: string[] = [];
      const set: Partial<typeof fileShares.$inferInsert> = {};
      const compare = <K extends keyof typeof fileShares.$inferInsert>(
        key: K,
        value: (typeof fileShares.$inferInsert)[K] | undefined,
        current: unknown,
      ) => {
        if (value !== undefined && value !== current) {
          set[key] = value;
          changed.push(key);
        }
      };
      compare("name", patch.name, before.name);
      compare("server", after.server, before.server);
      compare("shareName", after.shareName, before.shareName);
      compare("exportPath", after.exportPath, before.exportPath);
      compare("subfolder", after.subfolder, before.subfolder);
      compare("username", after.username, before.username);
      compare("smbDomain", after.domain, before.smbDomain);
      compare("smbVersion", after.smbVersion, before.smbVersion);
      compare("smbEncryption", after.seal, before.smbEncryption);
      compare("nfsVersion", after.nfsVersion, before.nfsVersion);
      compare("allowRestore", patch.allowRestore, before.allowRestore);
      compare("permissionsMode", patch.permissionsMode, before.permissionsMode);
      compare("rereadPermissions", patch.rereadPermissions, before.rereadPermissions);
      if (JSON.stringify(approval) !== JSON.stringify(before.privateNetworkApproval)) {
        set.privateNetworkApproval = approval;
      }
      if (patch.password !== undefined) {
        if (before.credentialSecretId) {
          await replaceSecret(tx, { id: before.credentialSecretId, tenantId }, patch.password);
        } else {
          const ref = await storeSecret(tx, {
            tenantId,
            kind: "file_share_password",
            plaintext: patch.password,
          });
          set.credentialSecretId = ref.id;
        }
        // The new password is tried by the next run or test.
        set.credentialFailedAt = null;
      }
      if (Object.keys(set).length > 0) {
        await tx.update(fileShares).set(set).where(eq(fileShares.id, id));
      }
      if (changed.length > 0) {
        await auditShare(tx, {
          tenantId,
          actor: ctx.actor,
          action: A.updated,
          shareId: id,
          details: { name: patch.name ?? before.name, changed, newLocation: moved },
        });
      }
      if (patch.password !== undefined) {
        await auditShare(tx, {
          tenantId,
          actor: ctx.actor,
          action: A.passwordChanged,
          shareId: id,
          details: { name: patch.name ?? before.name, username: after.username },
        });
      }
      if (set.privateNetworkApproval !== undefined) {
        await auditShare(tx, {
          tenantId,
          actor: ctx.actor,
          action: approval ? A.privateNetworkApproved : A.privateNetworkWithdrawn,
          shareId: id,
          details: { name: patch.name ?? before.name, address: approval?.address ?? null },
        });
      }
      if (patch.allowRestore === false && before.allowRestore) {
        // A copy job into a share that no longer allows restores stops (4.10 rule 1).
        await tx
          .update(backupJobs)
          .set({ enabled: false })
          .where(and(eq(backupJobs.kind, "copy"), eq(backupJobs.targetFileShareId, id)));
      }
    });
  } catch (error) {
    if (isUnique(error, NAME_INDEX)) {
      throw nameTaken(patch.name ?? before.name);
    }
    throw error;
  }
  return getShare(db, tenantId, id, nowOf(ctx));
}

/** PUT /:id/private-network-approval: a provider admin approves or withdraws (10.1). */
export async function setPrivateNetworkApproval(
  db: Database,
  tenantId: string,
  id: string,
  approved: boolean,
  ctx: ShareContext,
): Promise<FileShareDetailDto> {
  const share = await withTenantTx(db, tenantId, (tx) => loadShare(tx, tenantId, id));
  let approval: FileShare["privateNetworkApproval"] = null;
  if (approved) {
    const resolved = await resolveServer(share.server, resolverOf(ctx));
    if (!resolved.ok) {
      throw invalid("server", "The server name does not resolve; it cannot be approved now.");
    }
    const forbidden = resolved.addresses.some((address) => {
      const kind = classifyAddress(address);
      return kind !== "public" && kind !== "private" && kind !== "loopback";
    });
    if (forbidden) {
      throw hostNotAllowed("forbidden_address");
    }
    const address =
      resolved.addresses.find((candidate) => classifyAddress(candidate) !== "public") ??
      (resolved.addresses[0] as string);
    approval = {
      by: ctx.actor.label,
      at: nowOf(ctx).toISOString(),
      address,
      range: approvalRange(address),
    };
  }
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(fileShares)
      .set({ privateNetworkApproval: approval })
      .where(eq(fileShares.id, id));
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: approved ? A.privateNetworkApproved : A.privateNetworkWithdrawn,
      shareId: id,
      details: {
        name: share.name,
        address: approval?.address ?? null,
        range: approval?.range ?? null,
      },
    });
  });
  return getShare(db, tenantId, id, nowOf(ctx));
}

/** PUT /:id/quota: a provider admin sets the share's budget (7.4); null removes it. */
export async function setShareQuota(
  db: Database,
  tenantId: string,
  id: string,
  quotaGib: number | null,
  ctx: ShareContext,
): Promise<FileShareDetailDto> {
  if (
    !ctx.isProviderAdmin ||
    (ctx.providerRole && !providerRoleSatisfies(ctx.providerRole, "administrator"))
  ) {
    throw new ProblemError(403, "Provider administrators only", {
      type: FILE_SHARE_PROBLEMS.providerOnly,
      detail: "The storage budget of a file share is set by the provider's administrators.",
    });
  }
  await withTenantTx(db, tenantId, async (tx) => {
    const share = await loadShare(tx, tenantId, id);
    await tx
      .update(fileShares)
      .set({
        quotaGib,
        // A new budget is judged anew: the alert re-arms, a refusal is history.
        quotaAlertLevel: null,
        quotaAlertedAt: null,
        quotaRefusedAt: null,
      })
      .where(eq(fileShares.id, id));
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.quotaChanged,
      shareId: id,
      details: { name: share.name, from: share.quotaGib, to: quotaGib },
    });
  });
  return getShare(db, tenantId, id, nowOf(ctx));
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Queue a pg-boss job in the request's transaction (it is sent only if the change commits). */
async function sendJob(
  db: Database,
  tx: Transaction,
  ctx: Pick<ShareContext, "send">,
  queue: string,
  payload: object,
  singletonKey: string,
): Promise<boolean> {
  try {
    const jobId = ctx.send
      ? await ctx.send(queue, payload, singletonKey)
      : await jobQueue(db).send(queue, payload, { singletonKey, db: pgBossExecutor(tx) });
    return jobId !== null && jobId !== undefined;
  } catch (error) {
    if (isMissingQueueSchema(error)) {
      throw queueNotReady();
    }
    throw error;
  }
}

function queueNotReady(): ProblemError {
  return new ProblemError(503, "Job queue not ready", {
    detail: "The worker has not set up its job queues yet. Try again in a minute.",
  });
}

function retiredProblem(): ProblemError {
  return new ProblemError(409, "File share retired", {
    type: FILE_SHARE_PROBLEMS.retired,
    detail: "This file share is no longer protected. Reactivate it first.",
  });
}

/** POST /:id/backup: back up now. A backup that waits already is answered with that one. */
export async function backupNow(
  db: Database,
  tenantId: string,
  id: string,
  input: { allowEmptyOnce: boolean },
  ctx: ShareContext,
): Promise<{ run: ShareRunDto; alreadyQueued: boolean }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const share = await loadShare(tx, tenantId, id);
    if (share.retiredAt) {
      throw retiredProblem();
    }
    const [waiting] = await tx
      .select()
      .from(fileShareRuns)
      .where(
        and(
          eq(fileShareRuns.fileShareId, id),
          eq(fileShareRuns.kind, "backup"),
          eq(fileShareRuns.status, "queued"),
        ),
      )
      .limit(1);
    if (waiting) {
      if (input.allowEmptyOnce && waiting.params.allowEmptyOnce !== true) {
        await tx
          .update(fileShareRuns)
          .set({ params: { ...waiting.params, allowEmptyOnce: true } })
          .where(eq(fileShareRuns.id, waiting.id));
      }
      return { run: shareRunDto(waiting), alreadyQueued: true };
    }
    const [member] = await tx
      .execute<{ job_id: string }>(
        sql`SELECT m.job_id FROM backup_job_members m JOIN backup_jobs j ON j.id = m.job_id
           WHERE m.file_share_id = ${id} AND j.kind = 'share' LIMIT 1`,
      )
      .then((result) => result.rows);
    const params: FileShareRunParams = input.allowEmptyOnce ? { allowEmptyOnce: true } : {};
    const [run] = await tx
      .insert(fileShareRuns)
      .values({
        tenantId,
        fileShareId: id,
        lockShareId: id,
        kind: "backup",
        status: "queued",
        trigger: "manual",
        backupJobId: member?.job_id ?? null,
        params,
        requestedBy: ctx.actor.userId,
        queuedAt: nowOf(ctx),
      })
      .returning();
    if (!run) {
      throw new Error("file share run insert returned no row");
    }
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.backupRequested,
      shareId: id,
      details: { name: share.name, runId: run.id, allowEmptyOnce: input.allowEmptyOnce },
    });
    return { run: shareRunDto(run), alreadyQueued: false };
  });
}

export async function listRuns(
  db: Database,
  tenantId: string,
  id: string,
  query: { limit: number; kind?: "backup" | "restore" },
): Promise<{ items: ShareRunDto[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    await loadShare(tx, tenantId, id);
    const rows = await tx
      .select()
      .from(fileShareRuns)
      .where(
        and(
          eq(fileShareRuns.tenantId, tenantId),
          or(eq(fileShareRuns.fileShareId, id), eq(fileShareRuns.lockShareId, id)),
          query.kind ? eq(fileShareRuns.kind, query.kind) : undefined,
        ),
      )
      .orderBy(desc(fileShareRuns.queuedAt))
      .limit(query.limit);
    return { items: rows.map(shareRunDto) };
  });
}

async function loadRun(
  tx: Transaction,
  tenantId: string,
  id: string,
  runId: string,
): Promise<FileShareRun> {
  const [run] = await tx
    .select()
    .from(fileShareRuns)
    .where(
      and(
        eq(fileShareRuns.tenantId, tenantId),
        eq(fileShareRuns.id, runId),
        or(eq(fileShareRuns.fileShareId, id), eq(fileShareRuns.lockShareId, id)),
      ),
    )
    .limit(1);
  if (!run) {
    throw new ProblemError(404, "Run not found");
  }
  return run;
}

export async function getRun(
  db: Database,
  tenantId: string,
  id: string,
  runId: string,
  query: { limit: number; offset: number; code?: string },
): Promise<ShareRunDetailDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const run = await loadRun(tx, tenantId, id, runId);
    const items = await tx
      .select({
        path: fileShareRunItems.path,
        code: fileShareRunItems.code,
        phase: fileShareRunItems.phase,
        message: fileShareRunItems.message,
      })
      .from(fileShareRunItems)
      .where(
        and(
          eq(fileShareRunItems.runId, runId),
          query.code ? eq(fileShareRunItems.code, query.code) : undefined,
        ),
      )
      .orderBy(fileShareRunItems.code, fileShareRunItems.path)
      .limit(query.limit)
      .offset(query.offset);
    const grouped = await tx
      .select({ code: fileShareRunItems.code, n: count() })
      .from(fileShareRunItems)
      .where(eq(fileShareRunItems.runId, runId))
      .groupBy(fileShareRunItems.code);
    const itemCounts: Record<string, number> = {};
    for (const [code, value] of Object.entries(run.stats.items ?? {})) {
      if (typeof value === "number") itemCounts[code] = value;
    }
    for (const row of grouped) {
      itemCounts[row.code] = Math.max(itemCounts[row.code] ?? 0, Number(row.n));
    }
    const [sampleRow] = await tx
      .select({ points: runSamples.points })
      .from(runSamples)
      .where(eq(runSamples.fileShareRunId, runId))
      .limit(1);
    return {
      ...shareRunDto(run),
      logTail: run.logTail,
      itemsStored: run.itemsStored,
      itemCounts,
      items,
      samples: (sampleRow?.points ?? []).map(([at, processed, transferred]) => ({
        at: new Date(at).toISOString(),
        bytesDone: processed,
        filesDone: transferred,
      })),
    };
  });
}

/** POST /:id/runs/:runId/cancel: a waiting run ends at once, a running one at its next report. */
export async function cancelRun(
  db: Database,
  tenantId: string,
  id: string,
  runId: string,
  ctx: ShareContext,
): Promise<ShareRunDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const run = await loadRun(tx, tenantId, id, runId);
    const now = nowOf(ctx);
    let updated: FileShareRun | undefined;
    if (run.status === "queued") {
      [updated] = await tx
        .update(fileShareRuns)
        .set({
          status: "cancelled",
          cancelRequestedAt: now,
          finishedAt: now,
          finishProcessedAt: now,
          params: { ...run.params, note: "Cancelled before it started" },
        })
        .where(and(eq(fileShareRuns.id, runId), eq(fileShareRuns.status, "queued")))
        .returning();
    } else if (run.status === "starting" || run.status === "running") {
      [updated] = await tx
        .update(fileShareRuns)
        .set({ cancelRequestedAt: now })
        .where(eq(fileShareRuns.id, runId))
        .returning();
    } else {
      throw new ProblemError(409, "Run already finished", {
        type: FILE_SHARE_PROBLEMS.busy,
        detail: "This run has ended already.",
      });
    }
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.runCancelled,
      shareId: id,
      details: { runId, kind: run.kind, status: run.status },
    });
    return shareRunDto(updated ?? run);
  });
}

/** POST /:id/verify: the restore check of the newest restore point now. */
export async function requestVerify(
  db: Database,
  tenantId: string,
  id: string,
  ctx: ShareContext,
): Promise<{ queued: boolean }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const share = await loadShare(tx, tenantId, id);
    if (!share.lastSnapshotId) {
      throw new ProblemError(409, "Nothing to check", {
        type: FILE_SHARE_PROBLEMS.nothingToTest,
        detail: "The file share has no restore point to check yet.",
      });
    }
    const payload: FileShareJobPayload = { tenantId, fileShareId: id, force: true };
    const queued = await sendJob(
      db,
      tx,
      ctx,
      FILE_SHARE_QUEUES.verify,
      payload,
      fileShareSingletonKey(FILE_SHARE_QUEUES.verify, id),
    );
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.restoreTestRequested,
      shareId: id,
      details: { name: share.name, queued },
    });
    return { queued };
  });
}

// ---------------------------------------------------------------------------
// Restore (4.7)
// ---------------------------------------------------------------------------

function restoreNotAllowed(share: Pick<FileShare, "name">): ProblemError {
  return new ProblemError(409, "Restore not allowed", {
    type: FILE_SHARE_PROBLEMS.restoreNotAllowed,
    detail: `"${share.name}" does not allow restores into it. Switch on "Allow restore to this share" in its settings first.`,
  });
}

/** POST /:id/restores: a restore run of the share's restore point. */
export async function requestRestore(
  db: Database,
  tenantId: string,
  id: string,
  input: RestoreInput,
  ctx: ShareContext,
): Promise<ShareRunDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const source = await loadShare(tx, tenantId, id);
    const [snapshot] = await tx
      .select()
      .from(fileShareSnapshots)
      .where(
        and(
          eq(fileShareSnapshots.fileShareId, id),
          eq(fileShareSnapshots.id, input.snapshotId),
          eq(fileShareSnapshots.status, "active"),
        ),
      )
      .limit(1);
    if (!snapshot) {
      throw new ProblemError(404, "Restore point not found", {
        detail: "The restore point does not exist (any more) for this file share.",
      });
    }
    let target = source;
    if (input.destination === "other_share") {
      if (input.targetShareId === id) {
        throw invalid("targetShareId", "Choose another file share, or restore into this one.");
      }
      target = await loadShare(tx, tenantId, input.targetShareId as string);
    }
    if (target.retiredAt) {
      throw retiredProblem();
    }
    if (!target.allowRestore) {
      throw restoreNotAllowed(target);
    }
    const same = target.id === source.id;
    const paths = input.paths
      .map((path) => path.replace(/^\/+/, ""))
      .filter((path) => path.length > 0);
    const params: FileShareRunParams = {
      paths,
      destination:
        input.destination === "original"
          ? "original"
          : input.destination === "new_folder"
            ? "new_folder"
            : "folder",
      ...(input.destination === "other_share" ? { folder: input.folder ?? "" } : {}),
      ...(input.destination === "original" ? { conflict: input.conflict } : {}),
      // Defaults of 4.7: the permissions go back into the share they came from, not elsewhere;
      // restic --verify on NFS targets.
      restorePermissions: input.restorePermissions ?? same,
      verify: input.verify ?? target.protocol === "nfs",
    };
    const [run] = await tx
      .insert(fileShareRuns)
      .values({
        tenantId,
        fileShareId: id,
        lockShareId: target.id,
        targetShareId: target.id,
        sourceSnapshotId: snapshot.id,
        kind: "restore",
        status: "queued",
        trigger: "manual",
        params,
        requestedBy: ctx.actor.userId,
        queuedAt: nowOf(ctx),
      })
      .returning();
    if (!run) {
      throw new Error("file share run insert returned no row");
    }
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.restoreRequested,
      shareId: id,
      details: {
        name: source.name,
        runId: run.id,
        snapshot: snapshot.resticSnapshotId.slice(0, 8),
        target: { id: target.id, name: target.name },
        destination: input.destination,
        conflict: input.conflict ?? null,
        paths: paths.length,
        restorePermissions: params.restorePermissions,
      },
    });
    return shareRunDto(run);
  });
}

// ---------------------------------------------------------------------------
// Retire, reactivate, purge
// ---------------------------------------------------------------------------

/** Cancel the waiting runs of a share (and those that would write into it). */
async function cancelWaiting(tx: Transaction, id: string, now: Date, note: string): Promise<void> {
  await tx
    .update(fileShareRuns)
    .set({
      status: "cancelled",
      cancelRequestedAt: now,
      finishedAt: now,
      finishProcessedAt: now,
      params: sql`${fileShareRuns.params} || ${JSON.stringify({ note })}::jsonb`,
    })
    .where(
      and(
        eq(fileShareRuns.status, "queued"),
        or(eq(fileShareRuns.fileShareId, id), eq(fileShareRuns.lockShareId, id)),
      ),
    );
}

export async function retireShare(
  db: Database,
  tenantId: string,
  id: string,
  ctx: ShareContext,
): Promise<FileShareDetailDto> {
  await withTenantTx(db, tenantId, async (tx) => {
    const share = await loadShare(tx, tenantId, id);
    if (share.retiredAt) {
      return;
    }
    const now = nowOf(ctx);
    await tx.update(fileShares).set({ retiredAt: now }).where(eq(fileShares.id, id));
    await cancelWaiting(tx, id, now, "Cancelled: the file share was retired");
    // Copy jobs that read from or write to it stop (7.2).
    const stopped = await tx
      .update(backupJobs)
      .set({ enabled: false })
      .where(
        and(
          eq(backupJobs.kind, "copy"),
          eq(backupJobs.enabled, true),
          or(eq(backupJobs.sourceFileShareId, id), eq(backupJobs.targetFileShareId, id)),
        ),
      )
      .returning({ id: backupJobs.id });
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.retired,
      shareId: id,
      details: { name: share.name, copyJobsStopped: stopped.length },
    });
  });
  return getShare(db, tenantId, id, nowOf(ctx));
}

export async function reactivateShare(
  db: Database,
  tenantId: string,
  id: string,
  ctx: ShareContext,
): Promise<FileShareDetailDto> {
  try {
    await withTenantTx(db, tenantId, async (tx) => {
      const share = await loadShare(tx, tenantId, id);
      if (!share.retiredAt) {
        return;
      }
      await tx.update(fileShares).set({ retiredAt: null }).where(eq(fileShares.id, id));
      await auditShare(tx, {
        tenantId,
        actor: ctx.actor,
        action: A.reactivated,
        shareId: id,
        details: { name: share.name },
      });
    });
  } catch (error) {
    if (isUnique(error, NAME_INDEX)) {
      throw nameTaken("");
    }
    throw error;
  }
  return getShare(db, tenantId, id, nowOf(ctx));
}

/** DELETE /:id: delete the share's backups and the share (8.6), queued for the worker. */
export async function purgeShare(
  db: Database,
  tenantId: string,
  id: string,
  confirmName: string,
  ctx: ShareContext,
): Promise<{ queued: boolean }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const share = await loadShare(tx, tenantId, id);
    if (confirmName.trim() !== share.name) {
      throw new ProblemError(422, "Name does not match", {
        type: FILE_SHARE_PROBLEMS.confirmName,
        detail: "Type the name of the file share exactly to delete its backups.",
        extensions: { field: "confirmName" },
      });
    }
    const now = nowOf(ctx);
    if (!share.retiredAt) {
      await tx.update(fileShares).set({ retiredAt: now }).where(eq(fileShares.id, id));
    }
    await cancelWaiting(tx, id, now, "Cancelled: the file share's backups are being deleted");
    const payload: FileShareJobPayload = { tenantId, fileShareId: id };
    const queued = await sendJob(
      db,
      tx,
      ctx,
      FILE_SHARE_QUEUES.purge,
      payload,
      fileShareSingletonKey(FILE_SHARE_QUEUES.purge, id),
    );
    await auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.purgeRequested,
      shareId: id,
      details: { name: share.name, protocol: share.protocol, queued },
    });
    return { queued };
  });
}

// ---------------------------------------------------------------------------
// Repository password (5.4)
// ---------------------------------------------------------------------------

export interface ShareRepositoryKeyDto {
  password: string;
  /** Where the repository lives inside the tenant's primary repository (storage target). */
  storagePrefix: string;
}

export async function revealRepositoryPassword(
  db: Database,
  tenantId: string,
  id: string,
  ctx: ShareContext,
): Promise<ShareRepositoryKeyDto> {
  const share = await withTenantTx(db, tenantId, (tx) => loadShare(tx, tenantId, id));
  if (!share.repositorySecretId) {
    throw new ProblemError(409, "No repository yet", {
      type: FILE_SHARE_PROBLEMS.repositoryUnavailable,
      detail: "The restic repository of this file share is created with its first backup.",
    });
  }
  const password = await readSecret(db, { id: share.repositorySecretId, tenantId });
  if (password === null) {
    throw new ProblemError(409, "Repository password missing", {
      type: FILE_SHARE_PROBLEMS.repositoryUnavailable,
      detail: "The repository password of this file share is not available.",
    });
  }
  await withTenantTx(db, tenantId, (tx) =>
    auditShare(tx, {
      tenantId,
      actor: ctx.actor,
      action: A.repositoryPasswordShown,
      shareId: id,
      details: { name: share.name },
    }),
  );
  return { password, storagePrefix: fileShareRepositoryPrefix(id) };
}
