import {
  generateAgentSecret,
  generateEnrollmentToken,
  hashSecret,
  isSupportedEndpointOs,
  RESTIC_VERSION,
} from "@restow/core";
import {
  type Database,
  type Endpoint,
  type EndpointEnrollmentToken,
  endpointEnrollmentTokens,
  endpoints,
  endpointTasks,
  tenants,
} from "@restow/db";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { config as appConfig } from "../../config.js";
import { db, providerDb } from "../../db.js";
import { readSecret } from "../../lib/secrets.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import {
  agentFactsOf,
  configResponse,
  ENROLLMENT_INVALID_PROBLEM,
  type EnrollResponse,
  repositoryUrl,
} from "./agent-service.js";
import { raiseTenantEvent } from "./alerts.js";
import { agentActor, auditEndpoint, ENDPOINT_AUDIT_ACTIONS, type EndpointActor } from "./audit.js";
import { installCommands } from "./commands.js";
import { isSafeOrigin } from "./distribution.js";
import type { CreatedTokenDto } from "./dto.js";
import { isInsecureTransport } from "./instance-url.js";
import { ENDPOINT_PROBLEMS } from "./problems.js";
import type { CreateRebindTokenInput, EnrollInput } from "./schemas.js";
import { loadEndpoint, toTokenDto, windowsInstallFacts } from "./service.js";

/**
 * Rebinding a machine (docs/BAREMETAL.md 11): the agent's state file is no longer backed up
 * (5.4), and a recovery code only reads, so a restored or reinstalled machine gets back to Restow
 * with a token of its own. It gives lasting access like an installed agent, so it has its own
 * dialog and its own audit entries and alert, and is valid for an hour unless chosen otherwise
 * (at most 24, CHECK in 0078).
 *
 * The token is an enrollment token (`rset_`, single use, only its SHA-256 stored) with the machine
 * it rebinds (`endpoint_id`). Redeemed through `POST /agent/v1/enroll` (the existing install
 * command) or, in the recovery ISO, through the session's `rebind` (recovery-service.ts), it
 * creates no machine: the existing one gets a new agent secret (`rotateEndpointSecret`) and keeps
 * its repository, password, jobs, settings and runs. The operating system must be the same; a new
 * hostname is taken and noted. A revoked machine comes back only when the token was issued with
 * `unrevoke`. The previous installation of the machine gets 401 from then on, and the next good
 * backup is the new baseline of the ransomware signals (`endpoint_runs.activity_baseline`).
 */

export interface CreatedRebindTokenDto extends CreatedTokenDto {
  kind: "rebind";
  purpose: "baremetal" | "reinstall";
  endpointId: string;
  unrevoke: boolean;
}

/** Issue a rebind token for a machine of the tenant (admin, recent sign-in in the route). */
export async function createRebindToken(
  database: Database,
  tenantId: string,
  endpointId: string,
  input: CreateRebindTokenInput,
  actor: EndpointActor,
  instance: { url: string; configured: boolean },
  now: Date = new Date(),
): Promise<CreatedRebindTokenDto> {
  if (!instance.url || !isSafeOrigin(instance.url)) {
    throw new ProblemError(503, "Instance address unknown", {
      type: ENDPOINT_PROBLEMS.instanceUnknown,
      detail: "The public address of this installation is not configured.",
    });
  }
  const token = generateEnrollmentToken();
  const { row, endpoint } = await withTenantTx(database, tenantId, async (tx) => {
    // A removed machine is gone from every list: it cannot come back (404).
    const endpoint = await loadEndpoint(tx, tenantId, endpointId);
    if (input.unrevoke && endpoint.status !== "revoked") {
      throw new ProblemError(422, "Machine not revoked", {
        type: ENDPOINT_PROBLEMS.notRevoked,
        detail: "Only a revoked machine can be brought back with this token.",
      });
    }
    const expiresAt = new Date(now.getTime() + input.validityHours * 60 * 60 * 1000);
    const [created] = await tx
      .insert(endpointEnrollmentTokens)
      .values({
        tenantId,
        tokenHash: token.hash,
        profile: endpoint.profile,
        displayName: null,
        expiresAt,
        createdBy: actor.userId,
        createdAt: now,
        endpointId,
        purpose: input.purpose,
        unrevoke: input.unrevoke,
      })
      .returning();
    if (!created) {
      throw new Error("token insert returned no row");
    }
    await auditEndpoint(tx, {
      tenantId,
      actor,
      action: ENDPOINT_AUDIT_ACTIONS.rebindTokenCreated,
      endpointId,
      target: { id: created.id, type: "endpoint_enrollment_token" },
      details: {
        endpointId,
        hostname: endpoint.hostname,
        purpose: input.purpose,
        unrevoke: input.unrevoke,
        validityHours: input.validityHours,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return { row: created, endpoint };
  });
  const windows = endpoint.os === "windows" ? await windowsInstallFacts(instance.url) : null;
  const warnings: CreatedTokenDto["warnings"] = [];
  if (isInsecureTransport(instance.url)) {
    warnings.push("insecure_transport");
  }
  if (!instance.configured) {
    warnings.push("instance_url_not_configured");
  }
  return {
    ...toTokenDto(row, now, endpoint.displayName?.trim() || endpoint.hostname),
    token: token.value,
    kind: "rebind",
    purpose: input.purpose,
    endpointId,
    unrevoke: input.unrevoke,
    os: endpoint.os,
    instanceUrl: instance.url,
    commands: installCommands(endpoint.os, instance.url, {
      releaseKeyFingerprint: windows?.releaseKeyFingerprint ?? null,
    }),
    ...(windows ? { windows } : {}),
    warnings,
  };
}

/** What the restored or reinstalled system says about itself (the enroll facts). */
export type RebindFacts = Pick<
  EnrollInput,
  "hostname" | "os" | "arch" | "agentVersion" | "osVersion" | "hooks"
> &
  Partial<Pick<EnrollInput, "machine" | "dataFolders">>;

export interface RebindContext {
  ip: string | null;
  instanceUrl: string;
  /** Which way the token came: the install command (`enroll`) or the ISO's session (`recovery`). */
  via: "enroll" | "recovery";
  /** The recovery session the ISO rebinds from. */
  recoveryId?: string;
}

/** Put a claimed token back, so the same command can be run again after a refusal. */
export async function releaseEnrollmentToken(tokenId: string): Promise<void> {
  await providerDb
    .update(endpointEnrollmentTokens)
    .set({ usedAt: null, usedByEndpointId: null })
    .where(eq(endpointEnrollmentTokens.id, tokenId));
}

/** Claim a valid token by its value (single use), on the installation role; null when none. */
export async function claimEnrollmentToken(
  value: string,
  now: Date,
): Promise<EndpointEnrollmentToken | null> {
  const [claimed] = await providerDb
    .update(endpointEnrollmentTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(endpointEnrollmentTokens.tokenHash, hashSecret(value)),
        isNull(endpointEnrollmentTokens.usedAt),
        isNull(endpointEnrollmentTokens.revokedAt),
        gt(endpointEnrollmentTokens.expiresAt, now),
      ),
    )
    .returning();
  return claimed ?? null;
}

/**
 * Give the machine of a claimed rebind token a new agent secret (docs/BAREMETAL.md 11), in one
 * tenant transaction: the operating system must be the machine's (422), a revoked machine comes
 * back only with `unrevoke` (else 409), a removed one never. The new secret replaces the old one
 * (the previous installation gets 401 from now on), the facts of the new system are taken, pending
 * uninstall orders end (they were meant for the old installation), the next good backup becomes
 * the new baseline of the ransomware signals, and the rebind is audited and alerted. The
 * repository is the machine's: nothing is initialised. Answers the agent's state as an enrollment
 * does, with `rebound: true`. The repository password is read in the same transaction, before
 * anything changes: on a refusal or a failure the transaction rolls back and the token is released
 * for a retry. Once the rotation committed the token stays used.
 */
export async function rotateEndpointSecret(
  claimed: EndpointEnrollmentToken,
  input: RebindFacts,
  context: RebindContext,
  now: Date = new Date(),
): Promise<EnrollResponse & { rebound: true }> {
  const endpointId = claimed.endpointId;
  if (!endpointId) {
    throw new Error("not a rebind token");
  }
  const tenantId = claimed.tenantId;
  const secret = generateAgentSecret();
  let committed = false;
  try {
    const [tenant] = await providerDb
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (tenant?.status !== "active") {
      throw new ProblemError(403, "Tenant suspended", {
        detail: "The tenant of this token is currently suspended.",
      });
    }
    const rotated = await withTenantTx(db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.id, endpointId)))
        .for("update")
        .limit(1);
      if (!row || row.removedAt) {
        throw new ProblemError(409, "Endpoint removed", {
          type: ENDPOINT_PROBLEMS.revoked,
          detail: "This machine was removed from Restow; it cannot be rebound.",
        });
      }
      if (!isSupportedEndpointOs(input.os) || input.os !== row.os) {
        throw new ProblemError(422, "Operating system differs", {
          type: ENDPOINT_PROBLEMS.rebindOsMismatch,
          detail: `This token rebinds a ${row.os} machine; this system is "${input.os.slice(0, 40)}".`,
          extensions: { expected: row.os, actual: input.os.slice(0, 40) },
        });
      }
      const unrevoked = row.status === "revoked";
      if (unrevoked && !claimed.unrevoke) {
        throw new ProblemError(409, "Endpoint revoked", {
          type: ENDPOINT_PROBLEMS.revoked,
          detail:
            "This machine was revoked. Issue a rebind token that brings it back to rebind it.",
        });
      }
      // The answer needs the repository password: without it nothing is rotated.
      const password = row.repositorySecretId
        ? await readSecret(tx, { id: row.repositorySecretId, tenantId })
        : null;
      if (password === null) {
        throw new ProblemError(409, "Repository password missing", {
          type: ENDPOINT_PROBLEMS.repositoryUnavailable,
          detail: "The repository password of this machine is not available.",
        });
      }
      const facts = agentFactsOf(input, now, row.os);
      const settings = {
        ...row.settings,
        ...(facts ? { agent: facts } : {}),
        activityBaselinePending: true,
      };
      const [updated] = await tx
        .update(endpoints)
        .set({
          secretHash: secret.hash,
          hostname: input.hostname,
          arch: input.arch,
          agentVersion: input.agentVersion,
          osVersion: input.osVersion,
          settings,
          lastSeenAt: now,
          staleAlertedAt: null,
          ...(unrevoked ? { status: "active" as const, revokedAt: null } : {}),
          updatedAt: now,
        })
        .where(eq(endpoints.id, endpointId))
        .returning();
      if (!updated) {
        throw new Error("endpoint update returned no row");
      }
      // An uninstall order was meant for the previous installation; the new agent must not run it.
      await tx
        .update(endpointTasks)
        .set({ status: "failed", finishedAt: now, errorMessage: "machine rebound" })
        .where(
          and(
            eq(endpointTasks.endpointId, endpointId),
            eq(endpointTasks.kind, "uninstall"),
            inArray(endpointTasks.status, ["pending", "delivered"]),
          ),
        );
      await tx
        .update(endpointEnrollmentTokens)
        .set({ usedByEndpointId: endpointId })
        .where(eq(endpointEnrollmentTokens.id, claimed.id));
      const actor = agentActor(input.hostname, context.ip);
      if (unrevoked) {
        await auditEndpoint(tx, {
          tenantId,
          actor,
          action: ENDPOINT_AUDIT_ACTIONS.unrevoked,
          endpointId,
          details: { hostname: input.hostname, tokenId: claimed.id, via: context.via },
        });
      }
      const name = row.displayName?.trim() || row.hostname;
      await auditEndpoint(tx, {
        tenantId,
        actor,
        action: ENDPOINT_AUDIT_ACTIONS.rebound,
        endpointId,
        details: {
          previousHostname: row.hostname,
          hostname: input.hostname,
          ip: context.ip,
          purpose: claimed.purpose,
          via: context.via,
          tokenId: claimed.id,
          agentVersion: input.agentVersion,
          ...(context.recoveryId ? { recoveryId: context.recoveryId } : {}),
          ...(unrevoked ? { unrevoked: true } : {}),
        },
      });
      await raiseTenantEvent(tx, {
        tenantId,
        event: "endpoint.rebound",
        level: "error",
        message: `${name} was rebound: it has a new agent secret, and its previous installation no longer has access.`,
        details: {
          endpointId,
          objectName: name,
          previousHostname: row.hostname,
          hostname: input.hostname,
          ip: context.ip,
          purpose: claimed.purpose,
          via: context.via,
        },
        now,
      });
      return { endpoint: updated, password };
    });
    committed = true;
    return rebindAnswer(
      rotated.endpoint,
      rotated.password,
      secret.value,
      context.instanceUrl,
      input.os,
    );
  } catch (error) {
    // Before the commit nothing changed and nothing was handed out: the token works for a retry.
    // After it the token stays used: the rotation happened, a retry would rotate again.
    if (!committed) {
      await releaseEnrollmentToken(claimed.id).catch(() => undefined);
    }
    throw error;
  }
}

/** The agent's state after a rebind: the machine's repository and configuration, the new secret. */
function rebindAnswer(
  endpoint: Endpoint,
  password: string,
  agentSecret: string,
  instanceUrl: string,
  os: string,
): EnrollResponse & { rebound: true } {
  return {
    endpointId: endpoint.id,
    agentSecret,
    repository: { url: repositoryUrl(instanceUrl, endpoint.id), password },
    config: configResponse(endpoint.config, endpoint.configVersion, undefined, {
      os,
      baremetalPreview: appConfig.baremetalPreview,
    }),
    restic: { version: RESTIC_VERSION },
    rebound: true,
  };
}

/**
 * The session's `rebind` in the ISO (docs/BAREMETAL.md 10.19): a token of the session's own
 * machine only; any other valid token is put back and refused like an unknown one.
 */
export async function redeemRebindInRecovery(
  session: { id: string; endpointId: string },
  input: RebindFacts & { token: string },
  context: Omit<RebindContext, "via" | "recoveryId">,
  now: Date = new Date(),
): Promise<EnrollResponse & { rebound: true }> {
  const claimed = await claimEnrollmentToken(input.token, now);
  if (!claimed || claimed.endpointId !== session.endpointId) {
    if (claimed) {
      await releaseEnrollmentToken(claimed.id);
    }
    throw new ProblemError(401, "Rebind token not valid", {
      type: ENROLLMENT_INVALID_PROBLEM,
      detail:
        "The token is unknown, expired, revoked, used, or not a rebind token of this machine.",
      extensions: { reason: claimed ? "other_endpoint" : "unknown" },
    });
  }
  return rotateEndpointSecret(
    claimed,
    input,
    { ...context, via: "recovery", recoveryId: session.id },
    now,
  );
}
