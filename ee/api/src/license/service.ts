import { type Database, type License, license } from "@restow/db";
import { eq } from "drizzle-orm";
import {
  customerTenants,
  loadTenantUsage,
  totalMailboxes,
} from "../../../../apps/api/src/features/usage/service.js";
import { audit } from "../../../../apps/api/src/lib/audit.js";
import {
  readPendingLicenseKey,
  removePendingLicenseKey,
} from "../../../../apps/api/src/lib/pending-license-key.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import {
  type LicenseVerificationKey,
  environmentEdition,
  licenseKeyId,
  resolveLicensePublicKey,
  verifyLicenseToken,
} from "../../../licensing/src/index.js";
import { type LicenseStateDto, buildLicenseState } from "./dto.js";
import {
  LICENSE_PROBLEM_TYPES,
  installationNotConfigured,
  licenseNotInstalled,
  licenseRejected,
  verificationUnavailable,
} from "./problems.js";
import {
  effectiveLicenseOf,
  loadInstallationId,
  loadInstalledLicense,
  lockLicenseRows,
} from "./store.js";

/**
 * Installing and removing license keys (provider admins only).
 *
 * A key is verified offline against the build's Ed25519 public key (or the
 * `RESTOW_LICENSE_PUBLIC_KEY` override) and must be bound to this
 * installation. Only its verified terms and signature are stored; the key text
 * itself is not kept. Every change lands in the installation audit chain with
 * the edition and the protected mailboxes (core usage figures) at that moment.
 */

export const LICENSE_AUDIT_ACTIONS = {
  installed: "license.installed",
  removed: "license.removed",
  /** A key entered on the Community build failed verification here and was dropped. */
  pendingRejected: "license.pending_key.rejected",
} as const;

/** Who changes the license, for the audit log. */
export interface LicenseActor {
  /** null for the system (a key entered on the Community build, applied at start). */
  id: string | null;
  email: string;
  ip: string | null;
}

/** The actor of a key that was entered on the Community build and is applied here. */
export const PENDING_KEY_ACTOR: LicenseActor = { id: null, email: "system", ip: null };

let verificationKey: LicenseVerificationKey | undefined;

/** The verification key of this process, resolved once (the environment does not change). */
export function licenseVerificationKey(): LicenseVerificationKey {
  verificationKey ??= resolveLicensePublicKey(process.env);
  return verificationKey;
}

function keyIdOf(row: License | null): string | null {
  return row?.signature ? licenseKeyId(row.signature) : null;
}

function stateOf(installed: License | null, installationId: string | null): LicenseStateDto {
  return buildLicenseState({
    effective: effectiveLicenseOf(installed),
    environmentEdition: environmentEdition(),
    installed,
    installedKeyId: keyIdOf(installed),
    installationId,
    verification: licenseVerificationKey(),
  });
}

export type PendingKeyOutcome = "none" | "installed" | "rejected" | "deferred";

/**
 * A key entered on the Community build (Installation, Edition) waits in the core's secret
 * store (apps/api/src/lib/pending-license-key.ts) until this, the full build, runs. It is
 * verified exactly like a key entered on the License page and then removed: installed when
 * it verifies, dropped (and the rejection audited) when it does not. It stays when it
 * cannot be checked yet (no verification key, setup not finished) and is tried again.
 */
export async function applyPendingLicenseKey(db: Database): Promise<PendingKeyOutcome> {
  const key = await readPendingLicenseKey(db);
  if (!key) {
    return "none";
  }
  try {
    await installLicense(db, key, PENDING_KEY_ACTOR);
  } catch (error) {
    if (error instanceof ProblemError && error.type === LICENSE_PROBLEM_TYPES.invalid) {
      await removePendingLicenseKey(db);
      await audit(db, {
        actor: PENDING_KEY_ACTOR.email,
        actorUserId: null,
        action: LICENSE_AUDIT_ACTIONS.pendingRejected,
        target: (await loadInstallationId(db)) ?? null,
        targetType: "installation",
        ip: null,
        details: { reason: error.extensions?.reason ?? null },
      });
      return "rejected";
    }
    return "deferred";
  }
  await removePendingLicenseKey(db);
  return "installed";
}

/** The license in effect and the installed key. */
export async function getLicenseState(db: Database): Promise<LicenseStateDto> {
  await applyPendingLicenseKey(db).catch(() => "deferred");
  const [installed, installationId] = await Promise.all([
    loadInstalledLicense(db),
    loadInstallationId(db),
  ]);
  return stateOf(installed, installationId);
}

/**
 * Verify and install a license key. Installing the key that is already
 * active changes nothing. A key of an edition without tenant management is
 * accepted even when several tenants exist: nothing that is protected stops,
 * only creating further tenants stays closed.
 */
export async function installLicense(
  db: Database,
  key: string,
  actor: LicenseActor,
): Promise<LicenseStateDto> {
  const verification = licenseVerificationKey();
  if (verification.status !== "ready") {
    throw verificationUnavailable(verification.status);
  }
  const installationId = await loadInstallationId(db);
  if (!installationId) {
    throw installationNotConfigured();
  }
  const result = verifyLicenseToken(key, verification.key, { installationId });
  if (!result.ok) {
    throw licenseRejected(result, installationId);
  }
  const granted = result.license;

  const [previous, tenants] = await Promise.all([loadInstalledLicense(db), loadTenantUsage(db)]);
  if (previous?.signature === granted.signature) {
    return stateOf(previous, installationId);
  }

  const before = effectiveLicenseOf(previous);
  const installed = await db.transaction(async (tx) => {
    await lockLicenseRows(tx);
    await tx.update(license).set({ active: false }).where(eq(license.active, true));
    const [row] = await tx
      .insert(license)
      .values({
        edition: granted.edition,
        multiTenant: granted.multiTenant,
        licensee: granted.licensee,
        installationId: granted.installationId,
        signature: granted.signature,
        issuedAt: granted.issuedAt,
        active: true,
      })
      .returning();
    if (!row) {
      throw new Error("license insert returned no row");
    }
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: LICENSE_AUDIT_ACTIONS.installed,
      target: installationId,
      targetType: "installation",
      ip: actor.ip,
      details: {
        edition: granted.edition,
        multiTenant: granted.multiTenant,
        licensee: granted.licensee,
        keyId: granted.keyId,
        issuedAt: granted.issuedAt.toISOString(),
        previousEdition: before.edition,
        previousSource: before.source,
        mailboxesInUse: totalMailboxes(tenants),
        // The provider's customers: its own organisation is not one of them.
        tenants: customerTenants(tenants).length,
      },
    });
    return row;
  });
  return stateOf(installed, installationId);
}

/**
 * Remove the installed key. The edition without a key applies again; nothing
 * that is already protected stops.
 */
export async function removeLicense(db: Database, actor: LicenseActor): Promise<LicenseStateDto> {
  const [installed, installationId, tenants] = await Promise.all([
    loadInstalledLicense(db),
    loadInstallationId(db),
    loadTenantUsage(db),
  ]);
  if (!installed) {
    throw licenseNotInstalled();
  }
  await db.transaction(async (tx) => {
    await lockLicenseRows(tx);
    await tx.update(license).set({ active: false }).where(eq(license.active, true));
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: LICENSE_AUDIT_ACTIONS.removed,
      target: installationId ?? installed.installationId,
      targetType: "installation",
      ip: actor.ip,
      details: {
        edition: installed.edition,
        licensee: installed.licensee,
        keyId: keyIdOf(installed),
        fallbackEdition: environmentEdition(),
        mailboxesInUse: totalMailboxes(tenants),
        // The provider's customers: its own organisation is not one of them.
        tenants: customerTenants(tenants).length,
      },
    });
  });
  return stateOf(null, installationId);
}
