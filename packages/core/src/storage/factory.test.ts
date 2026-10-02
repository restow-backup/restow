import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectLockConfigurationCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretReader } from "../engine/memory.js";
import { MemoryStorage } from "../verify/testing.js";
import type { StorageBackend } from "./backend.js";
import {
  DEFAULT_S3_REGION,
  type S3CommandSender,
  StorageTargetError,
  classifyStorageError,
  describeStorageLocation,
  detectS3ObjectLock,
  inspectLocalPath,
  installationDefaultStorage,
  installationProbePrefix,
  openStorageLocation,
  openStorageTarget,
  parseS3CredentialsSecret,
  probeStorageBackend,
  resolveStorageTargets,
  s3ClientConfig,
  serializeS3CredentialsSecret,
  storageLocationConfig,
  storageLocationsOverlap,
  storageProbePrefix,
  validateStorageLocation,
} from "./factory.js";
import { LocalStorageBackend } from "./local.js";
import { S3StorageBackend } from "./s3.js";

const TENANT = "5b6c7d8e-1a2b-4c3d-9e8f-0a1b2c3d4e5f";
const AT = new Date("2026-09-01T10:00:00.000Z");

function issuesOf(kind: unknown, config: unknown) {
  const result = validateStorageLocation(kind, config);
  return result.ok ? [] : result.issues;
}

describe("validateStorageLocation: local", () => {
  it("normalizes an absolute path", () => {
    expect(validateStorageLocation("local", { basePath: " /mnt/nas//restow/ " })).toEqual({
      ok: true,
      location: { kind: "local", basePath: "/mnt/nas/restow" },
    });
  });

  it.each([
    [{}, "required"],
    [{ basePath: "" }, "required"],
    [{ basePath: 42 }, "type"],
    [{ basePath: "relative/path" }, "absolute_path"],
    [{ basePath: "/mnt/../etc" }, "path_traversal"],
    [{ basePath: "/mnt/./data" }, "path_traversal"],
    [{ basePath: "/" }, "root_path"],
    [{ basePath: "///" }, "root_path"],
    [{ basePath: "/etc/restow" }, "system_path"],
    [{ basePath: "/proc" }, "system_path"],
    [{ basePath: "/prod/api" }, "system_path"],
    [{ basePath: "/mnt/nas\u0000x" }, "invalid_characters"],
    [{ basePath: "C:\\data" }, "invalid_characters"],
    [{ basePath: `/${"a".repeat(1100)}` }, "too_long"],
  ])("rejects %j (%s)", (config, reason) => {
    expect(issuesOf("local", config)).toEqual([
      expect.objectContaining({ field: expect.any(String), reason }),
    ]);
  });

  it("does not mistake a sibling for a system directory", () => {
    expect(validateStorageLocation("local", { basePath: "/etcetera/restow" }).ok).toBe(true);
    expect(validateStorageLocation("local", { basePath: "/data/chunks" }).ok).toBe(true);
  });
});

describe("validateStorageLocation: s3", () => {
  it("normalizes endpoint, prefix and defaults", () => {
    const result = validateStorageLocation("s3", {
      bucket: "restow-backup",
      prefix: "/customers/acme/",
      endpoint: "https://fsn1.your-objectstorage.com/",
      region: "fsn1",
    });
    expect(result).toEqual({
      ok: true,
      location: {
        kind: "s3",
        bucket: "restow-backup",
        prefix: "customers/acme",
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
        forcePathStyle: true,
      },
    });
  });

  it("defaults to virtual-hosted addressing and us-east-1 for AWS", () => {
    const result = validateStorageLocation("s3", { bucket: "acme-restow" });
    expect(result.ok && result.location).toEqual({
      kind: "s3",
      bucket: "acme-restow",
      prefix: null,
      endpoint: null,
      region: DEFAULT_S3_REGION,
      forcePathStyle: false,
    });
  });

  it("ignores stored health and capability keys", () => {
    const result = validateStorageLocation("s3", {
      bucket: "acme-restow",
      forcePathStyle: false,
      objectLock: true,
      lastProbe: { ok: true },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    [{}, "bucket", "required"],
    [{ bucket: "ab" }, "bucket", "bucket_name"],
    [{ bucket: "Upper-Case" }, "bucket", "bucket_name"],
    [{ bucket: "under_score" }, "bucket", "bucket_name"],
    [{ bucket: "double..dot" }, "bucket", "bucket_name"],
    [{ bucket: "dash-.dot" }, "bucket", "bucket_name"],
    [{ bucket: "192.168.1.10" }, "bucket", "bucket_name"],
    [{ bucket: "-leading" }, "bucket", "bucket_name"],
    [{ bucket: "ok-bucket", prefix: "a/../b" }, "prefix", "prefix"],
    [{ bucket: "ok-bucket", prefix: "a//b" }, "prefix", "prefix"],
    [{ bucket: "ok-bucket", prefix: "spaces are bad" }, "prefix", "prefix"],
    [{ bucket: "ok-bucket", endpoint: "not a url" }, "endpoint", "endpoint_url"],
    [{ bucket: "ok-bucket", endpoint: "ftp://host" }, "endpoint", "endpoint_protocol"],
    [
      { bucket: "ok-bucket", endpoint: "https://key:secret@host" },
      "endpoint",
      "endpoint_credentials",
    ],
    [{ bucket: "ok-bucket", endpoint: "https://host/bucket" }, "endpoint", "endpoint_path"],
    [{ bucket: "ok-bucket", endpoint: "https://host/?x=1" }, "endpoint", "endpoint_path"],
    [{ bucket: "ok-bucket", region: "eu central" }, "region", "region"],
    [{ bucket: "ok-bucket", forcePathStyle: "yes" }, "forcePathStyle", "type"],
  ])("rejects %j", (config, field, reason) => {
    expect(issuesOf("s3", config)).toContainEqual({ field, reason });
  });

  it("rejects unknown kinds", () => {
    expect(issuesOf("ftp", {})).toEqual([{ field: "kind", reason: "unknown_kind" }]);
  });
});

describe("locations", () => {
  const local = (basePath: string) => ({ kind: "local" as const, basePath });
  const s3 = (bucket: string, prefix: string | null, endpoint: string | null = null) => ({
    kind: "s3" as const,
    bucket,
    prefix,
    endpoint,
    region: "eu-central-1",
    forcePathStyle: false,
  });

  it("detects nested and identical locations", () => {
    expect(storageLocationsOverlap(local("/data/chunks"), local("/data/chunks"))).toBe(true);
    expect(storageLocationsOverlap(local("/data"), local("/data/chunks"))).toBe(true);
    expect(storageLocationsOverlap(local("/data/chunks"), local("/data/chunks-copy"))).toBe(false);
    expect(storageLocationsOverlap(s3("b", null), s3("b", "x"))).toBe(true);
    expect(storageLocationsOverlap(s3("b", "x"), s3("b", "x/y"))).toBe(true);
    expect(storageLocationsOverlap(s3("b", "x"), s3("b", "xy"))).toBe(false);
    expect(storageLocationsOverlap(s3("b", null), s3("b", null, "https://garage.example"))).toBe(
      false,
    );
    expect(storageLocationsOverlap(local("/b"), s3("b", null))).toBe(false);
  });

  it("describes and serializes without secrets", () => {
    const bucket = s3("acme", "restow", "https://s3.eu-central-1.wasabisys.com");
    expect(describeStorageLocation(bucket)).toBe(
      "s3://acme/restow (s3.eu-central-1.wasabisys.com)",
    );
    expect(describeStorageLocation(s3("acme", null))).toBe("s3://acme (AWS)");
    expect(storageLocationConfig(bucket)).toEqual({
      bucket: "acme",
      prefix: "restow",
      endpoint: "https://s3.eu-central-1.wasabisys.com",
      region: "eu-central-1",
      forcePathStyle: false,
    });
    expect(storageLocationConfig(local("/mnt/nas"))).toEqual({ basePath: "/mnt/nas" });
  });

  it("round-trips a stored config through validation", () => {
    const bucket = s3("acme", "restow", "https://garage.example:3900");
    expect(validateStorageLocation("s3", storageLocationConfig(bucket))).toEqual({
      ok: true,
      location: bucket,
    });
  });
});

describe("S3 credentials secret", () => {
  it("round-trips", () => {
    const credentials = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret" };
    expect(parseS3CredentialsSecret(serializeS3CredentialsSecret(credentials))).toEqual(
      credentials,
    );
  });

  it.each(["not json", "{}", '{"accessKeyId":"a"}', '{"accessKeyId":"","secretAccessKey":"b"}'])(
    "rejects %s",
    (raw) => {
      expect(() => parseS3CredentialsSecret(raw)).toThrow(StorageTargetError);
    },
  );
});

describe("s3ClientConfig", () => {
  const location = {
    kind: "s3" as const,
    bucket: "acme",
    prefix: null,
    endpoint: "https://garage.example",
    region: "garage",
    forcePathStyle: true,
  };

  it("fails fast for probes and stays patient for data", () => {
    const probe = s3ClientConfig(location, undefined, "probe");
    expect(probe.maxAttempts).toBe(1);
    expect(probe.requestHandler).toEqual({ connectionTimeout: 10_000, requestTimeout: 15_000 });
    const data = s3ClientConfig(location, { accessKeyId: "a", secretAccessKey: "b" });
    expect(data.maxAttempts).toBeUndefined();
    expect(data.requestHandler).toEqual({ connectionTimeout: 10_000 });
    expect(data.credentials).toEqual({ accessKeyId: "a", secretAccessKey: "b" });
    expect(data.endpoint).toBe("https://garage.example");
    expect(data.forcePathStyle).toBe(true);
  });
});

describe("opening targets", () => {
  it("builds the backend for each kind", async () => {
    const secrets = new MemorySecretReader({
      "secret-1": serializeS3CredentialsSecret({ accessKeyId: "a", secretAccessKey: "b" }),
    });
    const local = await openStorageTarget(
      { id: "t1", kind: "local", config: { basePath: "/mnt/nas" }, secretRef: null },
      secrets,
    );
    expect(local.backend).toBeInstanceOf(LocalStorageBackend);
    const bucket = await openStorageTarget(
      { id: "t2", kind: "s3", config: { bucket: "acme-restow" }, secretRef: "secret-1" },
      secrets,
    );
    expect(bucket.backend).toBeInstanceOf(S3StorageBackend);
  });

  it("refuses invalid configuration and missing secrets", async () => {
    const secrets = new MemorySecretReader({});
    await expect(
      openStorageTarget(
        { id: "t1", kind: "local", config: { basePath: "/" }, secretRef: null },
        secrets,
      ),
    ).rejects.toMatchObject({ code: "invalid_config" });
    await expect(
      openStorageTarget(
        { id: "t2", kind: "s3", config: { bucket: "acme-restow" }, secretRef: "gone" },
        secrets,
      ),
    ).rejects.toMatchObject({ code: "credentials_missing" });
  });
});

describe("installationDefaultStorage", () => {
  it("defaults to the local volume", () => {
    expect(installationDefaultStorage({})).toEqual({
      primary: { kind: "local", basePath: "/data/chunks" },
      credentials: undefined,
      copy: null,
    });
  });

  it("reads an S3 default and a copy path like the worker", () => {
    const defaults = installationDefaultStorage({
      STORAGE_TARGET: "s3",
      S3_BUCKET: "restow",
      S3_ENDPOINT: "https://nbg1.your-objectstorage.com",
      S3_REGION: "nbg1",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
      STORAGE_COPY_LOCAL_PATH: "/mnt/copy",
    });
    expect(defaults.primary).toEqual({
      kind: "s3",
      bucket: "restow",
      prefix: null,
      endpoint: "https://nbg1.your-objectstorage.com",
      region: "nbg1",
      forcePathStyle: true,
    });
    expect(defaults.credentials).toEqual({ accessKeyId: "id", secretAccessKey: "secret" });
    expect(defaults.copy).toEqual({ kind: "local", basePath: "/mnt/copy" });
  });

  it("refuses an unusable environment", () => {
    expect(() => installationDefaultStorage({ STORAGE_TARGET: "nfs" })).toThrow(StorageTargetError);
    expect(() => installationDefaultStorage({ STORAGE_TARGET: "s3" })).toThrow(/S3_BUCKET/);
  });
});

describe("resolveStorageTargets", () => {
  const secrets = new MemorySecretReader({});
  const defaults = { primary: new MemoryStorage(), copies: [new MemoryStorage()] };

  it("uses the installation default until the tenant has a primary row", async () => {
    const resolved = await resolveStorageTargets(
      [
        {
          id: "c1",
          kind: "local",
          role: "copy",
          config: { basePath: "/mnt/offsite" },
          secretRef: null,
        },
      ],
      { secrets, defaults },
    );
    expect(resolved.usesInstallationDefault).toBe(true);
    expect(resolved.primary).toBe(defaults.primary);
    expect(resolved.copies).toHaveLength(2);
    expect(resolved.copies[0]).toBe(defaults.copies[0]);
    expect(resolved.copies[1]).toBeInstanceOf(LocalStorageBackend);
  });

  it("lets the tenant's rows win once a primary exists", async () => {
    const resolved = await resolveStorageTargets(
      [
        {
          id: "p1",
          kind: "local",
          role: "primary",
          config: { basePath: "/mnt/primary" },
          secretRef: null,
        },
        {
          id: "c1",
          kind: "local",
          role: "copy",
          config: { basePath: "/mnt/offsite" },
          secretRef: null,
        },
      ],
      { secrets, defaults: () => defaults },
    );
    expect(resolved.usesInstallationDefault).toBe(false);
    expect(resolved.primary).toBeInstanceOf(LocalStorageBackend);
    expect(resolved.copies).toHaveLength(1);
    expect(resolved.previous).toHaveLength(0);
  });

  it("opens a retired primary target as a read-only previous backend, never a copy", async () => {
    const resolved = await resolveStorageTargets(
      [
        {
          id: "p1",
          kind: "local",
          role: "primary",
          config: { basePath: "/mnt/new-primary" },
          secretRef: null,
        },
        {
          id: "old1",
          kind: "local",
          role: "previous",
          config: { basePath: "/mnt/old-primary" },
          secretRef: null,
        },
      ],
      { secrets, defaults },
    );
    expect(resolved.previous).toHaveLength(1);
    expect(resolved.previous[0]).toBeInstanceOf(LocalStorageBackend);
    expect(resolved.copies).toHaveLength(0);
  });

  it("opens a retired installation-default previous row against the environment default", async () => {
    const resolved = await resolveStorageTargets(
      [
        {
          id: "p1",
          kind: "local",
          role: "primary",
          config: { basePath: "/mnt/new-primary" },
          secretRef: null,
        },
        {
          id: "old-default",
          kind: "installation_default",
          role: "previous",
          config: {},
          secretRef: null,
        },
      ],
      { secrets, defaults },
    );
    expect(resolved.previous).toEqual([defaults.primary]);
  });

  it("never invokes the environment default when neither needed", async () => {
    let calls = 0;
    const resolved = await resolveStorageTargets(
      [
        {
          id: "p1",
          kind: "local",
          role: "primary",
          config: { basePath: "/mnt/primary" },
          secretRef: null,
        },
      ],
      {
        secrets,
        defaults: () => {
          calls++;
          return defaults;
        },
      },
    );
    expect(resolved.previous).toHaveLength(0);
    expect(calls).toBe(0);
  });
});

describe("classifyStorageError", () => {
  const err = (props: Record<string, unknown>) => Object.assign(new Error("x"), props);

  it.each([
    [err({ code: "ENOENT" }), "path_missing"],
    [err({ code: "EACCES" }), "not_writable"],
    [err({ code: "EROFS" }), "not_writable"],
    [err({ code: "ENOSPC" }), "no_space"],
    [err({ name: "AccessDenied" }), "access_denied"],
    [err({ name: "InvalidAccessKeyId" }), "invalid_credentials"],
    [err({ name: "SignatureDoesNotMatch" }), "invalid_credentials"],
    [err({ name: "NoSuchBucket" }), "bucket_missing"],
    [err({ name: "PermanentRedirect" }), "wrong_region"],
    [err({ name: "Unknown", $metadata: { httpStatusCode: 403 } }), "access_denied"],
    [err({ name: "Unknown", $metadata: { httpStatusCode: 301 } }), "wrong_region"],
    [err({ cause: { code: "ECONNREFUSED" } }), "unreachable"],
    [err({ cause: { code: "ENOTFOUND" } }), "unreachable"],
    [err({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "tls"],
    [err({ name: "TimeoutError" }), "timeout"],
    [new Error("something else"), "unknown"],
    ["a string", "unknown"],
  ])("%o -> %s", (error, code) => {
    expect(classifyStorageError(error)).toBe(code);
  });
});

describe("inspectLocalPath", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "restow-storage-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const outside = { inContainer: false, rootDevice: -1 };

  it("accepts a writable directory", async () => {
    expect(await inspectLocalPath(dir, { host: outside })).toEqual({
      ok: true,
      errorCode: null,
      error: null,
      ephemeral: false,
    });
  });

  it("refuses a missing directory unless allowed", async () => {
    const missing = join(dir, "not-mounted");
    expect(await inspectLocalPath(missing, { host: outside })).toMatchObject({
      ok: false,
      errorCode: "path_missing",
    });
    expect(
      await inspectLocalPath(missing, { host: outside, requireExisting: false }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a file", async () => {
    const file = join(dir, "file");
    await writeFile(file, "x");
    expect(await inspectLocalPath(file, { host: outside })).toMatchObject({
      ok: false,
      errorCode: "not_a_directory",
    });
  });

  it("flags a directory on the container's root filesystem", async () => {
    const device = (await stat(dir)).dev;
    const result = await inspectLocalPath(dir, { host: { inContainer: true, rootDevice: device } });
    expect(result).toMatchObject({ ok: true, ephemeral: true });
  });
});

describe("probeStorageBackend", () => {
  const prefix = storageProbePrefix(TENANT);

  it("writes, reads, lists and deletes, leaving nothing behind", async () => {
    const store = new MemoryStorage();
    const result = await probeStorageBackend(store, { keyPrefix: prefix, now: () => AT });
    expect(result.ok).toBe(true);
    expect(result.checkedAt).toBe(AT.toISOString());
    expect(result.steps.map((step) => step.step)).toEqual(["write", "read", "list", "delete"]);
    expect(result.failedStep).toBeNull();
    expect(store.files.size).toBe(0);
    expect(prefix).toBe(`tenants/${TENANT}/probes/`);
  });

  it("keeps the installation's own probe area apart from every tenant's", () => {
    expect(installationProbePrefix()).toBe("installation/probes/");
    expect(installationProbePrefix().startsWith("tenants/")).toBe(false);
  });

  it("stops at a failing write with a classified error", async () => {
    const store = new MemoryStorage();
    store.put = async () => {
      throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
    };
    const result = await probeStorageBackend(store, { keyPrefix: prefix });
    expect(result).toMatchObject({
      ok: false,
      failedStep: "write",
      errorCode: "access_denied",
      error: "Access Denied",
    });
    expect(result.steps).toHaveLength(1);
  });

  it("detects bytes that do not read back and cleans up", async () => {
    const store = new MemoryStorage();
    const original = store.get.bind(store);
    store.get = async (key) => {
      const bytes = await original(key);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      return bytes;
    };
    const result = await probeStorageBackend(store, { keyPrefix: prefix });
    expect(result).toMatchObject({ ok: false, failedStep: "read", errorCode: "integrity" });
    expect(store.files.size).toBe(0);
  });

  it("times out a hanging step", async () => {
    const store = new MemoryStorage();
    store.put = () => new Promise<void>(() => {});
    const result = await probeStorageBackend(store, { keyPrefix: prefix, stepTimeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, failedStep: "write", errorCode: "timeout" });
  });

  it("reports a failed cleanup as a warning", async () => {
    const store = new MemoryStorage();
    const failingList: StorageBackend["list"] = async () => [];
    store.list = failingList;
    store.delete = async () => {
      throw new Error("delete refused");
    };
    const result = await probeStorageBackend(store, { keyPrefix: prefix });
    expect(result).toMatchObject({ ok: false, failedStep: "list", warnings: ["cleanup_failed"] });
  });

  it("probes a real local directory including the location step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-storage-"));
    try {
      await mkdir(join(dir, "chunks"));
      const target = openStorageLocation(
        { kind: "local", basePath: join(dir, "chunks") },
        { host: { inContainer: false, rootDevice: -1 } },
      );
      const result = await target.probe({ keyPrefix: prefix });
      expect(result.ok).toBe(true);
      expect(result.steps.map((step) => step.step)).toEqual([
        "location",
        "write",
        "read",
        "list",
        "delete",
      ]);
      const missing = openStorageLocation(
        { kind: "local", basePath: join(dir, "missing") },
        { host: { inContainer: false, rootDevice: -1 } },
      );
      expect(await missing.probe({ keyPrefix: prefix })).toMatchObject({
        ok: false,
        failedStep: "location",
        errorCode: "path_missing",
      });
      expect((await missing.detectObjectLock(() => AT)).status).toBe("unsupported");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detectS3ObjectLock", () => {
  function sender(outcome: () => Promise<unknown>): S3CommandSender & { commands: unknown[] } {
    const commands: unknown[] = [];
    return {
      commands,
      send: async (command) => {
        commands.push(command);
        return (await outcome()) as never;
      },
    };
  }
  const fail = (props: Record<string, unknown>) => () =>
    Promise.reject(Object.assign(new Error("s3 error"), props));

  it("reads an enabled configuration with its default retention", async () => {
    const client = sender(async () => ({
      ObjectLockConfiguration: {
        ObjectLockEnabled: "Enabled",
        Rule: { DefaultRetention: { Mode: "COMPLIANCE", Years: 10 } },
      },
    }));
    const result = await detectS3ObjectLock(client, "archive", AT);
    expect(result).toEqual({
      status: "enabled",
      mode: "COMPLIANCE",
      defaultRetentionDays: null,
      defaultRetentionYears: 10,
      reason: null,
      detail: null,
      checkedAt: AT.toISOString(),
    });
    expect(client.commands[0]).toBeInstanceOf(GetObjectLockConfigurationCommand);
  });

  it("reports enabled without a default rule", async () => {
    const client = sender(async () => ({
      ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" },
    }));
    expect(await detectS3ObjectLock(client, "archive", AT)).toMatchObject({
      status: "enabled",
      mode: null,
    });
  });

  it.each([
    [fail({ name: "ObjectLockConfigurationNotFoundError" }), "disabled", null],
    [fail({ name: "NotImplemented" }), "unsupported", "provider"],
    [fail({ name: "Unknown", $metadata: { httpStatusCode: 501 } }), "unsupported", "provider"],
    [fail({ name: "AccessDenied" }), "unknown", "access_denied"],
    [fail({ name: "InternalError" }), "unknown", "error"],
  ])("maps failures (%#)", async (outcome, status, reason) => {
    expect(await detectS3ObjectLock(sender(outcome), "archive", AT)).toMatchObject({
      status,
      reason,
    });
  });
});
