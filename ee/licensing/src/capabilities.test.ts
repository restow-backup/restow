import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_MIN_EDITION,
  hasCapability,
  minEditionFor,
} from "./capabilities.js";

describe("hasCapability", () => {
  it("community has no Business or Service Provider capability", () => {
    for (const capability of CAPABILITIES) {
      expect(hasCapability("community", capability)).toBe(false);
    }
  });

  it("business has every Business capability but no Service Provider one", () => {
    for (const capability of CAPABILITIES) {
      const expected = CAPABILITY_MIN_EDITION[capability] !== "service_provider";
      expect(hasCapability("business", capability)).toBe(expected);
    }
  });

  it("service_provider has every capability", () => {
    for (const capability of CAPABILITIES) {
      expect(hasCapability("service_provider", capability)).toBe(true);
    }
  });
});

describe("minEditionFor", () => {
  it("matches the capability table", () => {
    expect(minEditionFor("archive.legalHold")).toBe("business");
    expect(minEditionFor("provider.crossTenantApi")).toBe("service_provider");
  });
});
