import { describe, expect, it } from "vitest";

import type { MicrosoftAppView } from "./api";
import {
  type MicrosoftAppFormValues,
  formFromView,
  mayKeepCredential,
  microsoftAppFormSchema,
  storedCredential,
  toSaveInput,
} from "./forms";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

const saved: MicrosoftAppView = {
  source: "database",
  clientId: CLIENT_ID,
  homeTenantId: "contoso.onmicrosoft.com",
  authorityHost: null,
  credential: {
    kind: "secret",
    set: true,
    expiresAt: "2027-03-01T00:00:00.000Z",
    certificate: null,
  },
  problem: null,
  updatedAt: "2026-09-20T08:00:00.000Z",
  updatedBy: "admin@provider.test",
  redirectUris: { adminConsent: null, signIn: null },
  permissions: [],
  sso: { configured: false },
  environmentPartial: false,
  lastTest: null,
};

function issues(values: MicrosoftAppFormValues, view: MicrosoftAppView | null = saved): string[] {
  const result = microsoftAppFormSchema(view ? storedCredential(view) : null).safeParse(values);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
}

describe("formFromView", () => {
  it("never prefills the secret or the certificate", () => {
    expect(formFromView(saved)).toEqual({
      clientId: CLIENT_ID,
      homeTenantId: "contoso.onmicrosoft.com",
      credentialKind: "secret",
      clientSecret: "",
      secretExpiresAt: "2027-03-01",
      certificatePem: "",
      authorityHost: "",
    });
    const certificate = formFromView({
      ...saved,
      credential: {
        kind: "certificate",
        set: true,
        expiresAt: "2028-01-01T00:00:00Z",
        certificate: null,
      },
    });
    expect(certificate.certificatePem).toBe("");
    expect(certificate.secretExpiresAt).toBe("");
  });
});

describe("microsoftAppFormSchema", () => {
  const values = formFromView(saved);

  it("keeps the stored secret for the same app and login host", () => {
    expect(issues(values)).toEqual([]);
    expect(mayKeepCredential(values, storedCredential(saved))).toBe(true);
  });

  it("asks for the credential again for another app, another host or another kind", () => {
    expect(issues({ ...values, clientId: "99999999-2222-3333-4444-555555555555" })).toEqual([
      "clientSecret:credentialRequired",
    ]);
    expect(issues({ ...values, authorityHost: "https://login.microsoftonline.us" })).toEqual([
      "clientSecret:credentialRequired",
    ]);
    expect(issues({ ...values, credentialKind: "certificate" })).toEqual([
      "certificatePem:credentialRequired",
    ]);
    expect(issues(values, null)).toEqual(["clientSecret:credentialRequired"]);
    // A registration from the environment has nothing stored here to keep.
    expect(issues(values, { ...saved, source: "environment" })).toEqual([
      "clientSecret:credentialRequired",
    ]);
  });

  it("recognises the Secret ID pasted instead of the value", () => {
    expect(issues({ ...values, clientSecret: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })).toEqual([
      "clientSecret:secretIsId",
    ]);
  });

  it("checks ids, dates, hosts and the PEM's parts before sending", () => {
    // Another (here: no) app id also means the stored secret cannot be kept.
    expect(issues({ ...values, clientId: "" })).toEqual([
      "clientId:required",
      "clientSecret:credentialRequired",
    ]);
    expect(issues({ ...values, clientId: "Restow" })).toContain("clientId:guid");
    expect(issues({ ...values, homeTenantId: "no tenant" })).toEqual(["homeTenantId:tenantId"]);
    expect(issues({ ...values, secretExpiresAt: "2027-02-30" })).toEqual(["secretExpiresAt:date"]);
    expect(issues({ ...values, authorityHost: "http://login.example.com" })).toContain(
      "authorityHost:authorityHost",
    );
    // Only Microsoft's own login hosts are accepted, even as a bare https origin.
    expect(issues({ ...values, authorityHost: "https://login.example.com" })).toContain(
      "authorityHost:authorityHost",
    );
    const pem = (text: string) =>
      issues({ ...values, credentialKind: "certificate", certificatePem: text });
    expect(pem("-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----")).toEqual([
      "certificatePem:certificateMissing",
    ]);
    expect(pem("-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----")).toEqual([
      "certificatePem:privateKeyMissing",
    ]);
    expect(
      pem("-----BEGIN ENCRYPTED PRIVATE KEY-----\nA\n-----END ENCRYPTED PRIVATE KEY-----"),
    ).toEqual(["certificatePem:privateKeyEncrypted"]);
  });
});

describe("toSaveInput", () => {
  it("leaves empty credentials out, so the stored one is kept", () => {
    expect(toSaveInput(formFromView(saved))).toEqual({
      clientId: CLIENT_ID,
      homeTenantId: "contoso.onmicrosoft.com",
      authorityHost: null,
      secretExpiresAt: "2027-03-01",
    });
  });

  it("sends only the credential of the chosen kind", () => {
    const values: MicrosoftAppFormValues = {
      ...formFromView(saved),
      clientSecret: " new~secret ",
      certificatePem: "ignored",
    };
    expect(toSaveInput(values)).toMatchObject({ clientSecret: "new~secret" });
    expect(toSaveInput(values)).not.toHaveProperty("certificatePem");
    const certificate = toSaveInput({ ...values, credentialKind: "certificate" });
    expect(certificate).toMatchObject({ certificatePem: "ignored", secretExpiresAt: null });
    expect(certificate).not.toHaveProperty("clientSecret");
  });
});
