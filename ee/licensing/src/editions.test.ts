import { describe, expect, it } from "vitest";
import {
  environmentEdition,
  isKeyedEdition,
  isLicenseEdition,
  resolveEffectiveLicense,
} from "./editions.js";

describe("environmentEdition", () => {
  it("is Community without demo mode, whatever RESTOW_EDITION says", () => {
    expect(environmentEdition({})).toBe("community");
    expect(environmentEdition({ RESTOW_EDITION: "service_provider" })).toBe("community");
    expect(environmentEdition({ RESTOW_EDITION: "business", RESTOW_DEMO: "false" })).toBe(
      "community",
    );
    expect(environmentEdition({ RESTOW_EDITION: "business", RESTOW_DEMO: "1" })).toBe("community");
  });

  it("honours RESTOW_EDITION in demo mode", () => {
    expect(environmentEdition({ RESTOW_DEMO: "true", RESTOW_EDITION: "service_provider" })).toBe(
      "service_provider",
    );
    expect(environmentEdition({ RESTOW_DEMO: "TRUE", RESTOW_EDITION: " Business " })).toBe(
      "business",
    );
  });

  it("falls back to Community for an unknown or missing edition in demo mode", () => {
    expect(environmentEdition({ RESTOW_DEMO: "true" })).toBe("community");
    expect(environmentEdition({ RESTOW_DEMO: "true", RESTOW_EDITION: "enterprise" })).toBe(
      "community",
    );
  });
});

describe("resolveEffectiveLicense", () => {
  it("applies the environment's edition without a key", () => {
    expect(resolveEffectiveLicense(null, "community")).toEqual({
      edition: "community",
      source: "environment",
    });
  });

  it("lets an installed key win over the environment", () => {
    expect(resolveEffectiveLicense({ edition: "business" }, "service_provider")).toEqual({
      edition: "business",
      source: "key",
    });
  });
});

describe("edition guards", () => {
  it("recognizes editions and the keyed subset", () => {
    expect(isLicenseEdition("community")).toBe(true);
    expect(isLicenseEdition("enterprise")).toBe(false);
    expect(isKeyedEdition("business")).toBe(true);
    expect(isKeyedEdition("community")).toBe(false);
  });
});
