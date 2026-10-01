import { describe, expect, it } from "vitest";

import { editionAllows, isEdition, readEdition, requiredEditionOf } from "./edition";

describe("readEdition", () => {
  it("reads a valid edition from the profile's extension fields", () => {
    expect(readEdition({ edition: "business" })).toBe("business");
    expect(readEdition({ edition: "service_provider", other: 1 })).toBe("service_provider");
    expect(readEdition({ edition: "community" })).toBe("community");
  });

  it("knows nothing while the profile loads or without a valid field", () => {
    expect(readEdition(null)).toBeNull();
    expect(readEdition(undefined)).toBeNull();
    expect(readEdition({})).toBeNull();
    expect(readEdition({ edition: "enterprise" })).toBeNull();
    expect(readEdition({ edition: 3 })).toBeNull();
    expect(isEdition("business")).toBe(true);
    expect(isEdition("Business")).toBe(false);
  });
});

describe("editionAllows", () => {
  it("ranks the editions community < business < service_provider", () => {
    expect(editionAllows("community", "community")).toBe(true);
    expect(editionAllows("community", "business")).toBe(false);
    expect(editionAllows("business", "business")).toBe(true);
    expect(editionAllows("business", "service_provider")).toBe(false);
    expect(editionAllows("service_provider", "business")).toBe(true);
  });

  it("allows nothing while the edition is unknown", () => {
    expect(editionAllows(null, "business")).toBe(false);
    expect(editionAllows(null, "community")).toBe(false);
  });
});

describe("requiredEditionOf", () => {
  it("reads an edition named directly", () => {
    expect(requiredEditionOf("business")).toBe("business");
    expect(requiredEditionOf("service_provider")).toBe("service_provider");
  });

  it("maps each gated core feature to the edition that unlocks it", () => {
    expect(requiredEditionOf("tenants.additional")).toBe("service_provider");
    expect(requiredEditionOf("apiKeys.provider")).toBe("service_provider");
    expect(requiredEditionOf("stats.allTenants")).toBe("service_provider");
    expect(requiredEditionOf("dashboard.allTenants")).toBe("service_provider");
    expect(requiredEditionOf("reports.timed")).toBe("business");
  });

  it("ignores anything else", () => {
    expect(requiredEditionOf("community")).toBeNull();
    expect(requiredEditionOf("toString")).toBeNull();
    expect(requiredEditionOf("")).toBeNull();
    expect(requiredEditionOf(null)).toBeNull();
    expect(requiredEditionOf(undefined)).toBeNull();
  });
});
