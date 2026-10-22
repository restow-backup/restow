import { describe, expect, it } from "vitest";
import type { LicenseReader } from "./store.js";
import { currentEdition, effectiveLicenseOf, installationHasCapability } from "./store.js";

/** A reader whose `select()...limit()` chain resolves to `rows`. */
function fakeDb(rows: Array<{ edition: string }>): LicenseReader {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as LicenseReader;
}

describe("effectiveLicenseOf", () => {
  it("lets an installed key win", () => {
    expect(effectiveLicenseOf({ edition: "business" }, {})).toEqual({
      edition: "business",
      source: "key",
    });
  });

  it("is Community without a key outside demo mode", () => {
    expect(effectiveLicenseOf(null, { RESTOW_EDITION: "service_provider" })).toEqual({
      edition: "community",
      source: "environment",
    });
  });

  it("honours the demo's RESTOW_EDITION without a key", () => {
    expect(
      effectiveLicenseOf(null, { RESTOW_DEMO: "true", RESTOW_EDITION: "service_provider" }),
    ).toEqual({ edition: "service_provider", source: "environment" });
  });
});

describe("effectiveLicenseOf: RESTOW_RUN_AS_COMMUNITY", () => {
  const expired = { edition: "business" as const, series: "1", updatesUntil: "2027-11-30" };
  const release2028 = { RESTOW_VERSION: "1.8.0", RESTOW_RELEASED_AT: "2028-03-01T09:00:00Z" };

  it("runs a release the key does not cover as Community when the operator asked for it", () => {
    expect(effectiveLicenseOf(expired, { ...release2028, RESTOW_RUN_AS_COMMUNITY: "1" })).toEqual({
      edition: "community",
      source: "environment",
      runAsCommunity: true,
    });
  });

  it("has no effect while the key covers the running release", () => {
    const covered = { RESTOW_VERSION: "1.6.0", RESTOW_RELEASED_AT: "2027-11-01T00:00:00Z" };
    expect(effectiveLicenseOf(expired, { ...covered, RESTOW_RUN_AS_COMMUNITY: "1" })).toEqual({
      edition: "business",
      source: "key",
    });
    // A beta licence (a row of before 0.4.5) covers every 1.x release.
    expect(
      effectiveLicenseOf({ edition: "business" }, { ...release2028, RESTOW_RUN_AS_COMMUNITY: "1" }),
    ).toEqual({ edition: "business", source: "key" });
  });

  it("never changes anything at runtime without the variable", () => {
    expect(effectiveLicenseOf(expired, release2028)).toEqual({
      edition: "business",
      source: "key",
    });
  });
});

describe("currentEdition / installationHasCapability", () => {
  it("reads the active row", async () => {
    expect(await currentEdition(fakeDb([{ edition: "service_provider" }]), {})).toBe(
      "service_provider",
    );
    expect(
      await installationHasCapability(fakeDb([{ edition: "business" }]), "archive.legalHold", {}),
    ).toBe(true);
    expect(
      await installationHasCapability(
        fakeDb([{ edition: "business" }]),
        "provider.crossTenantApi",
        {},
      ),
    ).toBe(false);
  });

  it("falls back to Community without a row", async () => {
    expect(await currentEdition(fakeDb([]), {})).toBe("community");
    expect(await installationHasCapability(fakeDb([]), "audit.log", {})).toBe(false);
  });
});
