import {
  DEFAULT_STORAGE_SECRET_KIND,
  InstallationDefaultResolver,
  type StorageTargets,
  deriveInstallationSecretsKey,
  kekFromBase64,
  openInstallationDefault,
} from "@restow/core";
import { type Database, findInstallationSecret } from "@restow/db";

/**
 * The installation default storage for this worker process (@restow/core
 * storage/installation-default.ts): the default a provider owner saved under
 * Installation → Default storage, otherwise the environment (STORAGE_TARGET,
 * STORAGE_LOCAL_PATH, S3_*; STORAGE_COPY_LOCAL_PATH always from the
 * environment). The API resolves the same default through the same resolver
 * (apps/api/src/lib/installation-default.ts), so a tenant without a primary
 * target of its own reads and writes the same place in both processes.
 *
 * The saved document is an installation-level secret, hidden from the
 * tenant-pinned job transactions, so it is read on the installation pool and
 * opened with the installation secrets key. Answers are cached for the
 * resolver's TTL; before a job on a queue that writes to storage uses a cached
 * tenant storage, `resolveStorageForJob` compares the cached default's
 * generation with {@link DefaultStorageLookup.generation}, read afresh, so a
 * changed default is never written to from a stale cache.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The default's opened backends and the generation they belong to. */
export interface DefaultStorageSnapshot {
  readonly targets: StorageTargets;
  /** Changes whenever the default changes (core `installationDefaultGeneration`). */
  readonly generation: string;
}

export interface DefaultStorageLookup {
  /** The default that applies right now; throws when it is not usable. */
  current(): Promise<DefaultStorageSnapshot>;
  /** The current generation, read from the database right now. */
  generation(): Promise<string>;
}

/** A lookup over one resolver; opened backends are reused while the generation stays the same. */
export function defaultStorageLookup(resolver: InstallationDefaultResolver): DefaultStorageLookup {
  let opened: { key: string; snapshot: DefaultStorageSnapshot } | null = null;
  return {
    async current() {
      const resolution = await resolver.resolve();
      if (resolution.status !== "ready") {
        throw new Error(`installation default storage is not usable: ${resolution.detail}`);
      }
      // The environment's generation never changes, its values might (tests): key on both.
      const key = JSON.stringify([
        resolution.generation,
        resolution.storage.primary,
        resolution.storage.copy,
      ]);
      if (opened?.key !== key) {
        const targets = openInstallationDefault(resolution.storage);
        opened = {
          key,
          snapshot: {
            targets: {
              primary: targets.primary.backend,
              copies: targets.copy ? [targets.copy.backend] : [],
            },
            generation: resolution.generation,
          },
        };
      }
      return opened.snapshot;
    },
    generation: () => resolver.generation(),
  };
}

let processLookup: DefaultStorageLookup | null = null;

/** Build the process-wide lookup; called once by the entry point (index.ts). */
export function configureDefaultStorage(options: {
  readonly providerDb: Database;
  readonly masterKey: string;
  readonly env?: Env;
}): DefaultStorageLookup {
  const kek = kekFromBase64(options.masterKey);
  processLookup = defaultStorageLookup(
    new InstallationDefaultResolver({
      env: options.env ?? process.env,
      loadStored: () => findInstallationSecret(options.providerDb, DEFAULT_STORAGE_SECRET_KIND),
      installationKey: () => deriveInstallationSecretsKey(kek),
    }),
  );
  return processLookup;
}

/**
 * The process-wide lookup the handlers use. Before {@link configureDefaultStorage}
 * ran (tests that drive a handler directly), the environment alone applies.
 */
export function processDefaultStorage(): DefaultStorageLookup {
  // No cache: without the database, the environment is all there is, read each time.
  processLookup ??= defaultStorageLookup(new InstallationDefaultResolver({ ttlMs: 0 }));
  return processLookup;
}
