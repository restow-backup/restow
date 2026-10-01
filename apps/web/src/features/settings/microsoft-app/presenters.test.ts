import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import type { AppPermission, MicrosoftAppView } from "./api";
import {
  EXPIRY_WARNING_DAYS,
  certificateSubjectName,
  expiryState,
  fieldReasonKey,
  microsoftAppErrorKey,
  opensslCommands,
  permissionsCopyText,
  registrationStatus,
} from "./presenters";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-23T10:00:00.000Z");

function view(overrides: Partial<MicrosoftAppView> = {}): MicrosoftAppView {
  return {
    source: "database",
    clientId: "11111111-2222-3333-4444-555555555555",
    homeTenantId: null,
    authorityHost: null,
    credential: { kind: "secret", set: true, expiresAt: null, certificate: null },
    problem: null,
    updatedAt: null,
    updatedBy: null,
    redirectUris: { adminConsent: null, signIn: null },
    permissions: [],
    sso: { configured: false },
    environmentPartial: false,
    lastTest: null,
    ...overrides,
  };
}

describe("expiryState", () => {
  it("is unknown without a date", () => {
    expect(expiryState(null, NOW)).toEqual({ kind: "unknown" });
    expect(expiryState("not a date", NOW)).toEqual({ kind: "unknown" });
  });

  it("warns within 60 days and turns red once expired", () => {
    expect(expiryState(new Date(NOW - 1).toISOString(), NOW)).toEqual({ kind: "expired" });
    expect(expiryState(new Date(NOW + 5 * DAY).toISOString(), NOW)).toEqual({
      kind: "soon",
      days: 5,
    });
    expect(
      expiryState(new Date(NOW + (EXPIRY_WARNING_DAYS - 1) * DAY).toISOString(), NOW),
    ).toMatchObject({ kind: "soon" });
    const later = new Date(NOW + (EXPIRY_WARNING_DAYS + 1) * DAY).toISOString();
    expect(expiryState(later, NOW)).toEqual({ kind: "valid", date: later });
  });
});

describe("registrationStatus", () => {
  it("names ready, missing and unusable registrations", () => {
    // A registration that is set up is in order, not proven: neutral, never green.
    expect(registrationStatus(view())).toEqual({ key: "ready", tone: "neutral" });
    expect(registrationStatus(view({ source: "environment" }))).toEqual({
      key: "ready",
      tone: "neutral",
    });
    expect(registrationStatus(view({ source: "none" }))).toEqual({ key: "none", tone: "warning" });
    expect(registrationStatus(view({ problem: "document_unreadable" }))).toEqual({
      key: "unusable",
      tone: "destructive",
    });
  });
});

describe("copyable texts", () => {
  it("lists the permissions with their type, optional ones marked", () => {
    const permissions: AppPermission[] = [
      { permission: "Mail.ReadWrite", type: "application", required: true, purpose: "mail" },
      { permission: "Mail.Send", type: "application", required: false, purpose: "notifications" },
      { permission: "openid", type: "delegated", required: true, purpose: "signIn" },
    ];
    expect(permissionsCopyText(permissions)).toBe(
      "Mail.ReadWrite (application)\nMail.Send (application, optional)\nopenid (delegated)",
    );
  });

  it("creates an RSA key pair and one PEM with key and certificate", () => {
    const commands = opensslCommands("Restow");
    expect(commands).toContain("-newkey rsa:4096");
    expect(commands).toContain("-nodes");
    expect(commands).toContain("> restow-entra.pem");
    expect(commands).toContain('-subj "/CN=Restow"');
  });

  it("names the certificate after the product, keeping only what the shell takes literally", () => {
    expect(certificateSubjectName("Acme Backup")).toBe("Acme Backup");
    expect(certificateSubjectName('Acme "$(rm -rf /)" `Backup`')).toBe("Acme rm -rf Backup");
    expect(certificateSubjectName("/CN=Evil")).toBe("CNEvil");
    expect(certificateSubjectName("日本語")).toBe("Backup");
    expect(opensslCommands('x" ; echo pwned ; "')).toContain('-subj "/CN=x echo pwned"');
  });
});

describe("error and field keys", () => {
  it("explain the section's own problems and fall back to the shared ones", () => {
    const managed = new ApiError(
      409,
      {
        type: "urn:restow:problem:microsoft-app-managed-by-environment",
        title: "Managed by the server environment",
        status: 409,
      },
      "",
    );
    expect(microsoftAppErrorKey(managed)).toBe("settings:errors.microsoftAppManaged");
    expect(microsoftAppErrorKey(new ApiError(500, null, ""))).toBe("common:errors.server");
  });

  it("map field reasons to translations, never to raw text", () => {
    expect(fieldReasonKey("secretIsId")).toBe("settings:microsoftApp.validation.secretIsId");
    expect(fieldReasonKey("keyMismatch")).toBe("settings:microsoftApp.validation.keyMismatch");
    expect(fieldReasonKey("required")).toBe("common:validation.required");
    expect(fieldReasonKey("Invalid input")).toBe("common:validation.required");
    expect(fieldReasonKey(undefined)).toBeUndefined();
  });
});
