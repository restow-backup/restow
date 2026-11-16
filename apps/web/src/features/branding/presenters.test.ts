import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import type { MailSenderFacts } from "./api";
import {
  accentReadout,
  addressOf,
  brandingFormFrom,
  brandingProblem,
  contrastRatio,
  isAllowedSenderEntry,
  logoFileProblem,
  MAX_LOGO_BYTES,
  normalizeAccent,
  senderAllowed,
  toBrandingInput,
  validateBranding,
} from "./presenters";

/**
 * The branding form checks what the server checks (packages/core reports/branding.ts): the
 * accent's contrast with white and with the dark text, the logo's type and size before the
 * upload, the From rules of the mail transport, and it words the server's refusals.
 */

const SMTP: MailSenderFacts = {
  transport: "smtp",
  fromLocked: false,
  defaultFrom: "Backup <backup@provider.example>",
  allowedSenders: ["@brand.example", "alerts@other.example"],
};
const GRAPH: MailSenderFacts = {
  transport: "graph",
  fromLocked: true,
  defaultFrom: "backup@provider.example",
  allowedSenders: [],
};

const blank = brandingFormFrom(null);

describe("the accent colour", () => {
  it("normalises #rrggbb and refuses everything else", () => {
    expect(normalizeAccent(" #2B4C9B ")).toBe("#2b4c9b");
    expect(normalizeAccent("#fff")).toBeNull();
    expect(normalizeAccent("red")).toBeNull();
    expect(normalizeAccent("#2b4c9b;background:url(x)")).toBeNull();
    expect(normalizeAccent(null)).toBeNull();
  });

  it("computes the WCAG contrast ratio", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#2b4c9b", "#ffffff")).toBe(contrastRatio("#ffffff", "#2b4c9b"));
  });

  it("puts white on a dark accent, dark text on a light one, and refuses a middle grey", () => {
    const dark = accentReadout("#2b4c9b");
    expect(dark?.onAccent).toBe("light");
    expect(dark?.linksUseAccent).toBe(true);
    expect(dark?.white).toBeGreaterThanOrEqual(4.5);

    const light = accentReadout("#ffd400");
    expect(light?.onAccent).toBe("dark");
    expect(light?.linksUseAccent).toBe(false);
    expect(light?.dark).toBeGreaterThanOrEqual(4.5);

    // #777777 reaches about 4.48:1 with white and less with the dark text.
    const grey = accentReadout("#777777");
    expect(grey?.onAccent).toBeNull();
    expect(grey?.white).toBeLessThan(4.5);
    expect(grey?.dark).toBeLessThan(4.5);

    expect(accentReadout("")).toBeNull();
  });
});

describe("the logo file", () => {
  const file = (name: string, type: string, size = 1000) => ({ name, type, size });

  it("takes PNG and JPEG up to 512 KiB", () => {
    expect(logoFileProblem(file("logo.png", "image/png"))).toBeNull();
    expect(logoFileProblem(file("logo.jpg", "image/jpeg", MAX_LOGO_BYTES))).toBeNull();
  });

  it("refuses SVG by type or by name, other types, and a file that is too large", () => {
    expect(logoFileProblem(file("logo.svg", "image/svg+xml"))).toBe("svg-not-supported");
    expect(logoFileProblem(file("logo.SVG", ""))).toBe("svg-not-supported");
    expect(logoFileProblem(file("logo.svgz", "application/octet-stream"))).toBe(
      "svg-not-supported",
    );
    expect(logoFileProblem(file("logo.gif", "image/gif"))).toBe("unsupported-type");
    expect(logoFileProblem(file("logo.webp", "image/webp"))).toBe("unsupported-type");
    expect(logoFileProblem(file("logo.png", "image/png", MAX_LOGO_BYTES + 1))).toBe("too-large");
  });
});

describe("the sender address", () => {
  it("reads the address of a configured From", () => {
    expect(addressOf("Backup <Backup@Provider.example>")).toBe("backup@provider.example");
    expect(addressOf("backup@provider.example")).toBe("backup@provider.example");
    expect(addressOf("not an address")).toBeNull();
    expect(addressOf(null)).toBeNull();
  });

  it("accepts an address or @domain as an allowed-senders entry", () => {
    expect(isAllowedSenderEntry("alerts@brand.example")).toBe(true);
    expect(isAllowedSenderEntry("@brand.example")).toBe(true);
    expect(isAllowedSenderEntry("@brand")).toBe(false);
    expect(isAllowedSenderEntry("brand.example")).toBe(false);
  });

  it("allows the configured sender, an exact entry and any address of an @domain entry", () => {
    const allowed = SMTP.allowedSenders;
    expect(senderAllowed("backup@provider.example", allowed, SMTP.defaultFrom)).toBe(true);
    expect(senderAllowed("Alerts@Other.example", allowed, SMTP.defaultFrom)).toBe(true);
    expect(senderAllowed("noreply@brand.example", allowed, SMTP.defaultFrom)).toBe(true);
    expect(senderAllowed("noreply@sub.brand.example", allowed, SMTP.defaultFrom)).toBe(false);
    expect(senderAllowed("someone@other.example", allowed, SMTP.defaultFrom)).toBe(false);
    expect(senderAllowed("not an address", allowed, SMTP.defaultFrom)).toBe(false);
  });
});

describe("validateBranding", () => {
  it("passes an empty form and a complete valid one", () => {
    expect(validateBranding(blank, SMTP)).toEqual({});
    expect(
      validateBranding(
        {
          senderName: "Muster IT",
          fromAddress: "noreply@brand.example",
          replyTo: "support@brand.example",
          accentColor: "#2b4c9b",
          footerText: "Muster IT GmbH\nMusterstraße 1",
        },
        SMTP,
      ),
    ).toEqual({});
  });

  it("names the field of every problem", () => {
    expect(
      validateBranding(
        {
          senderName: "x".repeat(81),
          fromAddress: "someone@elsewhere.example",
          replyTo: "nope",
          accentColor: "#777777",
          footerText: "y".repeat(2001),
        },
        SMTP,
      ),
    ).toEqual({
      senderName: "branding.errors.too-long",
      fromAddress: "branding.errors.sender-not-allowed",
      replyTo: "branding.errors.invalid-email",
      accentColor: "branding.errors.accent-contrast",
      footerText: "branding.errors.too-long",
    });
    expect(validateBranding({ ...blank, accentColor: "blue" }, SMTP).accentColor).toBe(
      "branding.errors.accent-invalid",
    );
    expect(validateBranding({ ...blank, senderName: "Line\nbreak" }, SMTP).senderName).toBe(
      "branding.errors.too-long",
    );
  });

  it("keeps the From of Microsoft 365 and Google to the configured sender", () => {
    expect(validateBranding({ ...blank, fromAddress: "noreply@brand.example" }, GRAPH)).toEqual({
      fromAddress: "branding.errors.from-locked",
    });
    expect(validateBranding({ ...blank, fromAddress: "backup@provider.example" }, GRAPH)).toEqual(
      {},
    );
  });
});

describe("toBrandingInput", () => {
  it("sends blanks as null, addresses lower-cased and the accent normalised", () => {
    expect(
      toBrandingInput({
        senderName: "  Muster IT ",
        fromAddress: "NoReply@Brand.example",
        replyTo: " ",
        accentColor: "#2B4C9B",
        footerText: "Line 1\r\nLine 2\n",
      }),
    ).toEqual({
      senderName: "Muster IT",
      fromAddress: "noreply@brand.example",
      replyTo: null,
      accentColor: "#2b4c9b",
      footerText: "Line 1\nLine 2",
    });
    expect(toBrandingInput(blank)).toEqual({
      senderName: null,
      fromAddress: null,
      replyTo: null,
      accentColor: null,
      footerText: null,
    });
  });
});

describe("brandingProblem", () => {
  const refusal = (status: number, type: string, extra: Record<string, unknown> = {}) =>
    new ApiError(status, { type, title: type, status, ...extra }, type);

  it("words the server's refusals by code and field", () => {
    expect(
      brandingProblem(
        refusal(422, "urn:restow:problem:invalid-branding", {
          code: "sender-not-allowed",
          field: "fromAddress",
        }),
      ),
    ).toEqual({ field: "fromAddress", key: "branding.errors.sender-not-allowed" });
    expect(
      brandingProblem(
        refusal(422, "urn:restow:problem:invalid-branding", {
          code: "accent-contrast",
          field: "accentColor",
          contrast: { white: 4.48, dark: 4.2 },
        }),
      ),
    ).toEqual({ field: "accentColor", key: "branding.errors.accent-contrast" });
    expect(
      brandingProblem(
        refusal(415, "urn:restow:problem:unsupported-image", { code: "svg-not-supported" }),
      ),
    ).toEqual({ field: "logo", key: "branding.errors.svg-not-supported" });
    expect(
      brandingProblem(refusal(422, "urn:restow:problem:invalid-image", { code: "animated" })),
    ).toEqual({ field: "logo", key: "branding.errors.animated" });
    expect(
      brandingProblem(refusal(422, "urn:restow:problem:invalid-image", { code: "whatever" })),
    ).toEqual({ field: "logo", key: "branding.errors.corrupt" });
  });

  it("leaves other errors to the generic message", () => {
    expect(brandingProblem(refusal(403, "urn:restow:problem:edition-required"))).toBeNull();
    expect(brandingProblem(new Error("boom"))).toBeNull();
  });
});
