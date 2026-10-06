import type { FieldError } from "react-hook-form";
import { z } from "zod";

import type {
  AssignableRole,
  CreateTargetInput,
  EditableKind,
  MigrationMode,
  ProbeInput,
  S3ConfigInput,
  StorageTargetDto,
  UpdateTargetInput,
} from "./types";

/**
 * Form model and validation of the add/edit target dialog. Issue messages are
 * short reasons in the API's vocabulary (`bucket_name`, `absolute_path`, ...):
 * `required` maps to `common:validation.required`, everything else to
 * `storage:validation.*`, so a reason the server reports and one the form
 * finds read the same. The server re-checks everything.
 */

export const S3_PRESETS = ["hetzner", "aws", "wasabi", "backblaze", "garage", "other"] as const;
export type S3Preset = (typeof S3_PRESETS)[number];

/** Connection defaults per provider; every field stays editable. */
export const PRESET_DEFAULTS: Record<
  S3Preset,
  { endpoint: string; region: string; forcePathStyle: boolean }
> = {
  hetzner: {
    endpoint: "https://fsn1.your-objectstorage.com",
    region: "fsn1",
    forcePathStyle: false,
  },
  aws: { endpoint: "", region: "eu-central-1", forcePathStyle: false },
  wasabi: {
    endpoint: "https://s3.eu-central-1.wasabisys.com",
    region: "eu-central-1",
    forcePathStyle: false,
  },
  backblaze: {
    endpoint: "https://s3.eu-central-003.backblazeb2.com",
    region: "eu-central-003",
    forcePathStyle: false,
  },
  garage: { endpoint: "", region: "garage", forcePathStyle: true },
  other: { endpoint: "", region: "", forcePathStyle: true },
};

/** Hetzner Object Storage locations: each has its own endpoint and region. */
export const HETZNER_LOCATIONS = ["fsn1", "nbg1", "hel1"] as const;
export type HetznerLocation = (typeof HETZNER_LOCATIONS)[number];

export function hetznerEndpoint(location: HetznerLocation): string {
  return `https://${location}.your-objectstorage.com`;
}

/** The Hetzner location an endpoint belongs to, or null for any other host. */
export function hetznerLocationForEndpoint(endpoint: string | null): HetznerLocation | null {
  try {
    const host = new URL(endpoint ?? "").hostname;
    return HETZNER_LOCATIONS.find((l) => host === `${l}.your-objectstorage.com`) ?? null;
  } catch {
    return null;
  }
}

const PRESET_HOSTS: readonly [S3Preset, string][] = [
  ["hetzner", "your-objectstorage.com"],
  ["wasabi", "wasabisys.com"],
  ["backblaze", "backblazeb2.com"],
];

/** The preset a stored endpoint belongs to (AWS has none). */
export function presetForEndpoint(endpoint: string | null): S3Preset {
  if (!endpoint) {
    return "aws";
  }
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return "other";
  }
  return PRESET_HOSTS.find(([, suffix]) => host.endsWith(suffix))?.[0] ?? "other";
}

/**
 * What the form needs to know about a stored location: its S3 settings, for
 * keeping the saved key pair (a target, or the installation default saved
 * under Installation, Default storage).
 */
export type StoredLocation = Pick<StorageTargetDto, "s3">;

export interface TargetFormValues {
  name: string;
  role: AssignableRole;
  /** How a new primary takes over when it replaces one that already holds data. */
  migrationMode: MigrationMode;
  basePath: string;
  preset: S3Preset;
  bucket: string;
  prefix: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

export function emptyTargetForm(role: AssignableRole): TargetFormValues {
  return {
    name: "",
    role,
    migrationMode: "move",
    basePath: "",
    preset: "hetzner",
    bucket: "",
    prefix: "",
    ...PRESET_DEFAULTS.hetzner,
    accessKeyId: "",
    secretAccessKey: "",
  };
}

export function targetFormFromDto(target: StorageTargetDto): TargetFormValues {
  const s3 = target.s3;
  return {
    name: target.name,
    // Editing never offers "replace the primary": a stored target already
    // has its role (the dialog does not render RoleField once `target` is set).
    role: target.role === "copy" ? "copy" : "primary",
    migrationMode: "move",
    basePath: target.local?.basePath ?? "",
    preset: presetForEndpoint(s3?.endpoint ?? null),
    bucket: s3?.bucket ?? "",
    prefix: s3?.prefix ?? "",
    endpoint: s3?.endpoint ?? "",
    region: s3?.region ?? "",
    forcePathStyle: s3?.forcePathStyle ?? false,
    accessKeyId: "",
    secretAccessKey: "",
  };
}

const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

export function isValidBucket(value: string): boolean {
  const bucket = value.trim();
  return (
    BUCKET_NAME.test(bucket) &&
    !bucket.includes("..") &&
    !bucket.includes(".-") &&
    !bucket.includes("-.") &&
    !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  );
}

/** Null when the endpoint is empty or usable, else the reason. */
export function endpointProblem(value: string): string | null {
  const endpoint = value.trim();
  if (endpoint.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "endpoint_url";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "endpoint_protocol";
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    return "endpoint_path";
  }
  return null;
}

/** Normalize an endpoint for comparison with the stored one (the API stores the origin). */
function endpointOrigin(value: string): string | null {
  const endpoint = value.trim();
  if (endpoint.length === 0) {
    return null;
  }
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

/**
 * Stored credentials are only sent to the endpoint they were saved for (the
 * API enforces the same rule): a new endpoint needs the key pair again.
 */
export function needsCredentialsAgain(
  values: Pick<TargetFormValues, "endpoint">,
  stored: StoredLocation | null,
): boolean {
  if (!stored?.s3?.hasCredentials) {
    return true;
  }
  return endpointOrigin(values.endpoint) !== stored.s3.endpoint;
}

/**
 * `create` requires everything; `edit` keeps the stored key pair unless both
 * fields are filled (or the endpoint changes, which needs the pair again).
 */
export function targetFormSchema(kind: EditableKind, stored: StoredLocation | null) {
  return z
    .object({
      name: z.string().trim().min(1, "required").max(200, "too_long"),
      role: z.enum(["primary", "copy"]),
      migrationMode: z.enum(["move", "keep"]),
      basePath: z.string(),
      preset: z.enum(S3_PRESETS),
      bucket: z.string(),
      prefix: z.string(),
      endpoint: z.string(),
      region: z.string(),
      forcePathStyle: z.boolean(),
      accessKeyId: z.string(),
      secretAccessKey: z.string(),
    })
    .superRefine((values, ctx) => {
      const issue = (path: keyof TargetFormValues, message: string) =>
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

      if (kind === "local") {
        const basePath = values.basePath.trim();
        if (basePath.length === 0) {
          issue("basePath", "required");
        } else if (!basePath.startsWith("/")) {
          issue("basePath", "absolute_path");
        }
        return;
      }

      if (values.bucket.trim().length === 0) {
        issue("bucket", "required");
      } else if (!isValidBucket(values.bucket)) {
        issue("bucket", "bucket_name");
      }
      const endpoint = endpointProblem(values.endpoint);
      if (endpoint) {
        issue("endpoint", endpoint);
      }
      const region = values.region.trim();
      if (region.length > 0 && !REGION.test(region)) {
        issue("region", "region");
      }

      const accessKeyId = values.accessKeyId.trim();
      const secret = values.secretAccessKey;
      const keepStored = !needsCredentialsAgain(values, stored);
      if (accessKeyId.length === 0 && secret.length === 0 && keepStored) {
        return;
      }
      // Why the pair is needed: half a pair was typed, the endpoint changed, or it is new.
      const reason = !stored?.s3?.hasCredentials
        ? "required"
        : keepStored
          ? "credentials_pair"
          : "credentials_again";
      if (accessKeyId.length === 0) {
        issue("accessKeyId", reason);
      }
      if (secret.length === 0) {
        issue("secretAccessKey", reason);
      }
      if (/\s/.test(accessKeyId) || /\s/.test(secret)) {
        issue(/\s/.test(secret) ? "secretAccessKey" : "accessKeyId", "whitespace");
      }
    });
}

function optional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function s3Config(values: TargetFormValues): S3ConfigInput {
  return {
    bucket: values.bucket.trim(),
    prefix: optional(values.prefix),
    endpoint: optional(values.endpoint),
    region: optional(values.region),
    forcePathStyle: values.forcePathStyle,
  };
}

function credentials(values: TargetFormValues) {
  const accessKeyId = values.accessKeyId.trim();
  return accessKeyId.length > 0 && values.secretAccessKey.length > 0
    ? { accessKeyId, secretAccessKey: values.secretAccessKey }
    : undefined;
}

/**
 * The create payload from validated form values. `migrationMode` rides along
 * whenever the role is "primary"; the API only acts on it when the tenant
 * actually has something to replace (docs/STORAGE.md) and otherwise creates
 * the target directly, exactly as it always has for a fresh tenant.
 */
export function toCreateTargetInput(
  kind: EditableKind,
  values: TargetFormValues,
): CreateTargetInput {
  const base = {
    name: values.name.trim(),
    role: values.role,
    ...(values.role === "primary" ? { migrationMode: values.migrationMode } : {}),
  };
  if (kind === "local") {
    return { kind, ...base, config: { basePath: values.basePath.trim() } };
  }
  const pair = credentials(values);
  if (!pair) {
    // The schema requires both fields when creating; reaching this is a programming error.
    throw new Error("an S3 target needs an access key pair");
  }
  return { kind, ...base, config: s3Config(values), credentials: pair };
}

function sameS3Config(a: S3ConfigInput, target: StorageTargetDto): boolean {
  const s3 = target.s3;
  if (!s3) {
    return false;
  }
  return (
    a.bucket === s3.bucket &&
    (a.prefix ?? null) === s3.prefix &&
    endpointOrigin(a.endpoint ?? "") === s3.endpoint &&
    (a.region ?? "us-east-1") === s3.region &&
    a.forcePathStyle === s3.forcePathStyle
  );
}

/** Only what differs from the stored target; empty credentials keep the stored pair. */
export function toUpdateTargetInput(
  kind: EditableKind,
  values: TargetFormValues,
  target: StorageTargetDto,
): UpdateTargetInput {
  const patch: UpdateTargetInput = {};
  const name = values.name.trim();
  if (name !== target.name) {
    patch.name = name;
  }
  if (kind === "local") {
    const basePath = values.basePath.trim();
    if (!target.configValid || basePath !== target.local?.basePath) {
      patch.config = { basePath };
    }
    return patch;
  }
  const config = s3Config(values);
  if (!target.configValid || !sameS3Config(config, target)) {
    patch.config = config;
  }
  const pair = credentials(values);
  if (pair) {
    patch.credentials = pair;
  }
  return patch;
}

/**
 * The inline test payload: typed credentials, or (editing, same endpoint) the
 * stored ones by target id. Null when the key pair is needed first.
 */
export function toProbeInput(
  kind: EditableKind,
  values: TargetFormValues,
  stored: StorageTargetDto | null,
): ProbeInput | null {
  if (kind === "local") {
    return { kind, config: { basePath: values.basePath.trim() } };
  }
  const pair = credentials(values);
  if (pair) {
    return { kind, config: s3Config(values), credentials: pair };
  }
  if (stored && !needsCredentialsAgain(values, stored)) {
    return { kind, config: s3Config(values), targetId: stored.id };
  }
  return null;
}

/** A location as the installation default storage takes it: without name, role or target. */
export type LocationInput =
  | { kind: "local"; config: { basePath: string } }
  | {
      kind: "s3";
      config: S3ConfigInput;
      credentials?: { accessKeyId: string; secretAccessKey: string };
    };

/** The location from validated form values; empty credentials keep the stored pair. */
export function toLocationInput(kind: EditableKind, values: TargetFormValues): LocationInput {
  if (kind === "local") {
    return { kind, config: { basePath: values.basePath.trim() } };
  }
  const pair = credentials(values);
  return { kind, config: s3Config(values), ...(pair ? { credentials: pair } : {}) };
}

/** Form field of an API problem field (`credentials` belongs to the key pair). */
export function formFieldOf(field: string): keyof TargetFormValues | null {
  switch (field) {
    case "basePath":
    case "bucket":
    case "prefix":
    case "endpoint":
    case "region":
    case "forcePathStyle":
    case "name":
      return field;
    case "credentials":
      return "accessKeyId";
    default:
      return null;
  }
}

/** The i18n key for a field error (`common:validation.required` or `storage:validation.*`). */
export function fieldMessageKey(error: FieldError | undefined): string | undefined {
  if (!error) {
    return undefined;
  }
  const reason = typeof error.message === "string" && error.message.length > 0 ? error.message : "";
  if (reason === "required" || reason === "") {
    return "common:validation.required";
  }
  return `storage:validation.${reason}`;
}
