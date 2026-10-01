import { describe, expect, it } from "vitest";
import { currentEdition, effectiveLicenseOf, installationHasCapability } from "./store.js";
import type { LicenseReader } from "./store.js";

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
