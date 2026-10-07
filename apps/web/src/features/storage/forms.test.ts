import { describe, expect, it } from "vitest";

import {
  PRESET_DEFAULTS,
  emptyTargetForm,
  fieldMessageKey,
  formFieldOf,
  hetznerEndpoint,
  hetznerLocationForEndpoint,
  needsCredentialsAgain,
  presetForEndpoint,
  targetFormFromDto,
  targetFormSchema,
  toCreateTargetInput,
  toProbeInput,
  toUpdateTargetInput,
} from "./forms";
import type { StorageTargetDto } from "./types";

const stored: StorageTargetDto = {
  id: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
  name: "Offsite",
  kind: "s3",
  role: "copy",
  location: "s3://acme-restow (fsn1.your-objectstorage.com)",
  local: null,
  s3: {
    bucket: "acme-restow",
    prefix: null,
    endpoint: "https://fsn1.your-objectstorage.com",
    region: "fsn1",
    forcePathStyle: false,
    hasCredentials: true,
    accessKeyIdHint: "WXYZ",
  },
  configValid: true,
  status: "ok",
  errorMessage: null,
  checkedAt: null,
  lastProbe: null,
  objectLock: null,
  canManage: true,
  migration: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

function issues(kind: "s3" | "local", values: object, target: StorageTargetDto | null = null) {
  const result = targetFormSchema(kind, target).safeParse({
    ...emptyTargetForm("copy"),
    ...values,
  });
  return result.success
    ? {}
    : Object.fromEntries(result.error.issues.map((issue) => [issue.path[0], issue.message]));
}

describe("presetForEndpoint", () => {
  it("recognises providers by host", () => {
    expect(presetForEndpoint(null)).toBe("aws");
    expect(presetForEndpoint("https://nbg1.your-objectstorage.com")).toBe("hetzner");
    expect(presetForEndpoint("https://s3.eu-central-2.wasabisys.com")).toBe("wasabi");
    expect(presetForEndpoint("https://s3.eu-central-003.backblazeb2.com")).toBe("backblaze");
    expect(presetForEndpoint("http://garage.lan:3900")).toBe("other");
  });

  it("round-trips every preset endpoint", () => {
    expect(presetForEndpoint(PRESET_DEFAULTS.hetzner.endpoint)).toBe("hetzner");
    expect(presetForEndpoint(PRESET_DEFAULTS.wasabi.endpoint)).toBe("wasabi");
  });
});

describe("targetFormSchema", () => {
  it("requires an absolute path for a local target", () => {
    expect(issues("local", { name: "NAS", basePath: "" })).toEqual({ basePath: "required" });
    expect(issues("local", { name: "NAS", basePath: "mnt/nas" })).toEqual({
      basePath: "absolute_path",
    });
    expect(issues("local", { name: "NAS", basePath: "/mnt/nas" })).toEqual({});
  });

  it("checks bucket, endpoint and region", () => {
    expect(
      issues("s3", {
        name: "Offsite",
        bucket: "Bad_Bucket",
        endpoint: "https://host/bucket",
        region: "eu central",
        accessKeyId: "AKIA1234",
        secretAccessKey: "secret-value",
      }),
    ).toEqual({ bucket: "bucket_name", endpoint: "endpoint_path", region: "region" });
  });

  it("requires credentials when adding", () => {
    expect(issues("s3", { name: "Offsite", bucket: "acme-restow" })).toEqual({
      accessKeyId: "required",
      secretAccessKey: "required",
    });
  });

  it("keeps stored credentials when both fields stay empty", () => {
    expect(issues("s3", targetFormFromDto(stored), stored)).toEqual({});
    expect(issues("s3", { ...targetFormFromDto(stored), accessKeyId: "NEWKEY" }, stored)).toEqual({
      secretAccessKey: "credentials_pair",
    });
  });

  it("asks for the key pair again when the endpoint changes", () => {
    const values = {
      ...targetFormFromDto(stored),
      endpoint: "https://nbg1.your-objectstorage.com",
    };
    expect(issues("s3", values, stored)).toEqual({
      accessKeyId: "credentials_again",
      secretAccessKey: "credentials_again",
    });
  });

  it("refuses pasted whitespace in keys", () => {
    expect(
      issues("s3", {
        name: "Offsite",
        bucket: "acme-restow",
        accessKeyId: "AKIA1234",
        secretAccessKey: "secret value",
      }),
    ).toEqual({ secretAccessKey: "whitespace" });
  });
});

describe("payloads", () => {
  it("builds the create payload", () => {
    const values = {
      ...emptyTargetForm("copy"),
      name: " Offsite ",
      bucket: "acme-restow",
      prefix: " ",
      accessKeyId: " AKIA1234 ",
      secretAccessKey: "secret-value",
    };
    expect(toCreateTargetInput("s3", values)).toEqual({
      kind: "s3",
      name: "Offsite",
      role: "copy",
      config: {
        bucket: "acme-restow",
        prefix: null,
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
        forcePathStyle: false,
      },
      credentials: { accessKeyId: "AKIA1234", secretAccessKey: "secret-value" },
    });
    expect(
      toCreateTargetInput("local", {
        ...emptyTargetForm("primary"),
        name: "NAS",
        basePath: "/mnt/nas ",
      }),
    ).toEqual({
      kind: "local",
      name: "NAS",
      role: "primary",
      migrationMode: "move",
      config: { basePath: "/mnt/nas" },
    });
  });

  it("carries the chosen migration mode along for a primary, never for a copy", () => {
    expect(
      toCreateTargetInput("local", {
        ...emptyTargetForm("primary"),
        migrationMode: "keep",
        name: "NAS",
        basePath: "/mnt/nas",
      }),
    ).toMatchObject({ role: "primary", migrationMode: "keep" });
    expect(
      toCreateTargetInput("local", {
        ...emptyTargetForm("copy"),
        migrationMode: "keep",
        name: "Copy",
        basePath: "/mnt/copy",
      }),
    ).not.toHaveProperty("migrationMode");
  });

  it("sends only what changed", () => {
    const unchanged = targetFormFromDto(stored);
    expect(toUpdateTargetInput("s3", unchanged, stored)).toEqual({});
    expect(toUpdateTargetInput("s3", { ...unchanged, name: "Renamed" }, stored)).toEqual({
      name: "Renamed",
    });
    expect(toUpdateTargetInput("s3", { ...unchanged, region: "nbg1" }, stored)).toEqual({
      config: {
        bucket: "acme-restow",
        prefix: null,
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "nbg1",
        forcePathStyle: false,
      },
    });
    expect(
      toUpdateTargetInput(
        "s3",
        { ...unchanged, accessKeyId: "NEW", secretAccessKey: "new-secret" },
        stored,
      ),
    ).toEqual({ credentials: { accessKeyId: "NEW", secretAccessKey: "new-secret" } });
  });

  it("tests with the stored key only at its own endpoint", () => {
    const values = targetFormFromDto(stored);
    expect(toProbeInput("s3", values, stored)).toMatchObject({ targetId: stored.id });
    expect(toProbeInput("s3", { ...values, endpoint: "https://evil.example" }, stored)).toBeNull();
    expect(
      needsCredentialsAgain({ endpoint: "https://fsn1.your-objectstorage.com/" }, stored),
    ).toBe(false);
    expect(
      toProbeInput("s3", { ...values, accessKeyId: "K", secretAccessKey: "S" }, stored),
    ).toMatchObject({ credentials: { accessKeyId: "K", secretAccessKey: "S" } });
  });
});

describe("messages", () => {
  it("maps reasons to keys", () => {
    expect(fieldMessageKey({ type: "custom", message: "required" })).toBe(
      "common:validation.required",
    );
    expect(fieldMessageKey({ type: "custom", message: "private_address" })).toBe(
      "storage:validation.private_address",
    );
    expect(fieldMessageKey(undefined)).toBeUndefined();
  });

  it("maps API fields to form fields", () => {
    expect(formFieldOf("basePath")).toBe("basePath");
    expect(formFieldOf("credentials")).toBe("accessKeyId");
    expect(formFieldOf("kind")).toBeNull();
  });
});

describe("Hetzner locations", () => {
  it("maps endpoints and locations both ways", () => {
    expect(hetznerEndpoint("nbg1")).toBe("https://nbg1.your-objectstorage.com");
    expect(hetznerLocationForEndpoint("https://hel1.your-objectstorage.com")).toBe("hel1");
    expect(hetznerLocationForEndpoint("https://s3.example.com")).toBeNull();
    expect(hetznerLocationForEndpoint("")).toBeNull();
  });
});
