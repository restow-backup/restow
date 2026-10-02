import type { DemoMailbox, DemoTenant } from "./company.js";
import { DEMO_PROVIDER_NAME, DEMO_TENANTS } from "./company.js";
import { ApiClient, ApiRequestError } from "./http-client.js";

/**
 * Bootstraps the demo installation over the real API, the same way an
 * operator would through the setup wizard and the UI — except every
 * mutating call here also carries the seed's own bypass token
 * (`X-Restow-Demo-Seed-Token`), so it passes the demo guard
 * (apps/api middleware/demo-guard.ts) that refuses everything else while
 * `RESTOW_DEMO=true`. See deploy/demo/README.md.
 */

export interface SeedConfig {
  /** The api's own base URL, e.g. http://api:3000 (never through the public edge). */
  apiBaseUrl: string;
  publicUrl: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  seedToken: string;
  imapHost: string;
  imapPort: number;
  imapPassword: string;
  /** How long to wait for a triggered backup or verify run to finish. */
  jobTimeoutMs: number;
}

export interface SeedResult {
  tenants: ReadonlyArray<{ id: string; name: string }>;
  /** The signed-in seed client, for the history step (history.ts). */
  client: ApiClient;
  backupsCompleted: number;
  backupsFailed: number;
  verificationsCompleted: number;
  verificationsFailed: number;
}

export type Logger = (message: string) => void;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealthy(apiBaseUrl: string, timeoutMs: number, log: Logger): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${apiBaseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not up yet; retried below.
    }
    if (Date.now() > deadline) {
      throw new Error(`the api at ${apiBaseUrl} did not become healthy within ${timeoutMs}ms`);
    }
    log("waiting for the api...");
    await sleep(2000);
  }
}

interface SetupState {
  configured: boolean;
}

/** Runs the normal setup wizard's request, unless the installation already went through it. */
async function ensureInstallation(
  client: ApiClient,
  config: SeedConfig,
  log: Logger,
): Promise<void> {
  const state = await client.get<SetupState>("/api/v1/setup/state");
  if (state.configured) {
    log("installation already set up, continuing with the existing admin");
    return;
  }
  // Setup is not on the demo guard's public allowlist (security review
  // finding 1): only this token-authenticated call may reach it, and
  // routes/setup.ts additionally refuses it unless firstAdmin matches
  // RESTOW_DEMO_EMAIL/RESTOW_DEMO_PASSWORD, which config.adminEmail/
  // adminPassword always are (index.ts reads them from the same variables).
  await client.post("/api/v1/setup", setupRequest(config), { seed: true });
}

/**
 * The setup wizard's own request. `providerName` is the name of the demo's
 * own organisation: right after the setup the api creates it as the first
 * tenant (kind internal). The seed therefore creates only the customers
 * itself, so the demo has exactly one own organisation, neither missing nor
 * duplicated.
 */
export function setupRequest(
  config: Pick<SeedConfig, "publicUrl" | "adminName" | "adminEmail" | "adminPassword">,
) {
  const host = new URL(config.publicUrl).hostname;
  return {
    operatingMode: "public",
    publicUrl: config.publicUrl,
    providerName: DEMO_PROVIDER_NAME,
    firstAdmin: {
      name: config.adminName,
      email: config.adminEmail,
      password: config.adminPassword,
    },
    // Never actually sent: createNotifier() is a no-op in demo mode
    // (apps/api notify.ts) regardless of what is configured here.
    mail: {
      transport: "smtp",
      smtp: { host: "localhost", port: 25, security: "none", from: `noreply@${host}` },
    },
    sendTest: false,
  };
}

async function signInAdmin(client: ApiClient, config: SeedConfig): Promise<void> {
  await client.post("/api/auth/sign-in/email", {
    email: config.adminEmail,
    password: config.adminPassword,
  });
}

interface CreatedTenant {
  id: string;
}

async function createTenants(
  client: ApiClient,
  tenants: readonly DemoTenant[],
  log: Logger,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const tenant of tenants) {
    log(`creating tenant ${tenant.name}...`);
    const created = await client.post<CreatedTenant>(
      "/api/v1/tenants",
      { name: tenant.name, slug: tenant.slug },
      { seed: true },
    );
    ids.set(tenant.slug, created.id);
  }
  return ids;
}

interface CreatedSource {
  id: string;
}

async function addMailboxSource(
  client: ApiClient,
  tenantId: string,
  mailbox: DemoMailbox,
  config: SeedConfig,
  log: Logger,
): Promise<void> {
  log(`adding IMAP source ${mailbox.login}...`);
  const source = await client.post<CreatedSource>(
    "/api/v1/sources",
    {
      kind: "imap",
      name: mailbox.displayName,
      host: config.imapHost,
      port: config.imapPort,
      security: "none",
      username: mailbox.login,
      password: config.imapPassword,
    },
    { tenantId, seed: true },
  );
  // A freshly created IMAP source starts "pending" (untested); the worker
  // refuses to back it up until a successful connection test marks it
  // "active" (apps/api features/sources/service.ts `testSource`).
  await client.post(`/api/v1/sources/${source.id}/test`, undefined, { tenantId, seed: true });
  await client.post(
    `/api/v1/directory/sources/${source.id}/accounts`,
    {
      accounts: [{ login: mailbox.login, email: mailbox.login, displayName: mailbox.displayName }],
      dryRun: false,
    },
    { tenantId, seed: true },
  );
}

async function applyRecommendedSchedules(client: ApiClient, tenantId: string): Promise<void> {
  await client.post("/api/v1/schedules/recommended", {}, { tenantId, seed: true });
}

/**
 * The rules a demo visitor finds under Alerts & reports: an alert for failed
 * jobs and a recoverability at risk, and a weekly report. Addresses are on the
 * reserved example domain; the demo sends no mail (NoopNotifier), so the
 * delivery log shows what would have gone out.
 */
export function demoReportRules(slug: string): Record<string, unknown>[] {
  const to = [`it@${slug}.example`];
  return [
    {
      trigger: "event",
      name: "Failed jobs and recoverability",
      events: ["backup.failed", "restore.failed", "verify.red", "scrub.corrupt"],
      throttleMinutes: 60,
      emailRecipients: to,
    },
    {
      trigger: "schedule",
      name: "Weekly report",
      cron: "0 7 * * 1",
      timezone: "Europe/Berlin",
      periodDays: 7,
      sections: ["backups", "readiness", "failures", "storage", "restores"],
      emailRecipients: to,
      inApp: true,
    },
  ];
}

async function createReportRules(client: ApiClient, tenantId: string, slug: string): Promise<void> {
  for (const rule of demoReportRules(slug)) {
    await client.post("/api/v1/reports/rules", rule, { tenantId, seed: true });
  }
}

interface QueuedJob {
  id: string;
}

interface StartBackupResult {
  queued: QueuedJob[];
}

const DEMO_JOB_IN_PROGRESS = "urn:restow:problem:demo-job-in-progress";
const DEMO_RATE_LIMITED = "urn:restow:problem:demo-rate-limited";
const JOB_IN_PROGRESS_RETRY_MS = 3000;
const RATE_LIMITED_RETRY_MS = 10_000;

/**
 * Pure: whether a refused job request is demo mode's one-job-per-queue-per-
 * tenant limit (apps/api lib/demo-limits.ts), i.e. worth waiting out rather
 * than failing the seed.
 */
export function isDemoJobInProgress(status: number, body: unknown): boolean {
  return (
    status === 409 &&
    typeof body === "object" &&
    body !== null &&
    (body as { type?: unknown }).type === DEMO_JOB_IN_PROGRESS
  );
}

/**
 * Pure: whether a refused job request is demo mode's per-client rate limit
 * on job triggers (apps/api lib/demo.ts, ten per minute), which applies to
 * the seed as well; the history step (history.ts) triggers many jobs in a
 * row and waits it out.
 */
export function isDemoRateLimited(status: number, body: unknown): boolean {
  return (
    status === 429 &&
    typeof body === "object" &&
    body !== null &&
    (body as { type?: unknown }).type === DEMO_RATE_LIMITED
  );
}

/**
 * POST a job request, waiting while another job of the same kind is still
 * running for the tenant. The seed is not the only one queueing jobs: the
 * scheduler gives every new tenant the recommended schedules on its own
 * (apps/scheduler store.ts), and with a verify schedule in place the worker
 * follows each completed backup with a verify of its own
 * (apps/worker handlers/backup.ts `enqueueVerifyAfterBackup`). How long that
 * one runs depends on the host, so the seed waits for it instead of racing it.
 */
export async function postJobWhenIdle<T>(
  client: ApiClient,
  path: string,
  body: unknown,
  tenantId: string,
  timeoutMs: number,
  log: Logger,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const response = await client.postRaw<T>(path, body, { tenantId });
    if (response.status < 400) {
      return response.body;
    }
    const limited = isDemoRateLimited(response.status, response.body);
    if (
      (!isDemoJobInProgress(response.status, response.body) && !limited) ||
      Date.now() >= deadline
    ) {
      throw new ApiRequestError("POST", path, response.status, response.body);
    }
    if (limited) {
      await sleep(RATE_LIMITED_RETRY_MS);
      continue;
    }
    if (!announced) {
      log("another job of the same kind is still running for this tenant; waiting for it...");
      announced = true;
    }
    await sleep(JOB_IN_PROGRESS_RETRY_MS);
  }
}

/** "Back up now" for one protected object. */
export async function triggerBackup(
  client: ApiClient,
  tenantId: string,
  protectedObjectId: string,
  timeoutMs: number,
  log: Logger,
): Promise<string[]> {
  const result = await postJobWhenIdle<StartBackupResult>(
    client,
    "/api/v1/jobs/backup",
    { protectedObjectId },
    tenantId,
    timeoutMs,
    log,
  );
  return result.queued.map((job) => job.id);
}

/** The fields of `GET /api/v1/jobs/objects` (apps/api `BackupTargetDto`) the seed reads. */
export interface BackupTargetView {
  id: string;
  displayName: string | null;
  status: string;
  /** The last completed snapshot; null while the object has never been backed up. */
  lastSnapshot: { id: string } | null;
  /** The object's most recent backup job, whatever its status. */
  lastJob: { id: string } | null;
}

export async function listBackupTargets(
  client: ApiClient,
  tenantId: string,
): Promise<BackupTargetView[]> {
  const result = await client.get<{ items: BackupTargetView[] }>("/api/v1/jobs/objects", {
    tenantId,
  });
  return result.items;
}

/**
 * Pure: the backup jobs Restow itself queued for the tenant's objects. The
 * seed runs against a fresh installation, so every backup job it finds here
 * is an automatic first backup, queued the moment an account was added.
 */
export function automaticFirstBackupJobIds(objects: readonly BackupTargetView[]): string[] {
  return objects.flatMap((object) => (object.lastJob ? [object.lastJob.id] : []));
}

/**
 * Pure: protected objects that never had a backup queued at all, so the seed
 * has to start their first one itself. An object whose automatic first
 * backup ran and failed is not picked up again: that failure is counted, not
 * papered over with a retry.
 */
export function objectsWithoutFirstBackup(
  objects: readonly BackupTargetView[],
): BackupTargetView[] {
  return objects.filter(
    (object) =>
      object.status === "active" && object.lastSnapshot === null && object.lastJob === null,
  );
}

interface QueuedCheck {
  jobId: string;
}

interface RunVerifyResult {
  queued: QueuedCheck[];
}

export async function triggerVerify(
  client: ApiClient,
  tenantId: string,
  timeoutMs: number,
  log: Logger,
): Promise<string[]> {
  const result = await postJobWhenIdle<RunVerifyResult>(
    client,
    "/api/v1/verify",
    {},
    tenantId,
    timeoutMs,
    log,
  );
  return result.queued.map((entry) => entry.jobId);
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

interface JobStatusDto {
  status: string;
}

/** Poll every job in `jobIds` until each reaches a terminal status, or `timeoutMs` runs out. */
async function pollJobs(
  client: ApiClient,
  tenantId: string,
  jobIds: readonly string[],
  timeoutMs: number,
): Promise<Map<string, string | undefined>> {
  const outcomes = new Map<string, string | undefined>(jobIds.map((id) => [id, undefined]));
  const deadline = Date.now() + timeoutMs;
  while ([...outcomes.values()].some((status) => status === undefined) && Date.now() < deadline) {
    for (const id of jobIds) {
      if (outcomes.get(id) !== undefined) {
        continue;
      }
      const job = await client.get<JobStatusDto>(`/api/v1/jobs/${id}`, { tenantId });
      if (TERMINAL_STATUSES.has(job.status)) {
        outcomes.set(id, job.status);
      }
    }
    if ([...outcomes.values()].some((status) => status === undefined)) {
      await sleep(2000);
    }
  }
  return outcomes;
}

export interface JobOutcomeCounts {
  completed: number;
  /** Failed, cancelled, or never reached a terminal status before the timeout. */
  failed: number;
}

/** Pure: turn each job's final (or missing) status into completed/failed counts. */
export function classifyOutcomes(
  jobIds: readonly string[],
  outcomes: ReadonlyMap<string, string | undefined>,
): JobOutcomeCounts {
  let completed = 0;
  let failed = 0;
  for (const id of jobIds) {
    if (outcomes.get(id) === "completed") {
      completed += 1;
    } else {
      failed += 1;
    }
  }
  return { completed, failed };
}

export async function waitForJobs(
  client: ApiClient,
  tenantId: string,
  jobIds: readonly string[],
  timeoutMs: number,
): Promise<JobOutcomeCounts> {
  if (jobIds.length === 0) {
    return { completed: 0, failed: 0 };
  }
  const outcomes = await pollJobs(client, tenantId, jobIds, timeoutMs);
  return classifyOutcomes(jobIds, outcomes);
}

/**
 * Get every protected object of the tenant through its first backup.
 *
 * Adding an IMAP account protects it, and Restow queues its first backup on
 * its own right then (apps/api features/jobs/service.ts
 * `enqueueFirstBackups`). Demo mode allows one backup batch per tenant at a
 * time (lib/demo-limits.ts), so an account added while another account's
 * first backup was still queued or running gets none from that path. This
 * waits for the backups Restow queued itself, then starts the missing ones
 * with "Back up now", one object at a time so none of them runs into the
 * same limit.
 */
async function runFirstBackups(
  client: ApiClient,
  tenantId: string,
  timeoutMs: number,
  log: Logger,
): Promise<JobOutcomeCounts> {
  const automatic = automaticFirstBackupJobIds(await listBackupTargets(client, tenantId));
  log(`waiting for ${automatic.length} first backup(s) Restow queued on its own...`);
  const total = await waitForJobs(client, tenantId, automatic, timeoutMs);
  for (const object of objectsWithoutFirstBackup(await listBackupTargets(client, tenantId))) {
    log(`starting the first backup of ${object.displayName ?? object.id}...`);
    const jobIds = await triggerBackup(client, tenantId, object.id, timeoutMs, log);
    if (jobIds.length === 0) {
      log(`the first backup of ${object.displayName ?? object.id} was not queued`);
      total.failed += 1;
      continue;
    }
    const outcome = await waitForJobs(client, tenantId, jobIds, timeoutMs);
    total.completed += outcome.completed;
    total.failed += outcome.failed;
  }
  return total;
}

/**
 * Run the whole bootstrap: wait for the api, complete setup (creating the
 * demo admin), sign in, create the demo tenants and their IMAP sources
 * (pointing at the internal Dovecot), wait for (or start) the first backup
 * of every mailbox, verify each tenant, and apply the recommended schedules.
 */
export async function seedInstallation(
  config: SeedConfig,
  log: Logger = console.log,
): Promise<SeedResult> {
  await waitForHealthy(config.apiBaseUrl, 180_000, log);

  const client = new ApiClient(
    config.apiBaseUrl,
    config.seedToken,
    new URL(config.publicUrl).origin,
  );
  await ensureInstallation(client, config, log);
  await signInAdmin(client, config);

  const tenantIds = await createTenants(client, DEMO_TENANTS, log);

  const tenants: Array<{ id: string; name: string }> = [];
  let backupsCompleted = 0;
  let backupsFailed = 0;
  let verificationsCompleted = 0;
  let verificationsFailed = 0;

  for (const tenant of DEMO_TENANTS) {
    const tenantId = tenantIds.get(tenant.slug);
    if (!tenantId) {
      throw new Error(`tenant "${tenant.slug}" was not created`);
    }
    tenants.push({ id: tenantId, name: tenant.name });

    for (const mailbox of tenant.mailboxes) {
      await addMailboxSource(client, tenantId, mailbox, config, log);
    }

    // The scheduler may already have given this tenant the recommended
    // schedules on its own, so the worker can follow a first backup with a
    // verify of its own; the explicit verify below waits for that one
    // (postJobWhenIdle) instead of failing on the demo mode's one-job-per-
    // queue-per-tenant limit (security review finding 3, lib/demo-limits.ts).
    // Applying the schedules explicitly afterwards covers the case where the
    // scheduler has not got to this tenant yet.
    log(`running the first backups for ${tenant.name}...`);
    const backupOutcome = await runFirstBackups(client, tenantId, config.jobTimeoutMs, log);
    backupsCompleted += backupOutcome.completed;
    backupsFailed += backupOutcome.failed;
    log(
      `backup for ${tenant.name}: ${backupOutcome.completed} completed, ${backupOutcome.failed} failed`,
    );

    log(`verifying ${tenant.name}...`);
    const verifyJobIds = await triggerVerify(client, tenantId, config.jobTimeoutMs, log);
    const verifyOutcome = await waitForJobs(client, tenantId, verifyJobIds, config.jobTimeoutMs);
    verificationsCompleted += verifyOutcome.completed;
    verificationsFailed += verifyOutcome.failed;
    log(
      `verification for ${tenant.name}: ${verifyOutcome.completed} completed, ${verifyOutcome.failed} failed`,
    );

    log(`applying recommended schedules for ${tenant.name}...`);
    await applyRecommendedSchedules(client, tenantId);
    log(`creating the alert and report rules of ${tenant.name}...`);
    await createReportRules(client, tenantId, tenant.slug);
  }

  return {
    tenants,
    client,
    backupsCompleted,
    backupsFailed,
    verificationsCompleted,
    verificationsFailed,
  };
}
