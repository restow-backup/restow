/**
 * The installation default storage: where every tenant without a primary
 * target of its own keeps its chunk store (docs/STORAGE.md, "Installation
 * default").
 *
 * Two sources, in this order:
 *
 *   1. the default a provider owner saved under Installation → Default storage:
 *      one JSON document sealed in the secret store (installation level, kind
 *      `default_storage`, opened with the installation secrets key), carrying
 *      the addressing and, for S3, the access key pair;
 *   2. the server environment (STORAGE_TARGET, STORAGE_LOCAL_PATH, S3_*), for
 *      installations that never saved one.
 *
 * STORAGE_COPY_LOCAL_PATH (a mounted share every default write is copied to)
 * always comes from the environment: it is part of the server, not a setting.
 *
 * The api and the worker each hold one {@link InstallationDefaultResolver} and
 * resolve the default through it, never from `process.env` directly, so both
 * agree on where a tenant's data lives. Answers are cached for a short TTL; a
 * process that saved a change invalidates its own cache, and
 * {@link InstallationDefaultResolver.generation} reads the stored row afresh
 * (no decryption) so a worker can notice a change before writing.
 */
import type { Dek } from "../crypto.js";
import type { S3CredentialsSecret } from "../engine/types.js";
import { openSecret } from "../secret-seal.js";
import {
  type InstallationDefaultStorage,
  type StorageKind,
  type StorageLocation,
  StorageTargetError,
  environmentDefaultCopy,
  installationDefaultStorage,
  storageLocationConfig,
  validateStorageLocation,
} from "./factory.js";

/** `secrets.kind` of the saved default (installation level, at most one row). */
export const DEFAULT_STORAGE_SECRET_KIND = "default_storage";

/** How long a resolved default is reused before the stored row is read again. */
export const DEFAULT_STORAGE_CACHE_TTL_MS = 30_000;

/** Generation of the environment default (no saved document). */
export const ENVIRONMENT_DEFAULT_GENERATION = "environment";

export type InstallationDefaultSource = "database" | "environment";

/** The sealed document behind a default saved in the web UI. */
export interface InstallationDefaultDocument {
  readonly version: 1;
  readonly kind: StorageKind;
  /** `storageLocationConfig` of the location; validated again on every read. */
  readonly config: Record<string, unknown>;
  /** The S3 access key pair; null for a local path. Never leaves the server. */
  readonly credentials: S3CredentialsSecret | null;
  readonly updatedAt: string;
  /** Email of the provider owner who saved it. */
  readonly updatedBy: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the plaintext of a `default_storage` secret; throws on anything malformed. */
export function parseInstallationDefaultDocument(json: string): InstallationDefaultDocument {
  const parsed: unknown = JSON.parse(json);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    (parsed.kind !== "local" && parsed.kind !== "s3") ||
    !isRecord(parsed.config) ||
    typeof parsed.updatedAt !== "string" ||
    typeof parsed.updatedBy !== "string"
  ) {
    throw new Error("the saved default storage document is malformed");
  }
  let credentials: S3CredentialsSecret | null = null;
  if (isRecord(parsed.credentials)) {
    const { accessKeyId, secretAccessKey } = parsed.credentials;
    if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string") {
      throw new Error("the saved default storage credentials are malformed");
    }
    credentials = { accessKeyId, secretAccessKey };
  }
  return {
    version: 1,
    kind: parsed.kind,
    config: parsed.config,
    credentials,
    updatedAt: parsed.updatedAt,
    updatedBy: parsed.updatedBy,
  };
}

export function serializeInstallationDefaultDocument(
  document: InstallationDefaultDocument,
): string {
  return JSON.stringify({
    version: 1,
    kind: document.kind,
    config: document.config,
    credentials: document.credentials
      ? {
          accessKeyId: document.credentials.accessKeyId,
          secretAccessKey: document.credentials.secretAccessKey,
        }
      : null,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy,
  });
}

/** The document for a validated location. */
export function installationDefaultDocument(
  location: StorageLocation,
  credentials: S3CredentialsSecret | null,
  updatedBy: string,
  now: Date,
): InstallationDefaultDocument {
  return {
    version: 1,
    kind: location.kind,
    config: storageLocationConfig(location),
    credentials: location.kind === "s3" ? credentials : null,
    updatedAt: now.toISOString(),
    updatedBy,
  };
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The default a saved document describes: its location and credentials, plus
 * the environment's STORAGE_COPY_LOCAL_PATH. Throws {@link StorageTargetError}
 * when the stored addressing no longer validates.
 */
export function installationDefaultFromDocument(
  document: InstallationDefaultDocument,
  env: Env = process.env,
): InstallationDefaultStorage {
  const validation = validateStorageLocation(document.kind, document.config);
  if (!validation.ok) {
    const fields = validation.issues.map((issue) => `${issue.field}: ${issue.reason}`).join(", ");
    throw new StorageTargetError(
      "invalid_config",
      `the saved default storage is invalid (${fields})`,
      validation.issues,
    );
  }
  return {
    primary: validation.location,
    credentials:
      validation.location.kind === "s3" ? (document.credentials ?? undefined) : undefined,
    copy: environmentDefaultCopy(env),
  };
}

/** A `secrets` row holding the sealed document, as read on the installation pool. */
export interface StoredInstallationDefaultRow {
  readonly id: string;
  readonly ciphertext: string;
  readonly updatedAt: Date | string;
}

/** The default that applies right now, or why there is none. */
export type InstallationDefaultResolution =
  | {
      readonly status: "ready";
      readonly source: InstallationDefaultSource;
      readonly storage: InstallationDefaultStorage;
      /** Changes whenever the default changes ({@link InstallationDefaultResolver.generation}). */
      readonly generation: string;
      /** The saved document (source `database`); null for the environment. */
      readonly document: InstallationDefaultDocument | null;
    }
  | {
      readonly status: "unusable";
      readonly source: InstallationDefaultSource;
      readonly generation: string;
      /** Operator-facing; names variables or the page, never a credential. */
      readonly detail: string;
    };

export interface InstallationDefaultResolverOptions {
  readonly env?: Env;
  /** Reads the `default_storage` row (installation level); omitted = environment only. */
  readonly loadStored?: () => Promise<StoredInstallationDefaultRow | null>;
  /** The installation secrets key; only called when a document has to be opened. */
  readonly installationKey?: () => Dek;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function timestampOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The generation a stored row (or its absence) stands for. */
export function installationDefaultGeneration(row: StoredInstallationDefaultRow | null): string {
  return row ? `database:${row.id}:${timestampOf(row.updatedAt)}` : ENVIRONMENT_DEFAULT_GENERATION;
}

/**
 * Resolves the installation default: the saved document first, then the
 * environment. One instance per process; answers are cached for `ttlMs`.
 */
export class InstallationDefaultResolver {
  private cached: { value: InstallationDefaultResolution; expiresAt: number } | null = null;
  private inFlight: Promise<InstallationDefaultResolution> | null = null;
  private epoch = 0;

  constructor(private readonly options: InstallationDefaultResolverOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get env(): Env {
    return this.options.env ?? process.env;
  }

  /** The default to use right now. Database errors propagate (a retry may help). */
  resolve(): Promise<InstallationDefaultResolution> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.value);
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const epoch = this.epoch;
    const pending = this.load().then((value) => {
      if (epoch === this.epoch) {
        this.cached = {
          value,
          expiresAt: this.now() + (this.options.ttlMs ?? DEFAULT_STORAGE_CACHE_TTL_MS),
        };
      }
      return value;
    });
    this.inFlight = pending;
    const clear = () => {
      if (this.inFlight === pending) {
        this.inFlight = null;
      }
    };
    pending.then(clear, clear);
    return pending;
  }

  /**
   * The default's storage, or a {@link StorageTargetError} saying why there is
   * none (what callers that can only report, not fix, the configuration need).
   */
  async storage(): Promise<InstallationDefaultStorage> {
    const resolution = await this.resolve();
    if (resolution.status !== "ready") {
      throw new StorageTargetError("invalid_config", resolution.detail);
    }
    return resolution.storage;
  }

  /**
   * The current generation, read from the database right now (no cache, no
   * decryption). When it differs from the cached answer's, the cache is
   * dropped so the next {@link resolve} loads the new default.
   */
  async generation(): Promise<string> {
    const row = this.options.loadStored ? await this.options.loadStored() : null;
    const current = installationDefaultGeneration(row);
    if (this.cached && this.cached.value.generation !== current) {
      this.invalidate();
    }
    return current;
  }

  /** Forget the cached answer (after this process saved or removed the default). */
  invalidate(): void {
    this.epoch += 1;
    this.cached = null;
    this.inFlight = null;
  }

  private async load(): Promise<InstallationDefaultResolution> {
    const row = this.options.loadStored ? await this.options.loadStored() : null;
    const generation = installationDefaultGeneration(row);
    if (!row) {
      try {
        return {
          status: "ready",
          source: "environment",
          storage: installationDefaultStorage(this.env),
          generation,
          document: null,
        };
      } catch (error) {
        if (error instanceof StorageTargetError) {
          return { status: "unusable", source: "environment", generation, detail: error.message };
        }
        throw error;
      }
    }
    let document: InstallationDefaultDocument;
    try {
      if (!this.options.installationKey) {
        throw new Error("no installation key");
      }
      document = parseInstallationDefaultDocument(
        openSecret(this.options.installationKey(), row.id, row.ciphertext),
      );
    } catch {
      return {
        status: "unusable",
        source: "database",
        generation,
        detail:
          "The default storage saved under Installation → Default storage could not be opened. Was RESTOW_MASTER_KEY changed? Save the default storage again.",
      };
    }
    try {
      return {
        status: "ready",
        source: "database",
        storage: installationDefaultFromDocument(document, this.env),
        generation,
        document,
      };
    } catch (error) {
      if (error instanceof StorageTargetError) {
        return { status: "unusable", source: "database", generation, detail: error.message };
      }
      throw error;
    }
  }
}
