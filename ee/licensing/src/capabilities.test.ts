import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_MIN_EDITION,
  hasCapability,
  minEditionFor,
} from "./capabilities.js";

describe("hasCapability", () => {
  it("community has no Business or Service Provider capability [LICENSE-009]", () => {
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
    // Archive capture from the mailbox (Graph, IMAP) is Business, like journaling.
    expect(minEditionFor("archive.mailboxCapture")).toBe("business");
    expect(minEditionFor("provider.crossTenantApi")).toBe("service_provider");
    // The provider team is in every edition (the core); limiting a member to
    // chosen tenants is the Service Provider part of it.
    expect(minEditionFor("provider.teamTenantScope")).toBe("service_provider");
    expect((CAPABILITIES as readonly string[]).includes("provider.team")).toBe(false);
  });

  it("places branding and the customer report (0.5.0)", () => {
    // Provider-level branding is Business; a tenant's own branding and the customer monthly
    // report are Service Provider.
    expect(minEditionFor("branding.provider")).toBe("business");
    expect(minEditionFor("branding.tenant")).toBe("service_provider");
    expect(minEditionFor("reports.customer")).toBe("service_provider");
  });
});
