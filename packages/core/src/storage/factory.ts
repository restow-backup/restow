/**
 * Storage targets: from configuration to a working, checked backend.
 *
 * A tenant's chunk store lives on one primary target and any number of copy
 * targets (docs/ARCHITECTURE.md, Chunk-Store / Backends). A target is either a
 * mounted filesystem (`local`: the Docker volume, an NFS or SMB mount) or an
 * S3-compatible bucket (`s3`: Hetzner Object Storage, Garage, Wasabi, Backblaze
 * B2, AWS). This module turns the stored description of a target into a
 * {@link StorageBackend} and answers the questions an operator asks about it:
 *
 *   - validation:  is the addressing well-formed (paths, bucket names, endpoints)?
 *   - opening:     build the backend, with S3 credentials from the secret store
 *   - resolution:  which backends a tenant writes to (primary + copies), with the
 *                  installation default (environment) as the fallback primary
 *   - health:      a write/read/list/delete probe with per-step timings and a
 *                  classified error an operator can act on
 *   - capability:  does the bucket enforce Object Lock (WORM)? A filesystem never does.
 *
 * Nothing here logs or returns credentials; error texts name keys and paths only.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Stats, existsSync } from "node:fs";
import { constants, access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  GetObjectLockConfigurationCommand,
  type GetObjectLockConfigurationCommandOutput,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { tenantPrefix } from "../engine/layout.js";
import type { S3CredentialsSecret, SecretReader, StorageTargets } from "../engine/types.js";
import type { StorageBackend } from "./backend.js";
import { LocalStorageBackend } from "./local.js";
import { S3StorageBackend } from "./s3.js";

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export type StorageKind = "local" | "s3";
export type StorageRole = "primary" | "copy";

export const STORAGE_KINDS: readonly StorageKind[] = ["local", "s3"];

/** A mounted filesystem: the Docker volume or an NFS/SMB share mounted into the containers. */
export interface LocalStorageLocation {
  readonly kind: "local";
  /** Absolute, normalized directory path (no trailing slash). */
  readonly basePath: string;
}

/** An S3-compatible bucket. */
export interface S3StorageLocation {
  readonly kind: "s3";
  readonly bucket: string;
  /** Key prefix without leading/trailing slashes, or null for the bucket root. */
  readonly prefix: string | null;
  /** Service origin (`https://host[:port]`) for non-AWS services; null for AWS. */
  readonly endpoint: string | null;
  readonly region: string;
  /** Path-style addressing (`endpoint/bucket/key`) instead of virtual-hosted buckets. */
  readonly forcePathStyle: boolean;
}

/** Where a target keeps its objects: the validated, normalized addressing of a target. */
export type StorageLocation = LocalStorageLocation | S3StorageLocation;

/** Region the AWS SDK signs with when none is configured (the S3 default). */
export const DEFAULT_S3_REGION = "us-east-1";

export type StorageConfigField =
  | "kind"
  | "basePath"
  | "bucket"
  | "prefix"
  | "endpoint"
  | "region"
  | "forcePathStyle";

/**
 * Why a field was rejected. Short machine reasons: the API returns them as
 * problem details and the UI maps them to translated messages.
 */
export type StorageConfigReason =
  | "required"
  | "type"
  | "too_long"
  | "invalid_characters"
  | "absolute_path"
  | "path_traversal"
  | "root_path"
  | "system_path"
  | "bucket_name"
  | "prefix"
  | "endpoint_url"
  | "endpoint_protocol"
  | "endpoint_path"
  | "endpoint_credentials"
  | "region"
  | "unknown_kind";

export interface StorageConfigIssue {
  readonly field: StorageConfigField;
  readonly reason: StorageConfigReason;
}

export type StorageLocationValidation =
  | { readonly ok: true; readonly location: StorageLocation }
  | { readonly ok: false; readonly issues: readonly StorageConfigIssue[] };

const MAX_PATH_LENGTH = 1024;
const MAX_PREFIX_LENGTH = 512;

/** C0 control characters and DEL never belong in a path. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Directories a storage target must never point into: the operating system and
 * the Restow installation itself (`/prod` in the runtime image).
 */
const FORBIDDEN_ROOTS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/proc",
  "/prod",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
];

/** S3 bucket naming rules (the strict, DNS-compatible subset every provider accepts). */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IP_ADDRESS_LIKE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const PREFIX_CHARACTERS = /^[A-Za-z0-9._\-/]+$/;
const REGION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An optional string field: undefined/null/"" mean "not set" (null). A value of
 * the wrong type is reported and yields undefined, so no second issue follows.
 */
function optionalString(
  config: Record<string, unknown>,
  field: StorageConfigField,
  issues: StorageConfigIssue[],
): string | null | undefined {
  const value = config[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    issues.push({ field, reason: "type" });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when `path` is `root` or lies below it (segment-wise, not by string prefix). */
function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

function validateBasePath(
  raw: string | null | undefined,
  issues: StorageConfigIssue[],
): string | null {
  if (raw === undefined) {
    return null;
  }
  if (raw === null) {
    issues.push({ field: "basePath", reason: "required" });
    return null;
  }
  if (raw.length > MAX_PATH_LENGTH) {
    issues.push({ field: "basePath", reason: "too_long" });
    return null;
  }
  if (hasControlCharacters(raw) || raw.includes("\\")) {
    issues.push({ field: "basePath", reason: "invalid_characters" });
    return null;
  }
  if (!raw.startsWith("/") || !isAbsolute(raw)) {
    issues.push({ field: "basePath", reason: "absolute_path" });
    return null;
  }
  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    issues.push({ field: "basePath", reason: "path_traversal" });
    return null;
  }
  const normalized = `/${segments.join("/")}`;
  if (normalized === "/") {
    issues.push({ field: "basePath", reason: "root_path" });
    return null;
  }
  if (FORBIDDEN_ROOTS.some((root) => isWithin(normalized, root))) {
    issues.push({ field: "basePath", reason: "system_path" });
    return null;
  }
  return normalized;
}

function validateBucket(
  raw: string | null | undefined,
  issues: StorageConfigIssue[],
): string | null {
  if (raw === undefined) {
    return null;
  }
  if (raw === null) {
    issues.push({ field: "bucket", reason: "required" });
    return null;
  }
  const valid =
    BUCKET_NAME.test(raw) &&
    !raw.includes("..") &&
    !raw.includes(".-") &&
    !raw.includes("-.") &&
    !IP_ADDRESS_LIKE.test(raw);
  if (!valid) {
    issues.push({ field: "bucket", reason: "bucket_name" });
    return null;
  }
  return raw;
}

function validatePrefix(
  raw: string | null | undefined,
  issues: StorageConfigIssue[],
): string | null {
  if (raw === undefined) {
    return null;
  }
  if (raw === null) {
    return null;
  }
  const trimmed = raw.replace(/^\/+|\/+$/g, "");
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_PREFIX_LENGTH) {
    issues.push({ field: "prefix", reason: "too_long" });
    return null;
  }
  const segments = trimmed.split("/");
  const valid =
    PREFIX_CHARACTERS.test(trimmed) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  if (!valid) {
    issues.push({ field: "prefix", reason: "prefix" });
    return null;
  }
  return trimmed;
}

function validateEndpoint(
  raw: string | null | undefined,
  issues: StorageConfigIssue[],
): string | null {
  if (raw === undefined) {
    return null;
  }
  if (raw === null) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    issues.push({ field: "endpoint", reason: "endpoint_url" });
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    issues.push({ field: "endpoint", reason: "endpoint_protocol" });
    return null;
  }
  if (url.username || url.password) {
    issues.push({ field: "endpoint", reason: "endpoint_credentials" });
    return null;
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    issues.push({ field: "endpoint", reason: "endpoint_path" });
    return null;
  }
  return url.origin;
}

function validateRegion(raw: string | null | undefined, issues: StorageConfigIssue[]): string {
  if (raw === null || raw === undefined) {
    return DEFAULT_S3_REGION;
  }
  if (!REGION.test(raw)) {
    issues.push({ field: "region", reason: "region" });
  }
  return raw;
}

function validateForcePathStyle(
  value: unknown,
  endpoint: string | null,
  issues: StorageConfigIssue[],
): boolean {
  if (value === undefined || value === null) {
    // Custom services (Garage, many NAS gateways) expect path style; AWS prefers virtual hosts.
    return endpoint !== null;
  }
  if (typeof value !== "boolean") {
    issues.push({ field: "forcePathStyle", reason: "type" });
    return false;
  }
  return value;
}

/**
 * Validate and normalize the addressing of a target. Unknown keys in `config`
 * (health records, capability detection) are ignored, so a stored row can be
 * passed as is.
 */
export function validateStorageLocation(kind: unknown, config: unknown): StorageLocationValidation {
  const issues: StorageConfigIssue[] = [];
  const record = isRecord(config) ? config : {};

  if (kind === "local") {
    const basePath = validateBasePath(optionalString(record, "basePath", issues), issues);
    return basePath !== null && issues.length === 0
      ? { ok: true, location: { kind: "local", basePath } }
      : { ok: false, issues };
  }

  if (kind === "s3") {
    const bucket = validateBucket(optionalString(record, "bucket", issues), issues);
    const prefix = validatePrefix(optionalString(record, "prefix", issues), issues);
    const endpoint = validateEndpoint(optionalString(record, "endpoint", issues), issues);
    const region = validateRegion(optionalString(record, "region", issues), issues);
    const forcePathStyle = validateForcePathStyle(record.forcePathStyle, endpoint, issues);
    return bucket !== null && issues.length === 0
      ? { ok: true, location: { kind: "s3", bucket, prefix, endpoint, region, forcePathStyle } }
      : { ok: false, issues };
  }

  return { ok: false, issues: [{ field: "kind", reason: "unknown_kind" }] };
}

/** The `storage_targets.config` addressing keys for a location (no credentials, ever). */
export function storageLocationConfig(location: StorageLocation): Record<string, unknown> {
  if (location.kind === "local") {
    return { basePath: location.basePath };
  }
  return {
    bucket: location.bucket,
    ...(location.prefix ? { prefix: location.prefix } : {}),
    ...(location.endpoint ? { endpoint: location.endpoint } : {}),
    region: location.region,
    forcePathStyle: location.forcePathStyle,
  };
}

/** A one-line description for logs, audit entries and cards: a path or `s3://bucket/prefix (host)`. */
export function describeStorageLocation(location: StorageLocation): string {
  if (location.kind === "local") {
    return location.basePath;
  }
  const path = location.prefix ? `${location.bucket}/${location.prefix}` : location.bucket;
  const host = location.endpoint ? new URL(location.endpoint).host : "AWS";
  return `s3://${path} (${host})`;
}

function prefixSegmentsOverlap(a: string | null, b: string | null): boolean {
  if (a === null || b === null) {
    return true;
  }
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * True when two locations share storage: the same place, or one nested inside
 * the other. A copy that overlaps its primary is not an independent copy.
 */
export function storageLocationsOverlap(a: StorageLocation, b: StorageLocation): boolean {
  if (a.kind === "local" && b.kind === "local") {
    return isWithin(a.basePath, b.basePath) || isWithin(b.basePath, a.basePath);
  }
  if (a.kind === "s3" && b.kind === "s3") {
    return (
      (a.endpoint ?? "aws") === (b.endpoint ?? "aws") &&
      a.bucket === b.bucket &&
      prefixSegmentsOverlap(a.prefix, b.prefix)
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Raised when a target cannot be opened: invalid addressing or unusable credentials. */
export class StorageTargetError extends Error {
  constructor(
    readonly code: "invalid_config" | "credentials_missing" | "credentials_invalid",
    message: string,
    readonly issues: readonly StorageConfigIssue[] = [],
  ) {
    super(message);
    this.name = "StorageTargetError";
  }
}

/** Parse the JSON plaintext of an `s3_credentials` secret. */
export function parseS3CredentialsSecret(raw: string): S3CredentialsSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StorageTargetError("credentials_invalid", "S3 credentials secret is not JSON");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.accessKeyId !== "string" ||
    typeof parsed.secretAccessKey !== "string" ||
    parsed.accessKeyId.length === 0 ||
    parsed.secretAccessKey.length === 0
  ) {
    throw new StorageTargetError(
      "credentials_invalid",
      "S3 credentials secret lacks accessKeyId/secretAccessKey",
    );
  }
  return {
    accessKeyId: parsed.accessKeyId,
    secretAccessKey: parsed.secretAccessKey,
    ...(typeof parsed.sessionToken === "string" && parsed.sessionToken.length > 0
      ? { sessionToken: parsed.sessionToken }
      : {}),
  };
}

/** The plaintext stored for an `s3_credentials` secret. */
export function serializeS3CredentialsSecret(credentials: S3CredentialsSecret): string {
  return JSON.stringify({
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
  });
}

// ---------------------------------------------------------------------------
// Opening targets
// ---------------------------------------------------------------------------

/**
 * `data` clients carry backups (patient: retries, no request deadline, large
 * packs); `probe` clients answer a health check quickly (one attempt, short
 * deadlines) so an unreachable endpoint fails in seconds, not minutes.
 */
export type StorageClientPurpose = "data" | "probe";

const CONNECTION_TIMEOUT_MS = 10_000;
const PROBE_REQUEST_TIMEOUT_MS = 15_000;

/** The AWS SDK configuration for a bucket location. */
export function s3ClientConfig(
  location: S3StorageLocation,
  credentials: S3CredentialsSecret | undefined,
  purpose: StorageClientPurpose = "data",
): S3ClientConfig {
  return {
    region: location.region,
    forcePathStyle: location.forcePathStyle,
    ...(location.endpoint ? { endpoint: location.endpoint } : {}),
    ...(credentials ? { credentials } : {}),
    ...(purpose === "probe" ? { maxAttempts: 1 } : {}),
    requestHandler: {
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      ...(purpose === "probe" ? { requestTimeout: PROBE_REQUEST_TIMEOUT_MS } : {}),
    },
  };
}

/** A backend together with the checks an operator can run against it. */
export interface OpenedStorageTarget {
  readonly location: StorageLocation;
  readonly backend: StorageBackend;
  /** Write, read, list and delete a small probe object below `keyPrefix`. */
  probe(options: StorageProbeOptions): Promise<StorageProbeResult>;
  /** Whether the target enforces Object Lock (WORM). A filesystem never does. */
  detectObjectLock(now?: () => Date): Promise<ObjectLockCapability>;
}

export interface OpenStorageOptions {
  /** Plaintext S3 credentials; omitted = the SDK's default provider chain. */
  readonly credentials?: S3CredentialsSecret;
  readonly purpose?: StorageClientPurpose;
  /** Inject a client (tests); otherwise one is built from the location. */
  readonly s3Client?: S3Client;
  /** Host facts for the local path inspection (tests). */
  readonly host?: HostFacts;
}

/** Build the backend for a validated location. */
export function openStorageLocation(
  location: StorageLocation,
  options: OpenStorageOptions = {},
): OpenedStorageTarget {
  if (location.kind === "local") {
    const backend = new LocalStorageBackend(location.basePath);
    return {
      location,
      backend,
      probe: async (probeOptions) => {
        const started = performance.now();
        const inspection = await inspectLocalPath(location.basePath, {
          requireExisting: probeOptions.requireExistingPath ?? true,
          host: options.host,
        });
        return probeStorageBackend(backend, probeOptions, {
          ...inspection,
          durationMs: elapsed(started),
        });
      },
      detectObjectLock: async (now = () => new Date()) => filesystemObjectLock(now()),
    };
  }

  const client =
    options.s3Client ??
    new S3Client(s3ClientConfig(location, options.credentials, options.purpose ?? "data"));
  const backend = new S3StorageBackend({
    bucket: location.bucket,
    prefix: location.prefix ?? undefined,
    client,
  });
  const insecure = location.endpoint?.startsWith("http:") ?? false;
  return {
    location,
    backend,
    probe: async (probeOptions) => {
      const result = await probeStorageBackend(backend, probeOptions);
      return insecure ? withWarning(result, "insecure_endpoint") : result;
    },
    detectObjectLock: (now = () => new Date()) =>
      detectS3ObjectLock(client, location.bucket, now()),
  };
}

/** A `storage_targets` row as far as opening it is concerned. */
export interface StorageTargetRecord {
  readonly id: string;
  readonly kind: string;
  readonly config: unknown;
  readonly secretRef: string | null;
}

/**
 * Open a stored target: validate its addressing, read its S3 credentials from
 * the tenant's secret store and build the backend.
 */
export async function openStorageTarget(
  record: StorageTargetRecord,
  secrets: SecretReader,
  options: Omit<OpenStorageOptions, "credentials"> = {},
): Promise<OpenedStorageTarget> {
  const validation = validateStorageLocation(record.kind, record.config);
  if (!validation.ok) {
    const fields = validation.issues.map((issue) => `${issue.field}: ${issue.reason}`).join(", ");
    throw new StorageTargetError(
      "invalid_config",
      `storage target ${record.id} has an invalid configuration (${fields})`,
      validation.issues,
    );
  }
  let credentials: S3CredentialsSecret | undefined;
  if (validation.location.kind === "s3" && record.secretRef) {
    const raw = await secrets.get(record.secretRef);
    if (raw === null) {
      throw new StorageTargetError(
        "credentials_missing",
        `storage target ${record.id} references a secret that does not exist`,
      );
    }
    credentials = parseS3CredentialsSecret(raw);
  }
  return openStorageLocation(validation.location, { ...options, credentials });
}

// ---------------------------------------------------------------------------
// Installation default and per-tenant resolution
// ---------------------------------------------------------------------------

/** The installation-wide storage from the environment, used by tenants without a primary target. */
export interface InstallationDefaultStorage {
  readonly primary: StorageLocation;
  /** Credentials for an S3 primary from S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY. */
  readonly credentials: S3CredentialsSecret | undefined;
  /** STORAGE_COPY_LOCAL_PATH, a mounted share every default write is copied to. */
  readonly copy: LocalStorageLocation | null;
}

type Env = Readonly<Record<string, string | undefined>>;

function env(values: Env, name: string): string | undefined {
  const value = values[name]?.trim();
  return value ? value : undefined;
}

function requireValid(kind: StorageKind, config: Record<string, unknown>, variable: string) {
  const validation = validateStorageLocation(kind, config);
  if (!validation.ok) {
    const fields = validation.issues.map((issue) => `${issue.field}: ${issue.reason}`).join(", ");
    throw new StorageTargetError("invalid_config", `${variable} is invalid (${fields})`);
  }
  return validation.location;
}

/**
 * Read the installation default exactly as the worker does: STORAGE_TARGET
 * (`local` | `s3`, default local), STORAGE_LOCAL_PATH (default /data/chunks),
 * S3_* and the optional STORAGE_COPY_LOCAL_PATH.
 */
export function installationDefaultStorage(values: Env = process.env): InstallationDefaultStorage {
  const target = env(values, "STORAGE_TARGET") ?? "local";
  if (target !== "local" && target !== "s3") {
    throw new StorageTargetError(
      "invalid_config",
      `STORAGE_TARGET must be "local" or "s3", got "${target}"`,
    );
  }
  const copyPath = env(values, "STORAGE_COPY_LOCAL_PATH");
  const copy = copyPath
    ? (requireValid(
        "local",
        { basePath: copyPath },
        "STORAGE_COPY_LOCAL_PATH",
      ) as LocalStorageLocation)
    : null;

  if (target === "local") {
    return {
      primary: requireValid(
        "local",
        { basePath: env(values, "STORAGE_LOCAL_PATH") ?? "/data/chunks" },
        "STORAGE_LOCAL_PATH",
      ),
      credentials: undefined,
      copy,
    };
  }

  const accessKeyId = env(values, "S3_ACCESS_KEY_ID");
  const secretAccessKey = env(values, "S3_SECRET_ACCESS_KEY");
  return {
    primary: requireValid(
      "s3",
      {
        bucket: env(values, "S3_BUCKET"),
        prefix: env(values, "S3_PREFIX"),
        endpoint: env(values, "S3_ENDPOINT"),
        region: env(values, "S3_REGION"),
        forcePathStyle: (env(values, "S3_FORCE_PATH_STYLE") ?? "true").toLowerCase() !== "false",
      },
      "S3_BUCKET/S3_ENDPOINT/S3_PREFIX/S3_REGION",
    ),
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
    copy,
  };
}

/** Open the installation default targets. */
export function openInstallationDefault(
  defaults: InstallationDefaultStorage,
  purpose: StorageClientPurpose = "data",
): { readonly primary: OpenedStorageTarget; readonly copy: OpenedStorageTarget | null } {
  return {
    primary: openStorageLocation(defaults.primary, { credentials: defaults.credentials, purpose }),
    copy: defaults.copy ? openStorageLocation(defaults.copy, { purpose }) : null,
  };
}

/** A `storage_targets` row as far as resolution is concerned. */
export interface StorageTargetRow extends StorageTargetRecord {
  readonly role: string;
}

export interface ResolvedStorageTargets extends StorageTargets {
  /** True when the primary is the installation default (the tenant has no primary row). */
  readonly usesInstallationDefault: boolean;
  /**
   * Retired primary targets a storage migration replaced (`role: "previous"`,
   * see docs/STORAGE.md): read-only fallbacks for restore, verify and
   * download, so a snapshot that still lives only there stays restorable
   * until retention removes it. Never part of {@link StorageTargets.copies},
   * so the write path (new packs, manifests, wrapped keys) never reaches one.
   */
  readonly previous: readonly StorageBackend[];
}

/**
 * The backends a tenant writes to. The tenant's primary row wins; without one
 * the installation default is the primary (and its configured copy applies).
 * Copy rows always apply, so an offsite copy can be added to a tenant that
 * still lives on the installation default. Rows are used in the given order
 * (callers pass them by creation time, so copy indexes are stable).
 *
 * A `previous` row is opened read-only into {@link ResolvedStorageTargets.previous}
 * instead: the retired primary of a completed storage migration (docs/
 * STORAGE.md). Its `kind` is `installation_default` when the tenant's primary
 * was the environment default before the migration retired it (the row itself
 * carries no addressing); such a row opens to `defaults.primary` exactly as an
 * absent primary row does above, so it keeps working even if the environment's
 * S3 credentials rotate (the same secret-free config that made it usable as
 * the primary before).
 */
export async function resolveStorageTargets(
  rows: readonly StorageTargetRow[],
  options: {
    readonly secrets: SecretReader;
    readonly defaults: StorageTargets | (() => StorageTargets);
  },
): Promise<ResolvedStorageTargets> {
  const primaryRow = rows.find((row) => row.role === "primary");
  const copies: StorageBackend[] = [];
  const previous: StorageBackend[] = [];
  let primary: StorageBackend;
  // Resolved once, lazily: most tenants have a primary row and no `previous`
  // one, so the environment (and its S3 credentials) need not be read at all.
  let defaultsCache: StorageTargets | undefined;
  const defaults = (): StorageTargets => {
    if (!defaultsCache) {
      defaultsCache =
        typeof options.defaults === "function" ? options.defaults() : options.defaults;
    }
    return defaultsCache;
  };
  if (primaryRow) {
    primary = (await openStorageTarget(primaryRow, options.secrets)).backend;
  } else {
    primary = defaults().primary;
    copies.push(...defaults().copies);
  }
  for (const row of rows) {
    if (row.role === "copy") {
      copies.push((await openStorageTarget(row, options.secrets)).backend);
    } else if (row.role === "previous") {
      previous.push(
        row.kind === "installation_default"
          ? defaults().primary
          : (await openStorageTarget(row, options.secrets)).backend,
      );
    }
  }
  return { primary, copies, previous, usesInstallationDefault: primaryRow === undefined };
}

// ---------------------------------------------------------------------------
// Errors an operator can act on
// ---------------------------------------------------------------------------

export type StorageErrorCode =
  | "path_missing"
  | "not_a_directory"
  | "not_writable"
  | "no_space"
  | "access_denied"
  | "invalid_credentials"
  | "bucket_missing"
  | "wrong_region"
  | "unreachable"
  | "tls"
  | "timeout"
  | "integrity"
  | "unknown";

const LOCAL_CODES: Record<string, StorageErrorCode> = {
  ENOENT: "path_missing",
  ENOTDIR: "not_a_directory",
  EISDIR: "not_a_directory",
  EACCES: "not_writable",
  EPERM: "not_writable",
  EROFS: "not_writable",
  ENOSPC: "no_space",
  EDQUOT: "no_space",
};

const NETWORK_CODES: Record<string, StorageErrorCode> = {
  ENOTFOUND: "unreachable",
  EAI_AGAIN: "unreachable",
  ECONNREFUSED: "unreachable",
  ECONNRESET: "unreachable",
  EHOSTUNREACH: "unreachable",
  ENETUNREACH: "unreachable",
  EPIPE: "unreachable",
  ETIMEDOUT: "timeout",
  ESOCKETTIMEDOUT: "timeout",
  CERT_HAS_EXPIRED: "tls",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  SELF_SIGNED_CERT_IN_CHAIN: "tls",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  EPROTO: "tls",
};

const S3_NAMES: Record<string, StorageErrorCode> = {
  AccessDenied: "access_denied",
  Forbidden: "access_denied",
  AllAccessDisabled: "access_denied",
  InvalidAccessKeyId: "invalid_credentials",
  SignatureDoesNotMatch: "invalid_credentials",
  InvalidToken: "invalid_credentials",
  ExpiredToken: "invalid_credentials",
  CredentialsProviderError: "invalid_credentials",
  NoSuchBucket: "bucket_missing",
  PermanentRedirect: "wrong_region",
  AuthorizationHeaderMalformed: "wrong_region",
  IllegalLocationConstraintException: "wrong_region",
  TimeoutError: "timeout",
  RequestTimeout: "timeout",
  RequestTimeoutException: "timeout",
  StorageProbeTimeout: "timeout",
  StorageIntegrityError: "integrity",
};

interface ErrorShape {
  name?: unknown;
  code?: unknown;
  Code?: unknown;
  cause?: unknown;
  $metadata?: { httpStatusCode?: number };
}

function errorChain(error: unknown): ErrorShape[] {
  const chain: ErrorShape[] = [];
  let current: unknown = error;
  while (isRecord(current) && chain.length < 5) {
    chain.push(current as ErrorShape);
    current = (current as ErrorShape).cause;
  }
  return chain;
}

/** Map a thrown value from a backend onto a code the UI explains. */
export function classifyStorageError(error: unknown): StorageErrorCode {
  for (const shape of errorChain(error)) {
    for (const candidate of [shape.code, shape.Code, shape.name]) {
      if (typeof candidate !== "string") {
        continue;
      }
      const code = S3_NAMES[candidate] ?? NETWORK_CODES[candidate] ?? LOCAL_CODES[candidate];
      if (code) {
        return code;
      }
    }
  }
  const status = errorChain(error)[0]?.$metadata?.httpStatusCode;
  if (status === 301 || status === 307) {
    return "wrong_region";
  }
  if (status === 401 || status === 403) {
    return "access_denied";
  }
  return "unknown";
}

const MAX_ERROR_LENGTH = 300;

/** A short diagnostic for the operator. Backend messages name keys and paths, never credentials. */
export function describeStorageError(error: unknown): string {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : isRecord(error) && typeof error.name === "string"
        ? error.name
        : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

// ---------------------------------------------------------------------------
// Local path inspection
// ---------------------------------------------------------------------------

/** Facts about the machine the process runs on (injectable for tests). */
export interface HostFacts {
  /** Running inside a container (Docker/Podman). */
  readonly inContainer: boolean;
  /** Device id of the root filesystem (`stat("/").dev`). */
  readonly rootDevice: number;
}

async function currentHost(): Promise<HostFacts> {
  return {
    inContainer: existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
    rootDevice: (await stat("/")).dev,
  };
}

export interface LocalPathInspection {
  readonly ok: boolean;
  readonly errorCode: StorageErrorCode | null;
  readonly error: string | null;
  /**
   * The directory is on the container's own root filesystem rather than a
   * volume or mount: its data disappears when the container is recreated.
   */
  readonly ephemeral: boolean;
  /** How long the inspection took, when the caller measured it. */
  readonly durationMs?: number;
}

/**
 * Check a local target's directory before writing to it: it must exist (a
 * missing mount must not silently become a directory inside the container),
 * be a directory and be writable.
 */
export async function inspectLocalPath(
  basePath: string,
  options: { readonly requireExisting?: boolean; readonly host?: HostFacts } = {},
): Promise<LocalPathInspection> {
  const host = options.host ?? (await currentHost());
  let info: Stats;
  try {
    info = await stat(basePath);
  } catch (error) {
    if (classifyStorageError(error) === "path_missing" && options.requireExisting === false) {
      return { ok: true, errorCode: null, error: null, ephemeral: false };
    }
    return {
      ok: false,
      errorCode: classifyStorageError(error),
      error: describeStorageError(error),
      ephemeral: false,
    };
  }
  const ephemeral = host.inContainer && info.dev === host.rootDevice;
  if (!info.isDirectory()) {
    return {
      ok: false,
      errorCode: "not_a_directory",
      error: `${basePath} is not a directory`,
      ephemeral,
    };
  }
  try {
    await access(basePath, constants.W_OK | constants.R_OK);
  } catch (error) {
    return {
      ok: false,
      errorCode: "not_writable",
      error: describeStorageError(error),
      ephemeral,
    };
  }
  return { ok: true, errorCode: null, error: null, ephemeral };
}

// ---------------------------------------------------------------------------
// Health probe
// ---------------------------------------------------------------------------

export type StorageProbeStep = "location" | "write" | "read" | "list" | "delete";

/** Findings that do not fail the probe but that an operator must know about. */
export type StorageProbeWarning =
  /** A local directory on the container's root filesystem (lost on recreate). */
  | "ephemeral_path"
  /** An S3 endpoint over plain HTTP: credentials and data travel unencrypted. */
  | "insecure_endpoint"
  /** The probe object could not be removed again. */
  | "cleanup_failed";

export interface StorageProbeStepResult {
  readonly step: StorageProbeStep;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly errorCode: StorageErrorCode | null;
  readonly error: string | null;
}

export interface StorageProbeResult {
  readonly ok: boolean;
  readonly checkedAt: string;
  /** Wall time of the whole probe. */
  readonly durationMs: number;
  readonly steps: readonly StorageProbeStepResult[];
  readonly failedStep: StorageProbeStep | null;
  readonly errorCode: StorageErrorCode | null;
  readonly error: string | null;
  readonly warnings: readonly StorageProbeWarning[];
}

export interface StorageProbeOptions {
  /** Where the probe object goes, ending in `/` (see {@link storageProbePrefix}). */
  readonly keyPrefix: string;
  /** Local targets: fail when the directory does not exist yet (default true). */
  readonly requireExistingPath?: boolean;
  /** Deadline per step (default 15 s). */
  readonly stepTimeoutMs?: number;
  readonly now?: () => Date;
}

/** The probe area of a tenant: `tenants/<tid>/probes/`. */
export function storageProbePrefix(tenantId: string): string {
  return `${tenantPrefix(tenantId)}probes/`;
}

const DEFAULT_STEP_TIMEOUT_MS = 15_000;
const PROBE_PAYLOAD_BYTES = 256;

class StorageProbeTimeout extends Error {
  constructor(step: StorageProbeStep, ms: number) {
    super(`${step} did not complete within ${ms} ms`);
    this.name = "StorageProbeTimeout";
  }
}

class StorageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageIntegrityError";
  }
}

async function timed<T>(
  step: StorageProbeStep,
  timeoutMs: number,
  action: () => Promise<T>,
): Promise<{ result: StorageProbeStepResult; value: T | undefined }> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StorageProbeTimeout(step, timeoutMs)), timeoutMs);
  });
  try {
    const value = await Promise.race([action(), deadline]);
    return {
      result: { step, ok: true, durationMs: elapsed(started), errorCode: null, error: null },
      value,
    };
  } catch (error) {
    return {
      result: {
        step,
        ok: false,
        durationMs: elapsed(started),
        errorCode: classifyStorageError(error),
        error: describeStorageError(error),
      },
      value: undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function withWarning(result: StorageProbeResult, warning: StorageProbeWarning): StorageProbeResult {
  return result.warnings.includes(warning)
    ? result
    : { ...result, warnings: [...result.warnings, warning] };
}

/**
 * Prove a target works end to end: write a small random object, read it back
 * byte for byte, find it in a listing, delete it and confirm it is gone. Stops
 * at the first failing step (after trying to clean up what it wrote).
 */
export async function probeStorageBackend(
  backend: StorageBackend,
  options: StorageProbeOptions,
  localPath?: LocalPathInspection,
): Promise<StorageProbeResult> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const checkedAt = now().toISOString();
  const started = performance.now();
  const steps: StorageProbeStepResult[] = [];
  const warnings: StorageProbeWarning[] = localPath?.ephemeral ? ["ephemeral_path"] : [];

  const finish = (): StorageProbeResult => {
    const failed = steps.find((step) => !step.ok) ?? null;
    return {
      ok: failed === null,
      checkedAt,
      durationMs: elapsed(started),
      steps,
      failedStep: failed?.step ?? null,
      errorCode: failed?.errorCode ?? null,
      error: failed?.error ?? null,
      warnings,
    };
  };

  if (localPath) {
    steps.push({
      step: "location",
      ok: localPath.ok,
      durationMs: localPath.durationMs ?? 0,
      errorCode: localPath.errorCode,
      error: localPath.error,
    });
    if (!localPath.ok) {
      return finish();
    }
  }

  const key = `${options.keyPrefix}${randomUUID()}`;
  const payload = randomBytes(PROBE_PAYLOAD_BYTES);

  const write = await timed("write", timeoutMs, () => backend.put(key, payload));
  steps.push(write.result);
  if (!write.result.ok) {
    return finish();
  }

  const cleanUp = async () => {
    const removed = await timed("delete", timeoutMs, () => backend.delete(key));
    if (!removed.result.ok) {
      warnings.push("cleanup_failed");
    }
  };

  const read = await timed("read", timeoutMs, async () => {
    const bytes = await backend.get(key);
    if (!bytes.equals(payload)) {
      throw new StorageIntegrityError(`${key} read back ${bytes.length} bytes that differ`);
    }
  });
  steps.push(read.result);
  if (!read.result.ok) {
    await cleanUp();
    return finish();
  }

  const list = await timed("list", timeoutMs, async () => {
    const keys = await backend.list(options.keyPrefix);
    if (!keys.includes(key)) {
      throw new StorageIntegrityError(`${key} is missing from the listing of ${options.keyPrefix}`);
    }
  });
  steps.push(list.result);
  if (!list.result.ok) {
    await cleanUp();
    return finish();
  }

  const remove = await timed("delete", timeoutMs, async () => {
    await backend.delete(key);
    if ((await backend.head(key)) !== null) {
      throw new StorageIntegrityError(`${key} still exists after deletion`);
    }
  });
  steps.push(remove.result);
  return finish();
}

// ---------------------------------------------------------------------------
// Object Lock (WORM) capability
// ---------------------------------------------------------------------------

export type ObjectLockStatus = "enabled" | "disabled" | "unsupported" | "unknown";

export interface ObjectLockCapability {
  readonly status: ObjectLockStatus;
  /** Default retention mode of the bucket, when one is configured. */
  readonly mode: "GOVERNANCE" | "COMPLIANCE" | null;
  readonly defaultRetentionDays: number | null;
  readonly defaultRetentionYears: number | null;
  /**
   * `filesystem`: a mounted filesystem cannot enforce immutability;
   * `provider`: the S3 service does not implement Object Lock;
   * `access_denied` / `error`: the capability could not be determined.
   */
  readonly reason: "filesystem" | "provider" | "access_denied" | "error" | null;
  readonly detail: string | null;
  readonly checkedAt: string;
}

/** The minimal S3 client surface the detection needs (an S3Client, or a fake in tests). */
export interface S3CommandSender {
  send(
    command: GetObjectLockConfigurationCommand,
  ): Promise<GetObjectLockConfigurationCommandOutput>;
}

function capability(
  status: ObjectLockStatus,
  at: Date,
  extra: Partial<Omit<ObjectLockCapability, "status" | "checkedAt">> = {},
): ObjectLockCapability {
  return {
    status,
    mode: extra.mode ?? null,
    defaultRetentionDays: extra.defaultRetentionDays ?? null,
    defaultRetentionYears: extra.defaultRetentionYears ?? null,
    reason: extra.reason ?? null,
    detail: extra.detail ?? null,
    checkedAt: at.toISOString(),
  };
}

/** A filesystem has no hardware WORM: the honest answer for every local target. */
export function filesystemObjectLock(at: Date): ObjectLockCapability {
  return capability("unsupported", at, { reason: "filesystem" });
}

const NOT_CONFIGURED = new Set([
  "ObjectLockConfigurationNotFoundError",
  "NoSuchObjectLockConfiguration",
]);
const NOT_IMPLEMENTED = new Set(["NotImplemented", "MethodNotAllowed", "UnsupportedOperation"]);

/**
 * Ask the bucket for its Object Lock configuration. Object Lock can only be
 * enabled when a bucket is created, so the answer is stable; it is recorded
 * with the target and decides whether the archive may call the target WORM.
 */
export async function detectS3ObjectLock(
  client: S3CommandSender,
  bucket: string,
  at: Date = new Date(),
): Promise<ObjectLockCapability> {
  try {
    const output = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }));
    const config = output.ObjectLockConfiguration;
    if (config?.ObjectLockEnabled !== "Enabled") {
      return capability("disabled", at);
    }
    const retention = config.Rule?.DefaultRetention;
    const mode = retention?.Mode;
    return capability("enabled", at, {
      mode: mode === "GOVERNANCE" || mode === "COMPLIANCE" ? mode : null,
      defaultRetentionDays: retention?.Days ?? null,
      defaultRetentionYears: retention?.Years ?? null,
    });
  } catch (error) {
    const shape = (isRecord(error) ? error : {}) as ErrorShape;
    const name = typeof shape.name === "string" ? shape.name : "";
    const status = shape.$metadata?.httpStatusCode;
    if (NOT_CONFIGURED.has(name)) {
      return capability("disabled", at);
    }
    if (NOT_IMPLEMENTED.has(name) || status === 501 || status === 405) {
      return capability("unsupported", at, { reason: "provider" });
    }
    const code = classifyStorageError(error);
    if (code === "access_denied") {
      return capability("unknown", at, {
        reason: "access_denied",
        detail: describeStorageError(error),
      });
    }
    return capability("unknown", at, { reason: "error", detail: describeStorageError(error) });
  }
}
