import {
  ENTRA_APP_SECRET_KIND,
  type EntraAppResolution,
  EntraAppResolver,
  deriveInstallationSecretsKey,
  entraAppEnvironmentFrom,
  kekFromBase64,
} from "@restow/core";
import { type Database, findInstallationSecret } from "@restow/db";

/**
 * The Microsoft 365 backup app registration for this worker process
 * (@restow/core entra/app-registration.ts): ENTRA_CLIENT_* from the environment
 * when they are complete, otherwise the registration a provider admin saved
 * under Settings → Microsoft 365. That one is an installation-level secret,
 * hidden from the tenant-pinned job transactions, so it is read on the
 * installation pool and opened with the installation secrets key.
 *
 * Handlers resolve it when they build a Graph client, never at start-up: a
 * saved change reaches running workers within the resolver's TTL, and token
 * caches keyed by the registration's fingerprint drop tokens of the old one.
 */

type Env = Record<string, string | undefined>;

/** What a handler needs: the registration that applies right now. */
export interface EntraAppLookup {
  resolve(): Promise<EntraAppResolution>;
}

let processResolver: EntraAppResolver | null = null;

/** Build the process-wide resolver; called once by the entry point (index.ts). */
export function configureEntraApp(options: {
  readonly providerDb: Database;
  readonly masterKey: string;
  readonly env?: Env;
}): EntraAppResolver {
  const kek = kekFromBase64(options.masterKey);
  processResolver = new EntraAppResolver({
    environment: entraAppEnvironmentFrom(options.env ?? process.env),
    loadStored: () => findInstallationSecret(options.providerDb, ENTRA_APP_SECRET_KIND),
    installationKey: () => deriveInstallationSecretsKey(kek),
  });
  return processResolver;
}

/** The process-wide lookup the handlers use by default. */
export const processEntraApp: EntraAppLookup = {
  async resolve() {
    if (!processResolver) {
      throw new Error("the Microsoft 365 app registration is not configured in this process");
    }
    return processResolver.resolve();
  },
};
