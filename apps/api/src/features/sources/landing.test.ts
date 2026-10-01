import { configureProductName } from "@restow/i18n";
import { afterEach, describe, expect, it } from "vitest";
import {
  LANDING_CSP,
  escapeHtml,
  landingVariant,
  preferredLanguage,
  renderConsentLanding,
} from "./landing.js";

afterEach(() => {
  configureProductName(null);
});

describe("preferredLanguage", () => {
  it("honours order and quality values", () => {
    expect(preferredLanguage("de-DE,de;q=0.9,en;q=0.8")).toBe("de");
    expect(preferredLanguage("en-US,en;q=0.9,de;q=0.8")).toBe("en");
    expect(preferredLanguage("fr-FR,de;q=0.7,en;q=0.5")).toBe("de");
    expect(preferredLanguage("en;q=0.2,de;q=0.9")).toBe("de");
  });

  it("falls back to English for anything else", () => {
    expect(preferredLanguage(undefined)).toBe("en");
    expect(preferredLanguage("")).toBe("en");
    expect(preferredLanguage("fr,es")).toBe("en");
    expect(preferredLanguage("de;q=0")).toBe("en");
  });
});

describe("landingVariant", () => {
  it("groups the callback outcomes for someone outside Restow", () => {
    expect(landingVariant("granted")).toBe("granted");
    expect(landingVariant("denied")).toBe("denied");
    expect(landingVariant("identity_not_verified")).toBe("unverified");
    expect(landingVariant("tenant_mismatch")).toBe("rejected");
    expect(landingVariant("tenant_already_connected")).toBe("rejected");
    expect(landingVariant("invalid_state")).toBe("invalid");
    expect(landingVariant("unknown_source")).toBe("invalid");
  });
});

describe("renderConsentLanding", () => {
  it("renders a complete localized document", () => {
    const de = renderConsentLanding("granted", "de");
    expect(de).toMatch(/^<!doctype html>/);
    expect(de).toContain('<html lang="de">');
    expect(de).toContain("Consent erfasst");
    const en = renderConsentLanding("invalid_state", "en");
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("Link invalid or expired");
  });

  it("names the product through the branding, in the page, the title and every language", () => {
    const standard = renderConsentLanding("granted", "en");
    expect(standard).toContain("Restow has recorded the admin consent");
    expect(standard).toContain("· Restow</title>");
    expect(standard).not.toContain("{appName}");

    configureProductName("Acme <Backup>");
    const en = renderConsentLanding("denied", "en");
    expect(en).toContain("so Acme &lt;Backup&gt; cannot access your organisation");
    expect(en).toContain("· Acme &lt;Backup&gt;</title>");
    expect(en).not.toContain("Restow");
    const de = renderConsentLanding("invalid_state", "de");
    expect(de).toContain("beim Administrator von Acme &lt;Backup&gt; einen neuen Link an");
    expect(de).not.toContain("Restow");
  });

  it("tells an admin whose role could not be confirmed that nothing was connected", () => {
    expect(renderConsentLanding("identity_not_verified", "en")).toContain("Consent not confirmed");
    expect(renderConsentLanding("identity_not_verified", "de")).toContain(
      "Consent nicht bestätigt",
    );
  });

  it("loads nothing from outside and allows only inline styles", () => {
    const html = renderConsentLanding("denied", "en");
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\//i);
    expect(LANDING_CSP).toContain("default-src 'none'");
    expect(LANDING_CSP).not.toContain("script-src");
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
