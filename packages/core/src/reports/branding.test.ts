import { describe, expect, it } from "vitest";
import {
  accentContrast,
  addressOf,
  type BrandingRow,
  brandingAccentPath,
  brandingImagePath,
  contrastRatio,
  DEFAULT_LINK_COLOR,
  discordUsername,
  httpsPublicUrl,
  isAllowedSenderEntry,
  linkColorFor,
  normalizeAccent,
  onAccentFor,
  resolveBrand,
  senderAllowed,
} from "./branding.js";

describe("contrast", () => {
  it("computes WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(accentContrast("#767676").white).toBeGreaterThanOrEqual(4.5);
  });

  it("chooses white, then dark text, else refuses the accent", () => {
    expect(onAccentFor("#1d4ed8")).toBe("light");
    expect(onAccentFor("#facc15")).toBe("dark");
    // A mid grey reads with neither white (about 3.9) nor the dark ink (about 4.3).
    expect(onAccentFor("#808080")).toBeNull();
  });

  it("uses the accent for links only when it reads on white", () => {
    expect(linkColorFor("#1d4ed8")).toBe("#1d4ed8");
    expect(linkColorFor("#facc15")).toBe(DEFAULT_LINK_COLOR);
    expect(linkColorFor(null)).toBe(DEFAULT_LINK_COLOR);
  });

  it("accepts only #rrggbb", () => {
    expect(normalizeAccent("#1D4ED8")).toBe("#1d4ed8");
    expect(normalizeAccent("#abc")).toBeNull();
    expect(normalizeAccent("red")).toBeNull();
    expect(normalizeAccent("#1d4ed8;background:url(x)")).toBeNull();
    expect(() => contrastRatio("javascript:", "#ffffff")).toThrow(RangeError);
  });
});

describe("sender addresses", () => {
  it("allows the configured sender, exact entries and @domain entries", () => {
    const allowed = ["alerts@msp.example", "@brand.example"];
    expect(
      senderAllowed("Noreply@Restow.example", allowed, "Restow <noreply@restow.example>"),
    ).toBe(true);
    expect(senderAllowed("alerts@msp.example", allowed, null)).toBe(true);
    expect(senderAllowed("anyone@brand.example", allowed, null)).toBe(true);
    expect(senderAllowed("anyone@sub.brand.example", allowed, null)).toBe(false);
    expect(senderAllowed("other@msp.example", allowed, null)).toBe(false);
    expect(senderAllowed("a@b.example\r\nBcc: x@y", allowed, null)).toBe(false);
  });

  it("validates allowed-senders entries and reads a configured From", () => {
    expect(isAllowedSenderEntry("@brand.example")).toBe(true);
    expect(isAllowedSenderEntry("@brand")).toBe(false);
    expect(isAllowedSenderEntry("ops@brand.example")).toBe(true);
    expect(isAllowedSenderEntry("not an address")).toBe(false);
    expect(addressOf("Name <A@B.example>")).toBe("a@b.example");
    expect(addressOf("garbage")).toBeNull();
  });
});

describe("discordUsername", () => {
  it("drops names Discord refuses", () => {
    expect(discordUsername("Contoso IT")).toBe("Contoso IT");
    expect(discordUsername("My Discord Bot")).toBeNull();
    expect(discordUsername("clyde")).toBeNull();
    expect(discordUsername("  ")).toBeNull();
    expect(discordUsername("x".repeat(100))).toHaveLength(80);
  });
});

describe("resolveBrand", () => {
  const logo = {
    imageId: "i1",
    token: "t".repeat(43),
    contentType: "image/png" as const,
    width: 200,
    height: 60,
    sha256: "a".repeat(64),
  };
  const provider: BrandingRow = {
    senderName: "MSP Backup",
    fromAddress: "alerts@msp.example",
    replyTo: "help@msp.example",
    accentColor: "#1d4ed8",
    footerText: "MSP GmbH\nMain St 1",
    logo,
  };
  const tenant: BrandingRow = {
    senderName: "Contoso IT",
    fromAddress: null,
    replyTo: null,
    accentColor: "#facc15",
    footerText: null,
    logo: null,
  };
  const base = { productName: "Restow", provider, tenant };

  it("follows the gates: tenant, then provider, then the product name", () => {
    const sp = resolveBrand({ ...base, providerAllowed: true, tenantAllowed: true });
    expect(sp.source).toBe("tenant");
    expect(sp.senderName).toBe("Contoso IT");
    expect(sp.onAccent).toBe("dark");
    expect(sp.linkColor).toBeNull();
    expect(sp.logo).toBeNull();

    const business = resolveBrand({ ...base, providerAllowed: true, tenantAllowed: false });
    expect(business.source).toBe("provider");
    expect(business.senderName).toBe("MSP Backup");
    expect(business.linkColor).toBe("#1d4ed8");
    expect(business.logo).toEqual(logo);

    const community = resolveBrand({ ...base, providerAllowed: false, tenantAllowed: false });
    expect(community).toMatchObject({ source: "product", senderName: "Restow", branded: false });
    expect(community.logo).toBeNull();
  });

  it("falls back to the provider when the tenant has no override", () => {
    const brand = resolveBrand({
      ...base,
      tenant: null,
      providerAllowed: true,
      tenantAllowed: true,
    });
    expect(brand.source).toBe("provider");
  });

  it("ignores a stored accent that fails the contrast rule", () => {
    const brand = resolveBrand({
      ...base,
      provider: { ...provider, accentColor: "#808080" },
      tenant: null,
      providerAllowed: true,
      tenantAllowed: false,
    });
    expect(brand.accentColor).toBeNull();
    expect(brand.onAccent).toBeNull();
  });

  it("builds public image URLs for https only", () => {
    expect(brandingImagePath(logo)).toBe(`/api/v1/public/branding/${logo.token}.png`);
    expect(brandingAccentPath("#1D4ED8")).toBe("/api/v1/public/branding/accent/1d4ed8.png");
    expect(brandingAccentPath("nope")).toBeNull();
    expect(httpsPublicUrl("https://restow.example/x", "/p")).toBe("https://restow.example/p");
    expect(httpsPublicUrl("http://restow.example", "/p")).toBeNull();
    expect(httpsPublicUrl(null, "/p")).toBeNull();
    const brand = resolveBrand({
      ...base,
      tenant: null,
      providerAllowed: true,
      tenantAllowed: false,
      logoUrl: (l) => httpsPublicUrl("https://restow.example", brandingImagePath(l)),
    });
    expect(brand.logoUrl).toBe(`https://restow.example/api/v1/public/branding/${logo.token}.png`);
  });
});
