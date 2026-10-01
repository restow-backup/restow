import { describe, expect, it } from "vitest";
import {
  ADMIN_CONSENT_CALLBACK_PATH,
  adminConsentRedirectUri,
  buildAdminConsentUrl,
  isEntraTenantId,
  normalizeTenantReference,
  parseAdminConsentCallback,
} from "./consent.js";

const clientId = "11111111-2222-3333-4444-555555555555";
const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("adminConsentRedirectUri", () => {
  it("derives the callback from the public origin only (no path, no query)", () => {
    expect(adminConsentRedirectUri("https://restow.example.com")).toBe(
      `https://restow.example.com${ADMIN_CONSENT_CALLBACK_PATH}`,
    );
    expect(adminConsentRedirectUri("https://restow.example.com/some/path?x=1")).toBe(
      `https://restow.example.com${ADMIN_CONSENT_CALLBACK_PATH}`,
    );
  });
});

describe("normalizeTenantReference", () => {
  it("accepts tenant ids and verified domains, lower-cased", () => {
    expect(normalizeTenantReference(tenantId.toUpperCase())).toBe(tenantId);
    expect(normalizeTenantReference(" Contoso.OnMicrosoft.com ")).toBe("contoso.onmicrosoft.com");
    expect(isEntraTenantId(tenantId)).toBe(true);
  });

  it("rejects anything that is not a tenant reference", () => {
    expect(normalizeTenantReference("")).toBeNull();
    expect(normalizeTenantReference(undefined)).toBeNull();
    expect(normalizeTenantReference("not a tenant")).toBeNull();
    expect(normalizeTenantReference("contoso")).toBeNull();
    expect(normalizeTenantReference("https://evil.example/..")).toBeNull();
    expect(isEntraTenantId("contoso.onmicrosoft.com")).toBe(false);
  });
});

describe("buildAdminConsentUrl", () => {
  it("targets the v2.0 admin-consent endpoint with .default scope and the signed state", () => {
    const url = new URL(
      buildAdminConsentUrl({
        clientId,
        tenant: "contoso.onmicrosoft.com",
        redirectUri: "https://restow.example.com/api/v1/sources/m365/consent/callback",
        state: "abc.def",
      }),
    );
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe("/contoso.onmicrosoft.com/v2.0/adminconsent");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://restow.example.com/api/v1/sources/m365/consent/callback",
    );
    expect(url.searchParams.get("state")).toBe("abc.def");
  });

  it("falls back to the organizations audience when no tenant is known", () => {
    const url = new URL(
      buildAdminConsentUrl({ clientId, redirectUri: "https://o.example/cb", state: "s" }),
    );
    expect(url.pathname).toBe("/organizations/v2.0/adminconsent");
    const junk = new URL(
      buildAdminConsentUrl({
        clientId,
        tenant: "../evil",
        redirectUri: "https://o.example/cb",
        state: "s",
      }),
    );
    expect(junk.pathname).toBe("/organizations/v2.0/adminconsent");
  });

  it("supports sovereign cloud authorities", () => {
    const url = buildAdminConsentUrl({
      clientId,
      redirectUri: "https://o.example/cb",
      state: "s",
      authorityHost: "https://login.microsoftonline.us/",
    });
    expect(url.startsWith("https://login.microsoftonline.us/organizations/")).toBe(true);
  });
});

describe("parseAdminConsentCallback", () => {
  it("accepts a granted consent with the tenant id", () => {
    const params = new URLSearchParams({
      admin_consent: "True",
      tenant: tenantId.toUpperCase(),
      scope: "https://graph.microsoft.com/.default",
      state: "abc.def",
    });
    expect(parseAdminConsentCallback(params)).toEqual({
      ok: true,
      claimedTenantId: tenantId,
      state: "abc.def",
      scope: "https://graph.microsoft.com/.default",
    });
  });

  it("reports the admin declining", () => {
    expect(
      parseAdminConsentCallback({
        error: "access_denied",
        error_description: "AADSTS65004: User declined to consent to access the app.",
        state: "abc.def",
      }),
    ).toEqual({
      ok: false,
      error: "access_denied",
      errorDescription: "AADSTS65004: User declined to consent to access the app.",
      state: "abc.def",
    });
  });

  it("does not treat admin_consent=False or a missing tenant as success", () => {
    expect(
      parseAdminConsentCallback({ admin_consent: "False", tenant: tenantId, state: "s" }),
    ).toMatchObject({ ok: false, error: "consent_not_granted" });
    expect(parseAdminConsentCallback({ admin_consent: "True", state: "s" })).toMatchObject({
      ok: false,
      error: "consent_not_granted",
    });
    expect(
      parseAdminConsentCallback({ admin_consent: "True", tenant: "contoso.onmicrosoft.com" }),
    ).toMatchObject({ ok: false, error: "consent_not_granted" });
  });

  it("requires the state to bind the callback to a request", () => {
    expect(parseAdminConsentCallback({ admin_consent: "True", tenant: tenantId })).toEqual({
      ok: false,
      error: "missing_state",
      errorDescription: null,
      state: null,
    });
  });
});
