import type { EntraAppDocument, EntraAppResolution } from "@restow/core";
import { describe, expect, it, vi } from "vitest";
import { ProblemError } from "../../../problem.js";
import { mayKeepStoredCredential, planMicrosoftAppSave, toMicrosoftAppView } from "./logic.js";
import { type SaveMicrosoftAppInput, expiryDate, saveMicrosoftAppSchema } from "./schemas.js";

/** Self-signed certificates built in memory (@restow/core test helper, not part of its API). */
interface TestCertificate {
  keyPem: string;
  certificatePem: string;
  combinedPem: string;
}
const testing = await vi.importActual<{
  createTestCertificate: (options?: { notBefore?: Date; notAfter?: Date }) => TestCertificate;
}>("../../../../../../packages/core/src/entra/testing/certificate.js");

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_APP = "99999999-8888-7777-6666-555555555555";
const NOW = new Date("2026-09-23T10:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

/**
 * A certificate valid at NOW, the clock every plan below runs on. The helper's
 * default window starts an hour before the real time, which lies after NOW
 * for most of the day, so the window is pinned here.
 */
function createTestCertificate(
  options: { notBefore?: Date; notAfter?: Date } = {},
): TestCertificate {
  return testing.createTestCertificate({
    notBefore: new Date(NOW.getTime() - HOUR_MS),
    notAfter: new Date(NOW.getTime() + 365 * 24 * HOUR_MS),
    ...options,
  });
}
const SECRET = "stored~secret.value_0123456789abcdefghij";

const stored: EntraAppDocument = {
  clientId: CLIENT_ID,
  credentialKind: "secret",
  clientSecret: SECRET,
  secretExpiresAt: "2027-01-31T00:00:00.000Z",
  homeTenantId: "contoso.onmicrosoft.com",
  authorityHost: null,
  updatedAt: "2026-09-01T00:00:00.000Z",
  updatedBy: "first@provider.test",
};

function input(values: Record<string, unknown>): SaveMicrosoftAppInput {
  return saveMicrosoftAppSchema.parse({ clientId: CLIENT_ID, ...values });
}

function issuesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    const issues = (error as ProblemError).extensions?.issues as {
      path: string[];
      message: string;
    }[];
    return issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
  }
  throw new Error("expected a validation problem");
}

describe("planMicrosoftAppSave", () => {
  it("creates a document with a new secret and names what changed", () => {
    const plan = planMicrosoftAppSave(
      null,
      input({
        clientSecret: "new~secret",
        secretExpiresAt: "2028-09-23",
        homeTenantId: "contoso.com",
      }),
      "admin@provider.test",
      NOW,
    );
    expect(plan.document).toEqual({
      clientId: CLIENT_ID,
      credentialKind: "secret",
      clientSecret: "new~secret",
      secretExpiresAt: "2028-09-23T00:00:00.000Z",
      homeTenantId: "contoso.com",
      authorityHost: null,
      updatedAt: NOW.toISOString(),
      updatedBy: "admin@provider.test",
    });
    expect(plan.credentialChanged).toBe(true);
    expect(plan.changes).toEqual([
      "clientId",
      "credentialKind",
      "secretExpiresAt",
      "homeTenantId",
      "clientSecret",
    ]);
    expect(JSON.stringify(plan.changes)).not.toContain("new~secret");
  });

  it("keeps the stored secret when none is sent for the same app", () => {
    const plan = planMicrosoftAppSave(
      stored,
      input({ secretExpiresAt: "2027-01-31", homeTenantId: "fabrikam.onmicrosoft.com" }),
      "second@provider.test",
      NOW,
    );
    expect(plan.document.clientSecret).toBe(SECRET);
    expect(plan.credentialChanged).toBe(false);
    expect(plan.changes).toEqual(["homeTenantId"]);
    expect(plan.document.updatedBy).toBe("second@provider.test");
  });

  it("never hands the stored credential to another app or another login host", () => {
    expect(mayKeepStoredCredential(stored, { clientId: CLIENT_ID, authorityHost: null })).toBe(
      true,
    );
    expect(
      issuesOf(() => planMicrosoftAppSave(stored, input({ clientId: OTHER_APP }), "a", NOW)),
    ).toEqual(["clientSecret:credentialRequired"]);
    expect(
      issuesOf(() =>
        planMicrosoftAppSave(
          stored,
          input({ authorityHost: "https://login.microsoftonline.us" }),
          "a",
          NOW,
        ),
      ),
    ).toEqual(["clientSecret:credentialRequired"]);
    expect(issuesOf(() => planMicrosoftAppSave(null, input({}), "a", NOW))).toEqual([
      "clientSecret:credentialRequired",
    ]);
  });

  it("switches to a certificate, keeps only key and certificate, drops the secret's expiry", () => {
    const certificate = createTestCertificate();
    const plan = planMicrosoftAppSave(
      stored,
      input({
        certificatePem: `Bag Attributes\n${certificate.combinedPem}`,
        secretExpiresAt: "2030-01-01",
      }),
      "admin@provider.test",
      NOW,
    );
    expect(plan.document.credentialKind).toBe("certificate");
    expect(plan.document.clientSecret).toBeUndefined();
    expect(plan.document.certificatePem).not.toContain("Bag Attributes");
    expect(plan.document.certificatePem).toContain("BEGIN PRIVATE KEY");
    expect(plan.document.secretExpiresAt).toBeNull();
    expect(plan.certificate?.thumbprint).toMatch(/^[0-9A-F]{40}$/);
    expect(plan.changes).toContain("certificate");
  });

  it("explains an unusable certificate at the field", () => {
    const certificate = createTestCertificate();
    const expired = createTestCertificate({
      notBefore: new Date("2024-01-01T00:00:00Z"),
      notAfter: new Date("2025-01-01T00:00:00Z"),
    });
    const plan = (pem: string) => () =>
      planMicrosoftAppSave(null, input({ certificatePem: pem }), "a", NOW);
    expect(issuesOf(plan(certificate.certificatePem))).toEqual([
      "certificatePem:privateKeyMissing",
    ]);
    expect(issuesOf(plan(certificate.keyPem))).toEqual(["certificatePem:certificateMissing"]);
    expect(issuesOf(plan(expired.combinedPem))).toEqual(["certificatePem:certificateExpired"]);
    expect(
      issuesOf(plan(`${createTestCertificate().keyPem}${certificate.certificatePem}`)),
    ).toEqual(["certificatePem:keyMismatch"]);
  });
});

describe("saveMicrosoftAppSchema", () => {
  const issues = (values: Record<string, unknown>) => {
    const result = saveMicrosoftAppSchema.safeParse(values);
    return result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
  };

  it("validates every field with a reason, never with the value", () => {
    expect(issues({ clientSecret: "x" })).toEqual(["clientId:required"]);
    expect(issues({ clientId: "no-guid" })).toEqual(["clientId:guid"]);
    expect(issues({ clientId: CLIENT_ID, secretExpiresAt: "31.12.2027" })).toEqual([
      "secretExpiresAt:date",
    ]);
    expect(issues({ clientId: CLIENT_ID, homeTenantId: "not a tenant" })).toEqual([
      "homeTenantId:tenantId",
    ]);
    expect(
      issues({ clientId: CLIENT_ID, authorityHost: "https://login.example.com/common" }),
    ).toEqual(["authorityHost:authorityHost"]);
    // Only the fixed list of Entra login hosts is accepted, even as a bare https
    // origin: anything else would reach outbound token requests and customer
    // consent links (MEDIUM-1).
    expect(issues({ clientId: CLIENT_ID, authorityHost: "https://login.example.com" })).toEqual([
      "authorityHost:authorityHost",
    ]);
    expect(issues({ clientId: CLIENT_ID, authorityHost: "https://169.254.169.254" })).toEqual([
      "authorityHost:authorityHost",
    ]);
    expect(
      issues({ clientId: CLIENT_ID, authorityHost: "https://login.chinacloudapi.cn" }),
    ).toEqual([]);
    expect(issues({ clientId: CLIENT_ID, clientSecret: "x".repeat(1025) })).toEqual([
      "clientSecret:tooLong",
    ]);
    expect(issues({ clientId: CLIENT_ID, clientSecret: "", certificatePem: "  " })).toEqual([]);
  });

  it("reads calendar dates strictly", () => {
    expect(expiryDate("2027-02-28")).toBe("2027-02-28T00:00:00.000Z");
    expect(expiryDate("2027-02-30")).toBeNull();
    expect(expiryDate("2027-02-28T13:45:00Z")).toBe("2027-02-28T00:00:00.000Z");
  });
});

describe("toMicrosoftAppView", () => {
  const base = {
    publicOrigin: "https://restow.example.com",
    ssoConfigured: false,
    environmentPartial: false,
    lastTest: null,
  };

  it("shows the registration in use without its secret", () => {
    const resolution: EntraAppResolution = {
      status: "ready",
      app: {
        source: "database",
        credentials: { clientId: CLIENT_ID, credential: { type: "secret", clientSecret: SECRET } },
        credentialKind: "secret",
        expiresAt: "2027-01-31T00:00:00.000Z",
        certificate: null,
        homeTenantId: "contoso.onmicrosoft.com",
        updatedAt: "2026-09-01T00:00:00.000Z",
        updatedBy: "first@provider.test",
        fingerprint: "fingerprint-value",
      },
    };
    const view = toMicrosoftAppView({ ...base, resolution });
    expect(view).toMatchObject({
      source: "database",
      clientId: CLIENT_ID,
      homeTenantId: "contoso.onmicrosoft.com",
      credential: { kind: "secret", set: true, expiresAt: "2027-01-31T00:00:00.000Z" },
      redirectUris: {
        adminConsent: "https://restow.example.com/api/v1/sources/m365/consent/callback",
        signIn: "https://restow.example.com/api/auth/callback/microsoft",
      },
      problem: null,
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("fingerprint-value");
    expect(view.permissions.map((entry) => entry.permission)).toEqual([
      "Mail.ReadWrite",
      "MailboxSettings.Read",
      "Calendars.ReadWrite",
      "Contacts.ReadWrite",
      "Files.ReadWrite.All",
      "User.Read.All",
      "Group.Read.All",
      "Directory.Read.All",
      "Organization.Read.All",
      "Mail.Send",
      "openid",
      "profile",
    ]);
    expect(view.permissions.find((entry) => entry.permission === "Mail.Send")?.required).toBe(
      false,
    );
  });

  it("is empty before anything is configured and honest about an unusable one", () => {
    const none = toMicrosoftAppView({
      ...base,
      publicOrigin: null,
      environmentPartial: true,
      resolution: { status: "none", clientId: CLIENT_ID },
    });
    expect(none).toMatchObject({
      source: "none",
      clientId: null,
      credential: { kind: null, set: false },
      redirectUris: { adminConsent: null, signIn: null },
      environmentPartial: true,
    });
    const unusable = toMicrosoftAppView({
      ...base,
      resolution: {
        status: "unusable",
        source: "database",
        clientId: null,
        reason: "document_unreadable",
        detail: "The saved app registration could not be opened.",
      },
    });
    expect(unusable).toMatchObject({
      source: "database",
      problem: "document_unreadable",
      credential: { set: true },
    });
  });
});
