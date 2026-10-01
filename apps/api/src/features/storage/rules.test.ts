import type { S3StorageLocation, StorageLocation } from "@restow/core";
import { describe, expect, it } from "vitest";
import {
  type StorageSituation,
  credentialsBoundElsewhere,
  decideCreate,
  decideDelete,
  decidePromote,
  decideReplacePrimary,
  decideUpdate,
  movesLocation,
} from "./rules.js";

const volume: StorageLocation = { kind: "local", basePath: "/data/chunks" };
const nas: StorageLocation = { kind: "local", basePath: "/mnt/nas/restow" };
const bucket = (name: string, prefix: string | null = null): S3StorageLocation => ({
  kind: "s3",
  bucket: name,
  prefix,
  endpoint: "https://fsn1.your-objectstorage.com",
  region: "fsn1",
  forcePathStyle: false,
});

function situation(overrides: Partial<StorageSituation> = {}): StorageSituation {
  return {
    isProviderAdmin: false,
    tenantHasData: false,
    hasPrimaryTarget: false,
    locationsInUse: [volume],
    ...overrides,
  };
}

describe("decideCreate", () => {
  it("lets a fresh tenant start on its own primary bucket", () => {
    expect(decideCreate(situation(), { role: "primary", location: bucket("acme") })).toBeNull();
  });

  it("lets a tenant on the installation default add an offsite copy", () => {
    expect(
      decideCreate(situation({ tenantHasData: true }), { role: "copy", location: bucket("acme") }),
    ).toBeNull();
  });

  it("refuses a primary once data exists or a primary is configured", () => {
    expect(
      decideCreate(situation({ tenantHasData: true }), {
        role: "primary",
        location: bucket("acme"),
      }),
    ).toBe("tenant_has_data");
    expect(
      decideCreate(situation({ hasPrimaryTarget: true }), {
        role: "primary",
        location: bucket("acme"),
      }),
    ).toBe("primary_exists");
  });

  it("refuses a location that overlaps one in use", () => {
    expect(
      decideCreate(situation({ isProviderAdmin: true }), {
        role: "copy",
        location: { kind: "local", basePath: "/data/chunks/copy" },
      }),
    ).toBe("location_overlap");
    expect(
      decideCreate(situation({ locationsInUse: [bucket("acme", "restow")] }), {
        role: "copy",
        location: bucket("acme"),
      }),
    ).toBe("location_overlap");
  });

  it("keeps server paths with the provider admin", () => {
    expect(decideCreate(situation(), { role: "copy", location: nas })).toBe(
      "local_requires_provider_admin",
    );
    expect(
      decideCreate(situation({ isProviderAdmin: true }), { role: "copy", location: nas }),
    ).toBeNull();
  });
});

describe("decideReplacePrimary", () => {
  it("allows a destination location that is free, with no migration already running", () => {
    expect(
      decideReplacePrimary(situation({ locationsInUse: [volume] }), {
        location: bucket("acme"),
        migrationInProgress: false,
      }),
    ).toBeNull();
  });

  it("never blocks on primary_exists or tenant_has_data (that is the point of this path)", () => {
    expect(
      decideReplacePrimary(
        { isProviderAdmin: false, locationsInUse: [] },
        { location: bucket("acme"), migrationInProgress: false },
      ),
    ).toBeNull();
  });

  it("refuses a second migration while one is already running", () => {
    expect(
      decideReplacePrimary(situation(), {
        location: bucket("acme"),
        migrationInProgress: true,
      }),
    ).toBe("migration_in_progress");
  });

  it("refuses a location that overlaps one already in use", () => {
    expect(
      decideReplacePrimary(situation({ locationsInUse: [bucket("acme", "restow")] }), {
        location: bucket("acme"),
        migrationInProgress: false,
      }),
    ).toBe("location_overlap");
  });

  it("keeps server paths with the provider admin", () => {
    expect(decideReplacePrimary(situation(), { location: nas, migrationInProgress: false })).toBe(
      "local_requires_provider_admin",
    );
    expect(
      decideReplacePrimary(situation({ isProviderAdmin: true }), {
        location: nas,
        migrationInProgress: false,
      }),
    ).toBeNull();
  });
});

describe("decideUpdate", () => {
  const primaryWithData = situation({
    tenantHasData: true,
    hasPrimaryTarget: true,
    locationsInUse: [],
  });

  it("fixes the location of a primary that holds data", () => {
    expect(
      decideUpdate(primaryWithData, {
        role: "primary",
        current: bucket("acme"),
        next: bucket("other"),
      }),
    ).toBe("location_locked");
  });

  it("allows correcting region or addressing style of that primary", () => {
    const current = bucket("acme");
    const next: StorageLocation = { ...bucket("acme"), region: "nbg1", forcePathStyle: true };
    expect(decideUpdate(primaryWithData, { role: "primary", current, next })).toBeNull();
    expect(decideUpdate(primaryWithData, { role: "primary", current, next: null })).toBeNull();
  });

  it("allows moving a copy, but not onto a location in use", () => {
    expect(
      decideUpdate(primaryWithData, { role: "copy", current: bucket("a"), next: bucket("b") }),
    ).toBeNull();
    expect(
      decideUpdate(situation({ locationsInUse: [bucket("b")] }), {
        role: "copy",
        current: bucket("a"),
        next: bucket("b", "x"),
      }),
    ).toBe("location_overlap");
  });

  it("refuses a location change while a migration is unfinished, primary or copy", () => {
    expect(
      decideUpdate(situation(), {
        role: "copy",
        current: bucket("a"),
        next: bucket("b"),
        migrationInProgress: true,
      }),
    ).toBe("migration_in_progress");
    expect(
      decideUpdate(situation(), {
        role: "primary",
        current: bucket("a"),
        next: bucket("b"),
        migrationInProgress: true,
      }),
    ).toBe("migration_in_progress");
  });

  it("still allows a name-only edit (no location change) while a migration is unfinished", () => {
    const current = bucket("acme");
    expect(
      decideUpdate(situation(), {
        role: "copy",
        current,
        next: null,
        migrationInProgress: true,
      }),
    ).toBeNull();
  });
});

describe("decideDelete", () => {
  it("keeps a primary that holds data", () => {
    expect(decideDelete(situation({ tenantHasData: true }), { role: "primary", kind: "s3" })).toBe(
      "primary_holds_data",
    );
    expect(decideDelete(situation(), { role: "primary", kind: "s3" })).toBeNull();
    expect(
      decideDelete(situation({ tenantHasData: true }), { role: "copy", kind: "s3" }),
    ).toBeNull();
  });

  it("keeps server paths with the provider admin", () => {
    expect(decideDelete(situation(), { role: "copy", kind: "local" })).toBe(
      "local_requires_provider_admin",
    );
  });
});

describe("decidePromote", () => {
  it("needs a verified copy", () => {
    expect(
      decidePromote({ isProviderAdmin: false }, { role: "copy", kind: "s3", status: "ok" }),
    ).toBeNull();
    expect(
      decidePromote({ isProviderAdmin: false }, { role: "copy", kind: "s3", status: "unverified" }),
    ).toBe("not_verified");
    expect(
      decidePromote({ isProviderAdmin: false }, { role: "copy", kind: "s3", status: "error" }),
    ).toBe("not_verified");
    expect(
      decidePromote({ isProviderAdmin: false }, { role: "primary", kind: "s3", status: "ok" }),
    ).toBe("already_primary");
    expect(
      decidePromote({ isProviderAdmin: false }, { role: "copy", kind: "local", status: "ok" }),
    ).toBe("local_requires_provider_admin");
  });

  it("refuses to promote another copy while a migration is unfinished", () => {
    expect(
      decidePromote(
        { isProviderAdmin: false },
        { role: "copy", kind: "s3", status: "ok", migrationInProgress: true },
      ),
    ).toBe("migration_in_progress");
  });
});

describe("movesLocation", () => {
  it("treats path, endpoint, bucket and prefix as the location", () => {
    expect(movesLocation(volume, nas)).toBe(true);
    expect(movesLocation(bucket("a"), bucket("a", "p"))).toBe(true);
    expect(
      movesLocation(bucket("a"), { ...bucket("a"), endpoint: "https://nbg1.example.com" }),
    ).toBe(true);
    expect(movesLocation(bucket("a"), { ...bucket("a"), region: "hel1" })).toBe(false);
    expect(movesLocation(volume, bucket("a"))).toBe(true);
  });
});

describe("credentialsBoundElsewhere", () => {
  it("keeps stored credentials with their endpoint", () => {
    expect(credentialsBoundElsewhere(bucket("a"), bucket("b", "p"))).toBe(false);
    expect(credentialsBoundElsewhere(bucket("a"), { ...bucket("a"), region: "hel1" })).toBe(false);
    expect(
      credentialsBoundElsewhere(bucket("a"), { ...bucket("a"), endpoint: "https://evil.example" }),
    ).toBe(true);
    expect(credentialsBoundElsewhere(null, bucket("a"))).toBe(true);
    expect(credentialsBoundElsewhere(bucket("a"), nas)).toBe(false);
  });
});
