/**
 * Helpers that drive a running Restow the way an operator does: first-run
 * setup, the emergency sign-in with an authenticator app, tenants, IMAP
 * sources, backups, restores and restore checks. They use the session API of
 * the web interface (/api/v1), not the database.
 */
import { ApiClient, ApiError } from "./api.mjs";
import { waitFor } from "./exec.mjs";
import { secretFromOtpauth, totp } from "./totp.mjs";

export const ADMIN = Object.freeze({
  name: "Smoke Admin",
  email: "admin@smoke.test",
  // A throwaway password of a stack that lives for the length of the run.
  password: "Smoke-Admin-Passw0rd!x1",
});

/**
 * The operator's own organisation the setup creates: its name is the setup
 * request's `providerName`, the slug is what the api derives from it. Since
 * 0.2.0 the setup creates it as the installation's first tenant (kind
 * `internal`), so the smoke never creates an "own" tenant itself.
 */
export const OWN_ORGANISATION = Object.freeze({
  name: "Smoke Operator GmbH",
  slug: "smoke-operator-gmbh",
});

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** The setup token the api printed last to its log (apps/api lib/setup-token.ts), or null. */
export function setupTokenFromLog(text) {
  const matches = [...text.matchAll(/SETUP TOKEN: ([A-Z0-9]{5}(?:-[A-Z0-9]{5}){3})/gu)];
  return matches.at(-1)?.[1] ?? null;
}

/** Read the setup token from the api log, the way an operator does. */
async function readSetupToken(stack) {
  let token = null;
  await waitFor(
    "the api to print the setup token",
    async () => {
      token = setupTokenFromLog(await stack.logs("api", 2000));
      return token !== null;
    },
    { timeoutMs: 60_000, intervalMs: 1000 },
  );
  return token;
}

/**
 * Complete the first-run setup and sign the first administrator in with a
 * second factor: the setup token from the api log and the operator notice
 * (as far as this build has them), the setup itself, then the authenticator
 * enrolment the emergency password path demands. Returns `{ api, totpSecret }`
 * with a fully assured session.
 *
 * The upgrade check sets up the previous release with this too, so the older
 * flow stays: 0.1.0 has no setup token and accepts the notice with a call of
 * its own (it ignores the fields of the newer request; its `providerName` is
 * optional and names nobody, since 0.1.0 creates no tenant at setup). A current
 * build creates the own organisation named by `providerName` as its first tenant.
 */
export async function setUpInstallation(stack) {
  const api = new ApiClient(stack.apiUrl, stack.publicUrl);
  const state = await api.get("/api/v1/setup/state");
  if (state.configured) {
    throw new Error("the installation is already set up; the smoke needs an empty database");
  }
  const body = {
    operatingMode: "public",
    publicUrl: stack.publicUrl,
    providerName: OWN_ORGANISATION.name,
    firstAdmin: { name: ADMIN.name, email: ADMIN.email, password: ADMIN.password },
    mail: {
      transport: "smtp",
      smtp: { host: "localhost", port: 25, security: "none", from: "noreply@smoke.test" },
    },
    sendTest: false,
  };
  const headers = {};
  if (state.setupToken) {
    if (state.setupToken.required) {
      const token = await readSetupToken(stack);
      // The wizard's first step, then the token again with the setup itself.
      await api.post("/api/v1/setup/token", undefined, {
        headers: { "x-restow-setup-token": token },
      });
      headers["x-restow-setup-token"] = token;
    }
    body.disclaimer = { version: state.disclaimer.version, accepted: true };
  } else if (state.disclaimer && !state.disclaimer.accepted) {
    await api.post("/api/v1/setup/disclaimer", {
      version: state.disclaimer.version,
      accepted: true,
    });
  }
  const setup = await api.post("/api/v1/setup", body, { headers });
  if (!setup.passkeyReady?.ready) {
    throw new Error(
      `the passkey gate is closed after setup (${(setup.passkeyReady?.reasons ?? []).join(", ")}); passkeys need https on the public origin`,
    );
  }
  // The password session may only enrol an authenticator; do that.
  const enable = await api.post("/api/auth/two-factor/enable", { password: ADMIN.password });
  const totpSecret = secretFromOtpauth(enable.totpURI);
  await api.post("/api/auth/two-factor/verify-totp", { code: totp(totpSecret) });
  const me = await api.get("/api/v1/me");
  if (me.role !== "provider_admin") {
    throw new Error(`the first administrator has the role "${me.role}", expected provider_admin`);
  }
  return { api, totpSecret, setup, me };
}

/** Sign in again with password and authenticator code (a fresh session). */
export async function signIn(stack, totpSecret) {
  const api = new ApiClient(stack.apiUrl, stack.publicUrl);
  const first = await api.post("/api/auth/sign-in/email", {
    email: ADMIN.email,
    password: ADMIN.password,
  });
  if (first.twoFactorRedirect) {
    await api.post("/api/auth/two-factor/verify-totp", { code: totp(totpSecret) });
  }
  return api;
}

export async function createTenant(api, name, slug) {
  return api.post("/api/v1/tenants", { name, slug });
}

/** The tenants of the installation, as the tenant list answers them. */
export async function listTenants(api) {
  const list = await api.get("/api/v1/tenants");
  return list?.items ?? list ?? [];
}

/**
 * The operator's own organisation among `tenants` (the tenant list or the
 * profile's tenants): the one of kind `internal`, or undefined.
 */
export function ownOrganisationOf(tenants) {
  return tenants.find((tenant) => tenant.kind === "internal");
}

/**
 * The one tenant of a Community installation: the own organisation the setup
 * created (every installation has one since 0.2.0, the first tenant is always
 * allowed). Every check of the community variant works in it. A build whose
 * setup created no tenant at all is a failure of its own, not something to
 * paper over by creating one here.
 */
export async function installationTenant(ctx) {
  if (!ctx.installationTenant) {
    const tenants = await listTenants(ctx.api);
    const own = ownOrganisationOf(tenants);
    if (!own) {
      throw new Error(
        `the installation has no own organisation (tenants: ${tenants.map((tenant) => tenant.slug).join(", ") || "none"}); the setup should have created it`,
      );
    }
    ctx.installationTenant = own;
  }
  // A copy: checks hang their own facts on the tenant they get.
  return { ...ctx.installationTenant };
}

/**
 * How a step that gets its tenant from tenantForCheck names it: "create a tenant
 * and ..." in the full build, "in the installation's one tenant, ..." in the
 * Community build, so the report says what happened.
 */
export function tenantStep(ctx, rest) {
  return ctx.options?.variant === "community"
    ? `in the installation's one tenant, ${rest}`
    : `create a tenant and ${rest}`;
}

/**
 * The tenant a check works in. The full build gives each check a tenant of its
 * own (the Service Provider key allows many); the Community build has exactly
 * one tenant, which every check shares.
 */
export async function tenantForCheck(ctx, name, slug) {
  return ctx.options?.variant === "community"
    ? installationTenant(ctx)
    : createTenant(ctx.api, name, slug);
}

/** Add an IMAP mailbox as a source and protect it; returns `{ source, objectId }`. */
export async function addImapMailbox(api, tenantId, { stack, login, name }) {
  const source = await api.post(
    "/api/v1/sources",
    {
      kind: "imap",
      name,
      host: "dovecot",
      port: 143,
      security: "none",
      username: login,
      password: stack.imapPassword,
    },
    { tenantId },
  );
  await api.post(`/api/v1/sources/${source.id}/test`, undefined, { tenantId });
  await api.post(
    `/api/v1/directory/sources/${source.id}/accounts`,
    { accounts: [{ login, email: login, displayName: name }], dryRun: false },
    { tenantId },
  );
  const objects = await waitFor(
    `the protected object of ${login}`,
    async () => {
      const list = await api.get("/api/v1/jobs/objects", { tenantId });
      return list.items.length > 0 ? list.items : null;
    },
    { timeoutMs: 30_000 },
  );
  const object = objects.find((entry) => entry.externalId === login) ?? objects[0];
  return { source, objectId: object.id };
}

export async function objectOf(api, tenantId, objectId) {
  const list = await api.get("/api/v1/jobs/objects", { tenantId });
  return list.items.find((entry) => entry.id === objectId);
}

/** Wait for a job to reach a terminal status; returns the job. Throws unless it completed. */
export async function waitForJob(
  api,
  tenantId,
  jobId,
  { timeoutMs = 240_000, what = "the job" } = {},
) {
  const job = await waitFor(
    `${what} to finish`,
    async () => {
      const current = await api.get(`/api/v1/jobs/${jobId}`, { tenantId });
      return TERMINAL.has(current.status) ? current : null;
    },
    { timeoutMs, intervalMs: 1500 },
  );
  if (job.status !== "completed") {
    throw new Error(
      `${what} ended as ${job.status}: ${JSON.stringify(job.failure ?? job.errorMessage ?? "")}`,
    );
  }
  return job;
}

/** Wait until the object has a completed snapshot newer than `afterSequence`; returns the snapshot. */
export async function waitForSnapshot(
  api,
  tenantId,
  objectId,
  { afterSequence = 0, timeoutMs = 240_000 } = {},
) {
  return waitFor(
    "a completed backup snapshot",
    async () => {
      const object = await objectOf(api, tenantId, objectId);
      const snapshot = object?.lastSnapshot;
      if (object?.lastJob?.status === "failed") {
        throw new Error(`the backup job failed: ${JSON.stringify(object.lastJob)}`);
      }
      return snapshot && snapshot.sequence > afterSequence ? snapshot : null;
    },
    { timeoutMs, intervalMs: 1500 },
  );
}

/** "Back up now"; returns the queued job ids. */
export async function backUpNow(api, tenantId, objectId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await api.request("POST", "/api/v1/jobs/backup", {
      tenantId,
      body: { protectedObjectId: objectId },
    });
    if (response.status < 400) {
      const ids = response.body.queued.map((job) => job.id);
      if (ids.length > 0) return ids;
      // Nothing queued: a backup of this object is already queued or running
      // (since 0.2.0 the job scheduler plans it). Wait it out and ask again, so
      // the backup we wait for starts after the caller's changes.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    // Another backup of the same object may still be running (the recommended
    // schedule or the follow-up of the first one): wait it out.
    if (response.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    throw new ApiError("POST", "/api/v1/jobs/backup", response.status, response.body);
  }
  throw new Error("could not queue a backup: another job of the object kept running");
}

/** Restore a snapshot into the mailbox it came from, next to the original; returns the finished restore. */
export async function restoreToOriginal(
  api,
  tenantId,
  snapshotId,
  { folderName, reason, target = { type: "original" } },
) {
  const queued = await api.post(
    "/api/v1/restore",
    {
      snapshotId,
      selection: [{ path: "" }],
      target,
      mode: "rename",
      reason,
      options: { restoreFolderName: folderName },
    },
    { tenantId },
  );
  return waitFor(
    "the restore to finish",
    async () => {
      const restore = await api.get(`/api/v1/restore/${queued.id}`, { tenantId });
      if (restore.status === "failed" || restore.status === "cancelled") {
        throw new Error(`the restore ${restore.status}: ${restore.errorMessage ?? ""}`);
      }
      return restore.status === "completed" ? restore : null;
    },
    { timeoutMs: 240_000, intervalMs: 1500 },
  );
}

/** Run the restore check ("Verify now") of a tenant; resolves with the finished jobs. */
export async function verifyTenant(api, tenantId) {
  const queued = await api.post("/api/v1/verify", {}, { tenantId });
  const jobs = [];
  for (const entry of queued.queued ?? []) {
    jobs.push(await waitForJob(api, tenantId, entry.jobId, { what: "the restore check" }));
  }
  return jobs;
}

export async function latestVerification(api, tenantId) {
  return api.get("/api/v1/verify/latest", { tenantId });
}

/**
 * Start a restore check and wait until the object shows it green. A check that
 * is already queued or running (the schedule runs them too) is not started a
 * second time, so the state is polled, not read once; a red state fails at once.
 */
export async function verifyUntilGreen(api, tenantId, objectId, { timeoutMs = 180_000 } = {}) {
  await verifyTenant(api, tenantId);
  return waitFor(
    "the restore check to turn green",
    async () => {
      const latest = await latestVerification(api, tenantId);
      const entry = latest.objects.find((candidate) => candidate.object.id === objectId);
      if (entry?.state === "red") {
        throw new Error(
          `the restore check is red: ${JSON.stringify(entry.readiness ?? entry.report ?? "")}`,
        );
      }
      return entry?.state === "green" ? entry : null;
    },
    { timeoutMs, intervalMs: 2000 },
  );
}

/** The storage target of a tenant, created through the API (a provider admin may use any endpoint). */
export async function addStorageTarget(api, tenantId, body) {
  const target = await api.post(
    "/api/v1/storage/targets",
    { role: "primary", ...body },
    { tenantId },
  );
  const tested = await api.post(`/api/v1/storage/targets/${target.id}/test`, {}, { tenantId });
  return { target, probe: tested.target?.lastProbe ?? tested.lastProbe };
}
