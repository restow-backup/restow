import {
  DEFAULT_STORAGE_SECRET_KIND,
  type InstallationDefaultResolution,
  InstallationDefaultResolver,
  type InstallationDefaultStorage,
} from "@restow/core";
import { findInstallationSecret } from "@restow/db";
import { providerDb } from "../db.js";
import { installationSecretsKey } from "./secrets.js";

/**
 * The installation default storage of this API process (@restow/core
 * storage/installation-default.ts): the default a provider owner saved under
 * Installation → Default storage, otherwise the environment (STORAGE_TARGET,
 * STORAGE_LOCAL_PATH, S3_*). Every reader in the API goes through this one
 * resolver (restore downloads, mail previews, imports, the storage page, the
 * dashboard), never `installationDefaultStorage(process.env)` directly, so the
 * API and the worker (apps/worker/src/default-storage.ts) agree on where a
 * tenant without a primary target keeps its data.
 *
 * The saved document is an installation-level secret, hidden from tenant
 * sessions by Row Level Security, so it is read on the installation pool.
 * Saving or removing it here invalidates this process's cache at once; other
 * processes follow within the resolver's TTL.
 */

let resolver: InstallationDefaultResolver | null = null;

export function installationDefaultResolver(): InstallationDefaultResolver {
  resolver ??= new InstallationDefaultResolver({
    loadStored: () => findInstallationSecret(providerDb, DEFAULT_STORAGE_SECRET_KIND),
    installationKey: installationSecretsKey,
  });
  return resolver;
}

/** Replace the resolver (tests); null builds the real one again on next use. */
export function setInstallationDefaultResolver(next: InstallationDefaultResolver | null): void {
  resolver = next;
}

/** The default that applies right now, or why there is none. */
export function resolveInstallationDefault(): Promise<InstallationDefaultResolution> {
  return installationDefaultResolver().resolve();
}

/** The default's storage, or null when neither the saved default nor the environment is usable. */
export async function currentInstallationDefault(): Promise<InstallationDefaultStorage | null> {
  const resolution = await resolveInstallationDefault();
  return resolution.status === "ready" ? resolution.storage : null;
}

/** Forget the cached default after it was saved or removed in this process. */
export function invalidateInstallationDefault(): void {
  installationDefaultResolver().invalidate();
}
