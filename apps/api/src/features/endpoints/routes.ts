import { Readable } from "node:stream";
import { endpointPrefix } from "@restow/core";
import { endpoints } from "@restow/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { config as appConfig } from "../../config.js";
import { db, providerDb } from "../../db.js";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import { providerRoleSatisfies } from "../../lib/provider-access.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { isTenantAdmin } from "../../middleware/rbac.js";
import {
  assertProviderRoute,
  authenticate,
  requireTenant,
  resolveTenantAccess,
  TENANT_HEADER,
  type TenantEnv,
} from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { assertNotInRestoreMode } from "../restore-mode/service.js";
import { resticRestorePointImmutability } from "../storage/immutability.js";
import { retentionHoldSettings } from "../suspicion/service.js";
import {
  getEndpointAgentPolicy,
  getTenantAgentPolicy,
  updateTenantAgentPolicy,
} from "./agent-policy.js";
import type { EndpointActor } from "./audit.js";
import { getBaremetalState, getLayout } from "./baremetal.js";
import { cancelEndpointBackup, requestEndpointUpdate } from "./cancel.js";
import { instanceUrl } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import { createRebindToken } from "./rebind.js";
import {
  approveRecovery,
  cancelRecovery,
  extendRecoveryCode,
  getRecovery,
  issueRecoveryCode,
  listRecoveries,
  revokeRecoveryCode,
  setRecoverySshKeys,
} from "./recovery-codes.js";
import { cancelRemoval, listRemovals, removeEndpoint } from "./removal.js";
import {
  agentPolicyLevelSchema,
  agentUpdatesSchema,
  browseQuerySchema,
  createDownloadSchema,
  createRebindTokenSchema,
  createTaskSchema,
  createTokenSchema,
  downloadParamSchema,
  endpointIdParamSchema,
  extendRecoveryCodeSchema,
  issueRecoveryCodeSchema,
  layoutParamSchema,
  listEndpointsQuerySchema,
  listRunsQuerySchema,
  listTokensQuerySchema,
  MAX_DOWNLOAD_BODY_BYTES,
  recoveryCodeParamSchema,
  recoveryLogQuerySchema,
  recoveryParamSchema,
  recoverySshKeysSchema,
  removeEndpointSchema,
  runParamSchema,
  snapshotImmutabilityParamSchema,
  sqlBackupParamSchema,
  sqlDatabaseParamSchema,
  sqlRestoreSchema,
  sqlVerifySchema,
  tokenIdParamSchema,
  updateEndpointSchema,
} from "./schemas.js";
import {
  browseSnapshot,
  createEnrollmentToken,
  createTask,
  getAgentUpdates,
  getEndpoint,
  getRun,
  listEndpoints,
  listEnrollmentTokens,
  listRuns,
  listSnapshots,
  openDownload,
  prepareDownload,
  requestRestoreTest,
  requestUninstall,
  resumeMachineUpdates,
  revealRepositoryPassword,
  revokeEndpoint,
  revokeEnrollmentToken,
  type SnapshotReader,
  setAgentUpdates,
  updateEndpoint,
} from "./service.js";
import {
  confirmSqlTde,
  getSqlOverview,
  listSqlBackups,
  requestSqlInventory,
  requestSqlRestore,
  requestSqlVerify,
  sqlRestoreScript,
} from "./sql.js";

/**
 * /api/v1/endpoints: servers and clients backed up by the Restow agent, for
 * tenant admins (docs/AGENT.md). Everything an admin changes and every read
 * of backed-up files is audited.
 *
 * Restore operators (`tenant_restore`, middleware/rbac.ts) use the file
 * restore: they list the machines, open one (without its hook texts), its
 * restore points, browse them, download files and restore files onto the
 * machine (POST /:id/tasks with `kind: "restore"`). Everything else, backing
 * up now included, stays with the admins.
 *
 *   GET    /?profile=                           servers and clients with status and readiness
 *   GET    /capabilities                        what this installation offers for machines: bare metal
 *                                               (RESTOW_BAREMETAL_PREVIEW), for the texts of the list
 *   GET    /tokens?state=valid|all              enrollment tokens: the valid ones (default), or every state
 *   POST   /tokens                              create a one-time token; shown once, with the commands
 *   DELETE /tokens/:tokenId                     revoke an unused token
 *   GET    /agent-updates                       the tenant's pause of automatic agent updates, and the machines paused on their own
 *   PUT    /agent-updates                       pause or resume them for the tenant (also with no machine yet)
 *   DELETE /agent-updates/machines/:id          lift one machine's own pause
 *   GET    /agent-policy                        the tenant's level of the agent policy, the
 *                                               installation's it inherits (with its locks), the result
 *   PUT    /agent-policy                        replace the tenant's level (not what is locked); writes
 *                                               every machine's configuration that changes
 *   GET    /:id                                 detail: config, runs, waiting and recent tasks, reports
 *                                               (hook texts only for who may change the configuration)
 *   GET    /:id/agent-policy                    the agent policy as it applies to the machine, each
 *                                               setting with its source (read-only; restore operators too)
 *   PATCH  /:id                                 name, paths, excludes, schedule, hooks, bandwidth, retention,
 *                                               the person of the directory the machine is assigned to
 *   POST   /:id/revoke                          refuse the endpoint from now on
 *   POST   /:id/uninstall                       have the agent remove itself, then revoke
 *   POST   /:id/remove                          remove a revoked machine from Restow: its backups are
 *                                               deleted when they expire, or (`delete`, provider
 *                                               owners only, with a reason) in seven days (#65;
 *                                               typed hostname, recent sign-in)
 *   POST   /:id/remove/cancel                   cancel a `delete` before the worker starts (owners)
 *   GET    /removals                            removed machines whose backups are not deleted yet
 *   POST   /:id/tasks                           back up now, or restore into a new folder on the endpoint
 *   POST   /:id/cancel                          stop the running backup, withdraw a queued one
 *   POST   /:id/update                          the agent installs its update when idle
 *   POST   /:id/restore-test                    read the samples back and compare their hashes now
 *   POST   /:id/repository-password             the restic password, for a restore without Restow (audited)
 *   GET    /:id/runs?limit=                     recent runs
 *   GET    /:id/runs/:runId                     one run with its log tail and errors
 *   GET    /:id/snapshots                       restic snapshots of the repository
 *   GET    /:id/browse?snapshotId=&path=&cursor=  one page of a folder of a snapshot
 *   POST   /:id/downloads                       check selected files and folders, prepare a ZIP (paths in the body)
 *   GET    /:id/downloads/:downloadId           start the prepared ZIP: streamed, audited first, once
 *   GET    /:id/baremetal                       bare metal (preview): state, the newest layout's summary
 *                                               and verdict, the snapshot hint (restore operators too)
 *   GET    /:id/baremetal/layouts/:layoutId     one layout with its full manifest (serial numbers; admins)
 *   POST   /:id/recovery-codes                  issue a recovery code for the ISO, shown once (bare metal,
 *                                               docs/BAREMETAL.md 9.2; admins, recent sign-in)
 *   POST   /:id/recovery-codes/:codeId/revoke   revoke a code nobody redeemed (admins)
 *   POST   /:id/recovery-codes/:codeId/extend   extend a code and its session, at most 48 hours after
 *                                               it was issued (admins, recent sign-in)
 *   GET    /:id/recoveries                      the machine's codes and sessions (admins)
 *   GET    /:id/recoveries/:recoveryId?logAfter=&logLimit=  one with match code, hardware, progress,
 *                                               SSH host keys, verification and a page of its log
 *   POST   /:id/recoveries/:recoveryId/approve  release a session after its exchange (admins, recent sign-in)
 *   POST   /:id/recoveries/:recoveryId/cancel   reject a waiting session or end a running one (admins)
 *   PUT    /:id/recoveries/:recoveryId/ssh-keys public SSH keys for the ISO's remote access (admins,
 *                                               recent sign-in)
 *   POST   /:id/rebind-token                    a token that gives the machine a new agent secret, shown
 *                                               once with the install commands (docs/BAREMETAL.md 11;
 *                                               admins, recent sign-in)
 *   GET    /:id/sql                             SQL Server (W2a): instances, sign-in with the login
 *                                               script, databases with rating, backup and check
 *   GET    /:id/sql/databases/:databaseId/backups  the backups of one database
 *   POST   /:id/sql/restore                     restore a backup under a new name (audited)
 *   POST   /:id/sql/verify                      check the newest backups now (one database or all)
 *   POST   /:id/sql/inventory                   "Check sign-in": the agent connects once and reports
 *   GET    /:id/sql/backups/:backupId/restore-script  the restore script for another machine (audited)
 *   POST   /:id/sql/databases/:databaseId/tde-confirm  the TDE certificate is backed up elsewhere (audited)
 *
 * The agent's state file (agent secret, repository password) is hidden from browsing and never
 * handed out; the LUKS key files a machine's layout names are hidden from restore operators and
 * handed to an admin only after a recent sign-in, audited (docs/BAREMETAL.md 5.4, service.ts
 * `checkSelection`).
 *
 * Setting or changing a hook (it runs as root on the machine) and showing the
 * repository password (it opens every backup of the machine without Restow)
 * need a recent sign-in on top of the role (lib/recent-sign-in.ts): an older
 * session gets 403 `urn:restow:problem:recent-sign-in-required`, and the web
 * app asks the person to confirm it is them and repeats the action. Removing
 * every hook needs none (service.ts, hookChangeNeedsRecentSignIn).
 */
export const endpointsRoutes = new Hono<TenantEnv>();

const admin = requireTenant("tenant_admin");
/** The file restore: restore operators and the administrators above them. */
const restorer = requireTenant("tenant_restore");

/**
 * Starting a prepared download is a plain browser navigation, which cannot
 * carry the `X-Restow-Tenant` header; the tenant id may therefore also arrive
 * as the `tenant` query parameter (like the restore download). Otherwise
 * identical to requireTenant("tenant_restore"). The prepared download itself is
 * bound to the person who created it, so the address alone opens nothing.
 */
const restorerForDownload: MiddlewareHandler<TenantEnv> = async (c, next) => {
  const state = await authenticate(c.req.raw.headers);
  assertProviderRoute(c, state);
  const selector = c.req.header(TENANT_HEADER) ?? c.req.query("tenant");
  const { tenant, role } = await resolveTenantAccess(state, selector, "tenant_restore");
  c.set("auth", state.auth);
  c.set("user", state.user);
  c.set("isProviderAdmin", state.isProviderAdmin);
  c.set("providerAccess", state.providerAccess);
  c.set("memberships", state.memberships);
  c.set("tenantId", tenant.id);
  c.set("tenant", tenant);
  c.set("role", role);
  await next();
};

/**
 * Whether the viewer may change an endpoint's configuration, and so read its
 * hook texts: a tenant admin, or a provider member from "Administrator" on.
 * A restore operator may not.
 */
export function mayConfigure(c: Context<TenantEnv>): boolean {
  const access = c.get("providerAccess");
  if (c.get("isProviderAdmin") && access) {
    return providerRoleSatisfies(access.role, "administrator");
  }
  const role = c.get("role");
  return role !== undefined && isTenantAdmin(role);
}

function actorOf(c: Context<TenantEnv>): EndpointActor {
  const user = c.get("user");
  return { label: user.email, userId: user.id, ip: clientIp(c) };
}

/** The actor of a read of backed-up files, with what it may read of a snapshot's secrets. */
function readerOf(c: Context<TenantEnv>): SnapshotReader {
  return {
    ...actorOf(c),
    role: mayConfigure(c) ? "admin" : "restore",
    confirmRecentSignIn: () => assertRecentSignIn(c.get("auth").session),
  };
}

endpointsRoutes.get("/", restorer, async (c) => {
  const query = parseOrProblem(listEndpointsQuerySchema, c.req.query());
  return c.json(await listEndpoints(db, c.get("tenantId"), query));
});

// Static paths first, so "tokens" is never read as an endpoint id.
endpointsRoutes.get("/capabilities", restorer, (c) =>
  c.json({ baremetalPreview: appConfig.baremetalPreview }),
);

endpointsRoutes.get("/tokens", admin, async (c) => {
  const query = parseOrProblem(listTokensQuerySchema, c.req.query());
  return c.json(await listEnrollmentTokens(db, c.get("tenantId"), query));
});

endpointsRoutes.post("/tokens", admin, async (c) => {
  const input = await parseJsonBody(c.req, createTokenSchema);
  const created = await createEnrollmentToken(
    db,
    c.get("tenantId"),
    input,
    actorOf(c),
    await instanceUrl(c),
  );
  // The response carries the token: nothing may keep a copy.
  c.header("cache-control", "no-store");
  return c.json(created, 201);
});

endpointsRoutes.get("/removals", admin, async (c) => {
  return c.json(await listRemovals(db, c.get("tenantId")));
});

endpointsRoutes.get("/agent-updates", admin, async (c) => {
  return c.json(await getAgentUpdates(db, c.get("tenantId")));
});

endpointsRoutes.put("/agent-updates", admin, async (c) => {
  const { paused, resumeMachines } = await parseJsonBody(c.req, agentUpdatesSchema);
  return c.json(
    await setAgentUpdates(db, c.get("tenantId"), paused, actorOf(c), { resumeMachines }),
  );
});

endpointsRoutes.get("/agent-policy", admin, async (c) => {
  return c.json(await getTenantAgentPolicy(db, c.get("tenantId")));
});

endpointsRoutes.put("/agent-policy", admin, async (c) => {
  const input = await parseJsonBody(c.req, agentPolicyLevelSchema);
  return c.json(await updateTenantAgentPolicy(db, c.get("tenantId"), input, actorOf(c)));
});

endpointsRoutes.delete("/agent-updates/machines/:id", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await resumeMachineUpdates(db, c.get("tenantId"), id, actorOf(c)));
});

endpointsRoutes.delete("/tokens/:tokenId", admin, async (c) => {
  const { tokenId } = parseOrProblem(tokenIdParamSchema, c.req.param());
  await revokeEnrollmentToken(db, c.get("tenantId"), tokenId, actorOf(c));
  return c.body(null, 204);
});

endpointsRoutes.get("/:id", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const instance = await instanceUrl(c);
  return c.json(
    await getEndpoint(db, c.get("tenantId"), id, instance.url, { revealHooks: mayConfigure(c) }),
  );
});

endpointsRoutes.get("/:id/agent-policy", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await getEndpointAgentPolicy(db, c.get("tenantId"), id));
});

endpointsRoutes.patch("/:id", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, updateEndpointSchema);
  return c.json(
    await updateEndpoint(db, c.get("tenantId"), id, input, actorOf(c), {
      confirmHookChange: () => assertRecentSignIn(c.get("auth").session),
    }),
  );
});

endpointsRoutes.post("/:id/revoke", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  await revokeEndpoint(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 204);
});

endpointsRoutes.post("/:id/uninstall", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await requestUninstall(db, c.get("tenantId"), id, actorOf(c)), 202);
});

/**
 * Deleting a machine's backups (and cancelling that) is the provider owners' (0.5.0), like
 * deleting a tenant: the strongest role there is. A tenant's own administrators (an
 * organization's "owner" is a tenant administrator too) and provider members below owner may
 * still remove a machine with its backups kept until they expire.
 */
function assertProviderOwner(c: Context<TenantEnv>): void {
  if (c.get("isProviderAdmin") && c.get("providerAccess")?.role === "owner") {
    return;
  }
  throw new ProblemError(403, "Owner only", {
    type: ENDPOINT_PROBLEMS.ownerRequired,
    detail:
      "Only an owner of the provider team can delete the backups of a machine or cancel such a deletion.",
    extensions: { required: "owner" },
  });
}

endpointsRoutes.post("/:id/remove", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, removeEndpointSchema);
  if (input.mode === "delete") {
    assertProviderOwner(c);
  }
  // Deleting backups cannot be undone: a sign-in from the last minutes, like other such actions.
  assertRecentSignIn(c.get("auth").session);
  // Restore mode: the restored database may not know every backup of the machine.
  if (input.mode === "delete") {
    await assertNotInRestoreMode("endpoint_removal", c.get("tenantId"));
  }
  const holdSettings = await retentionHoldSettings(providerDb).catch(() => null);
  return c.json(
    await removeEndpoint(db, c.get("tenantId"), id, input, actorOf(c), {
      suspicionHoldsApply: holdSettings?.enabled ?? true,
      installationTimeZone: async () => (await loadInstallationTimeZone(providerDb)).timeZone,
    }),
    202,
  );
});

endpointsRoutes.post("/:id/remove/cancel", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  assertProviderOwner(c);
  await cancelRemoval(db, c.get("tenantId"), id, actorOf(c));
  return c.body(null, 204);
});

endpointsRoutes.post("/:id/tasks", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, createTaskSchema);
  // A restore operator restores files; backing up now is the admins'.
  if (input.kind !== "restore" && !isTenantAdmin(c.get("role"))) {
    throw new ProblemError(403, "Insufficient role", {
      detail: "Backing up now requires the tenant_admin role.",
      extensions: { requiredRole: "tenant_admin", role: c.get("role") },
    });
  }
  const result = await createTask(db, c.get("tenantId"), id, input, readerOf(c));
  return c.json(result, result.alreadyQueued ? 200 : 202);
});

endpointsRoutes.post("/:id/cancel", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await cancelEndpointBackup(db, c.get("tenantId"), id, actorOf(c)), 202);
});

endpointsRoutes.post("/:id/update", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await requestEndpointUpdate(db, c.get("tenantId"), id, actorOf(c)), 202);
});

endpointsRoutes.post("/:id/restore-test", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await requestRestoreTest(db, c.get("tenantId"), id, actorOf(c)), 202);
});

endpointsRoutes.post("/:id/repository-password", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  assertRecentSignIn(c.get("auth").session);
  const key = await revealRepositoryPassword(db, c.get("tenantId"), id, actorOf(c));
  // The response carries the password: nothing may keep a copy.
  c.header("cache-control", "no-store");
  return c.json(key);
});

endpointsRoutes.get("/:id/runs", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const { limit } = parseOrProblem(listRunsQuerySchema, c.req.query());
  return c.json(await listRuns(db, c.get("tenantId"), id, limit));
});

endpointsRoutes.get("/:id/runs/:runId", admin, async (c) => {
  const { id, runId } = parseOrProblem(runParamSchema, c.req.param());
  return c.json(await getRun(db, c.get("tenantId"), id, runId));
});

endpointsRoutes.get("/:id/snapshots", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await listSnapshots(db, c.get("tenantId"), id));
});

/** Whether a restore point is immutable, as the storage reports it for its snapshot file. */
endpointsRoutes.get("/:id/snapshots/:snapshotId/immutability", restorer, async (c) => {
  const { id, snapshotId } = parseOrProblem(snapshotImmutabilityParamSchema, c.req.param());
  const tenantId = c.get("tenantId");
  const [row] = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ id: endpoints.id })
      .from(endpoints)
      .where(
        and(
          eq(endpoints.tenantId, tenantId),
          eq(endpoints.id, id),
          // A removed machine whose backups are still stored keeps its restore points (#65).
          or(
            isNull(endpoints.removedAt),
            sql`coalesce(${endpoints.removal}->>'state', '') <> 'done'`,
          ),
        ),
      )
      .limit(1),
  );
  if (!row) {
    throw new ProblemError(404, "Endpoint not found");
  }
  return c.json(await resticRestorePointImmutability(db, tenantId, endpointPrefix(id), snapshotId));
});

endpointsRoutes.get("/:id/browse", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const query = parseOrProblem(browseQuerySchema, c.req.query());
  return c.json(
    await browseSnapshot(db, c.get("tenantId"), id, query, readerOf(c), c.req.raw.signal),
  );
});

endpointsRoutes.get("/:id/baremetal", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await getBaremetalState(db, c.get("tenantId"), id));
});

endpointsRoutes.get("/:id/baremetal/layouts/:layoutId", admin, async (c) => {
  const { id, layoutId } = parseOrProblem(layoutParamSchema, c.req.param());
  return c.json(await getLayout(db, c.get("tenantId"), id, layoutId));
});

// Bare metal recovery (docs/BAREMETAL.md 9, 11). A busy repository (approve, 503) asks the web
// app to come back in half a minute.
function retryAfterOnBusy(c: Context, error: unknown): never {
  if (error instanceof ProblemError && error.type === ENDPOINT_PROBLEMS.repositoryLocked) {
    c.header("retry-after", "30");
  }
  throw error;
}

endpointsRoutes.post("/:id/recovery-codes", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, issueRecoveryCodeSchema);
  // The code reads every backup of the machine: a sign-in from the last minutes.
  assertRecentSignIn(c.get("auth").session);
  const issued = await issueRecoveryCode(
    db,
    c.get("tenantId"),
    id,
    input,
    actorOf(c),
    await instanceUrl(c),
  );
  // The response carries the code: nothing may keep a copy.
  c.header("cache-control", "no-store");
  return c.json(issued, 201);
});

endpointsRoutes.post("/:id/recovery-codes/:codeId/revoke", admin, async (c) => {
  const { id, codeId } = parseOrProblem(recoveryCodeParamSchema, c.req.param());
  return c.json(await revokeRecoveryCode(db, c.get("tenantId"), id, codeId, actorOf(c)));
});

endpointsRoutes.post("/:id/recovery-codes/:codeId/extend", admin, async (c) => {
  const { id, codeId } = parseOrProblem(recoveryCodeParamSchema, c.req.param());
  const { validityHours } = await parseJsonBody(c.req, extendRecoveryCodeSchema);
  assertRecentSignIn(c.get("auth").session);
  return c.json(
    await extendRecoveryCode(db, c.get("tenantId"), id, codeId, validityHours, actorOf(c)),
  );
});

endpointsRoutes.get("/:id/recoveries", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await listRecoveries(db, c.get("tenantId"), id));
});

endpointsRoutes.get("/:id/recoveries/:recoveryId", admin, async (c) => {
  const { id, recoveryId } = parseOrProblem(recoveryParamSchema, c.req.param());
  const page = parseOrProblem(recoveryLogQuerySchema, c.req.query());
  c.header("cache-control", "no-store");
  return c.json(await getRecovery(db, c.get("tenantId"), id, recoveryId, page));
});

endpointsRoutes.post("/:id/recoveries/:recoveryId/approve", admin, async (c) => {
  const { id, recoveryId } = parseOrProblem(recoveryParamSchema, c.req.param());
  // Releasing hands the ISO the repository password: a sign-in from the last minutes.
  assertRecentSignIn(c.get("auth").session);
  try {
    return c.json(await approveRecovery(db, c.get("tenantId"), id, recoveryId, actorOf(c)));
  } catch (error) {
    return retryAfterOnBusy(c, error);
  }
});

endpointsRoutes.post("/:id/recoveries/:recoveryId/cancel", admin, async (c) => {
  const { id, recoveryId } = parseOrProblem(recoveryParamSchema, c.req.param());
  return c.json(await cancelRecovery(db, c.get("tenantId"), id, recoveryId, actorOf(c)));
});

endpointsRoutes.put("/:id/recoveries/:recoveryId/ssh-keys", admin, async (c) => {
  const { id, recoveryId } = parseOrProblem(recoveryParamSchema, c.req.param());
  const { keys } = await parseJsonBody(c.req, recoverySshKeysSchema);
  assertRecentSignIn(c.get("auth").session);
  return c.json(await setRecoverySshKeys(db, c.get("tenantId"), id, recoveryId, keys, actorOf(c)));
});

endpointsRoutes.post("/:id/rebind-token", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, createRebindTokenSchema);
  // The token gives lasting access like an installed agent: a sign-in from the last minutes.
  assertRecentSignIn(c.get("auth").session);
  const created = await createRebindToken(
    db,
    c.get("tenantId"),
    id,
    input,
    actorOf(c),
    await instanceUrl(c),
  );
  // The response carries the token: nothing may keep a copy.
  c.header("cache-control", "no-store");
  return c.json(created, 201);
});

/**
 * Read the body of a download request with a cap: a selection of ten thousand
 * paths fits, anything much larger is refused before it is parsed.
 */
async function readDownloadBody(c: Context<TenantEnv>): Promise<unknown> {
  const tooLarge = () =>
    new ProblemError(413, "Selection too large", {
      type: ENDPOINT_PROBLEMS.downloadTooLarge,
      detail:
        "The selected paths are too many or too long for one download. Select fewer items, or a parent folder.",
    });
  const declared = Number(c.req.header("content-length"));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BODY_BYTES) {
    throw tooLarge();
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_DOWNLOAD_BODY_BYTES) {
    throw tooLarge();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

endpointsRoutes.post("/:id/downloads", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = parseOrProblem(createDownloadSchema, await readDownloadBody(c));
  const prepared = await prepareDownload(
    db,
    c.get("tenantId"),
    id,
    input,
    readerOf(c),
    c.req.raw.signal,
  );
  c.header("cache-control", "no-store");
  return c.json(prepared, 201);
});

endpointsRoutes.get("/:id/downloads/:downloadId", restorerForDownload, async (c) => {
  // Hono answers a HEAD request with the GET handler; a probe must not use up the download.
  if (c.req.method === "HEAD") {
    return c.body(null, 405, { allow: "GET" });
  }
  const { id, downloadId } = parseOrProblem(downloadParamSchema, c.req.param());
  const download = await openDownload(
    db,
    c.get("tenantId"),
    id,
    downloadId,
    readerOf(c),
    c.req.raw.signal,
  );
  const fileName = download.fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "files.zip";
  return new Response(Readable.toWeb(download.stream) as unknown as ReadableStream, {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${fileName}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

// ---------------------------------------------------------------------------
// The native SQL Server backup (W2a, docs/BAREMETAL-WINDOWS.md 5.1)
// ---------------------------------------------------------------------------

endpointsRoutes.get("/:id/sql", restorer, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await getSqlOverview(db, c.get("tenantId"), id));
});

endpointsRoutes.get("/:id/sql/databases/:databaseId/backups", restorer, async (c) => {
  const { id, databaseId } = parseOrProblem(sqlDatabaseParamSchema, c.req.param());
  return c.json(await listSqlBackups(db, c.get("tenantId"), id, databaseId));
});

endpointsRoutes.post("/:id/sql/restore", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, sqlRestoreSchema);
  return c.json(await requestSqlRestore(db, c.get("tenantId"), id, input, actorOf(c)), 202);
});

endpointsRoutes.post("/:id/sql/verify", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, sqlVerifySchema);
  return c.json(await requestSqlVerify(db, c.get("tenantId"), id, input, actorOf(c)), 202);
});

endpointsRoutes.post("/:id/sql/inventory", admin, async (c) => {
  const { id } = parseOrProblem(endpointIdParamSchema, c.req.param());
  return c.json(await requestSqlInventory(db, c.get("tenantId"), id, actorOf(c)), 202);
});

endpointsRoutes.get("/:id/sql/backups/:backupId/restore-script", admin, async (c) => {
  const { id, backupId } = parseOrProblem(sqlBackupParamSchema, c.req.param());
  const script = await sqlRestoreScript(db, c.get("tenantId"), id, backupId, actorOf(c));
  return c.body(script.body, 200, {
    "content-type": "text/plain; charset=utf-8",
    "content-disposition": `attachment; filename="${script.fileName}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
});

endpointsRoutes.post("/:id/sql/databases/:databaseId/tde-confirm", admin, async (c) => {
  const { id, databaseId } = parseOrProblem(sqlDatabaseParamSchema, c.req.param());
  return c.json(await confirmSqlTde(db, c.get("tenantId"), id, databaseId, actorOf(c)));
});
