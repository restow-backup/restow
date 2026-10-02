import { type Database, type License, license } from "@restow/db";
import { eq } from "drizzle-orm";
import {
  customerTenants,
  loadTenantUsage,
  totalMailboxes,
} from "../../../../apps/api/src/features/usage/service.js";
import { audit } from "../../../../apps/api/src/lib/audit.js";
import {
  type LicenseVerificationKey,
  environmentEdition,
  licenseKeyId,
  resolveLicensePublicKey,
  verifyLicenseToken,
} from "../../../licensing/src/index.js";
import { type LicenseStateDto, buildLicenseState } from "./dto.js";
import {
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
} as const;

/** Who changes the license, for the audit log. */
export interface LicenseActor {
  id: string;
  email: string;
  ip: string | null;
}

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

/** The license in effect and the installed key. */
export async function getLicenseState(db: Database): Promise<LicenseStateDto> {
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
