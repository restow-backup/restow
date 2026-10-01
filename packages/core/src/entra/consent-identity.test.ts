import { describe, expect, it } from "vitest";
import type { AppCredentials } from "../graph/auth/token.js";
import { type FixtureResponse, createFakeGraph } from "../graph/testing/fake-graph.js";
import {
  CONSENT_SIGN_IN_SCOPE,
  GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID,
  PRIVILEGED_ROLE_ADMINISTRATOR_ROLE_TEMPLATE_ID,
  buildConsentSignInUrl,
  holdsConsentAuthority,
  lookupDirectoryRoleTemplateIds,
  parseConsentSignInCallback,
  proveConsentingAdmin,
  redeemConsentSignInCode,
  validateConsentIdToken,
} from "./consent-identity.js";

const clientId = "11111111-2222-3333-4444-555555555555";
const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const otherTenant = "99999999-8888-7777-6666-555555555555";
const objectId = "0f0f0f0f-1111-2222-3333-444444444444";
const redirectUri = "https://restow.example.com/api/v1/sources/m365/consent/callback";
const nonce = "state-nonce";
const nowMs = 1_800_000_000_000;
const HELPDESK_ADMIN = "729827e3-9c14-49f7-bb1b-9608f156bbb8";

const app: AppCredentials = { clientId, credential: { type: "secret", clientSecret: "s3cret" } };

function idToken(overrides: Record<string, unknown> = {}): string {
  const claims = {
    aud: clientId,
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    tid: tenantId,
    oid: objectId,
    nonce,
    preferred_username: "admin@contoso.onmicrosoft.com",
    name: "Contoso Admin",
    iat: nowMs / 1000 - 10,
    nbf: nowMs / 1000 - 10,
    exp: nowMs / 1000 + 3600,
    ...overrides,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const expectation = { clientId, tenantId, nonce, nowMs };

describe("holdsConsentAuthority", () => {
  it("accepts Global and Privileged Role Administrators only", () => {
    expect(holdsConsentAuthority([GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID])).toBe(true);
    expect(
      holdsConsentAuthority([PRIVILEGED_ROLE_ADMINISTRATOR_ROLE_TEMPLATE_ID.toUpperCase()]),
    ).toBe(true);
    expect(holdsConsentAuthority([HELPDESK_ADMIN])).toBe(false);
    expect(holdsConsentAuthority([])).toBe(false);
  });
});

describe("buildConsentSignInUrl", () => {
  it("asks the claimed tenant for an authorization code bound to state and nonce", () => {
    const url = new URL(
      buildConsentSignInUrl({
        clientId,
        tenantId: tenantId.toUpperCase(),
        redirectUri,
        state: "s.t",
        nonce,
      }),
    );
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.pathname).toBe(`/${tenantId}/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: redirectUri,
      scope: CONSENT_SIGN_IN_SCOPE,
      state: "s.t",
      nonce,
    });
  });

  it("refuses anything but a tenant id, so `common` can never stand in for the claim", () => {
    expect(() =>
      buildConsentSignInUrl({ clientId, tenantId: "common", redirectUri, state: "s", nonce }),
    ).toThrow(/GUID/);
  });
});

describe("parseConsentSignInCallback", () => {
  it("reads the code and the state", () => {
    expect(parseConsentSignInCallback({ code: "c0de", state: "s.t", session_state: "x" })).toEqual({
      ok: true,
      code: "c0de",
      state: "s.t",
    });
  });

  it("reports Entra's error, a missing code and a missing state", () => {
    expect(
      parseConsentSignInCallback({
        error: "access_denied",
        error_description: "cancelled",
        state: "s",
      }),
    ).toEqual({ ok: false, error: "access_denied", errorDescription: "cancelled", state: "s" });
    expect(parseConsentSignInCallback({ state: "s" })).toMatchObject({
      ok: false,
      error: "missing_code",
    });
    expect(parseConsentSignInCallback({ code: "c" })).toMatchObject({
      ok: false,
      error: "missing_state",
    });
  });
});

describe("validateConsentIdToken", () => {
  it("returns the account for a token that matches tenant, app and nonce", () => {
    const result = validateConsentIdToken(
      idToken({ wids: [GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID.toUpperCase()] }),
      expectation,
    );
    expect(result).toEqual({
      ok: true,
      admin: {
        tenantId,
        objectId,
        username: "admin@contoso.onmicrosoft.com",
        name: "Contoso Admin",
        roleTemplateIds: [GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID],
      },
    });
  });

  it("reports roles as unknown when the token carries no wids claim", () => {
    const result = validateConsentIdToken(idToken(), expectation);
    expect(result.ok && result.admin.roleTemplateIds).toBeNull();
  });

  it.each([
    [
      "another tenant",
      { tid: otherTenant, iss: `https://login.microsoftonline.com/${otherTenant}/v2.0` },
      "tenant",
    ],
    ["another app", { aud: "00000000-0000-0000-0000-000000000000" }, "audience"],
    ["a foreign issuer", { iss: `https://evil.example/${tenantId}/v2.0` }, "issuer"],
    ["another nonce", { nonce: "other" }, "nonce"],
    ["an expired token", { exp: nowMs / 1000 - 3600 }, "lifetime"],
    ["a token from the future", { nbf: nowMs / 1000 + 3600 }, "lifetime"],
    ["no expiry", { exp: undefined }, "lifetime"],
    ["no object id", { oid: undefined }, "subject"],
  ])("rejects %s", (_label, overrides, reason) => {
    expect(validateConsentIdToken(idToken(overrides), expectation)).toEqual({ ok: false, reason });
  });

  it("rejects something that is not a JWT", () => {
    expect(validateConsentIdToken("garbage", expectation)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("honours sovereign-cloud issuers", () => {
    const token = idToken({ iss: `https://login.microsoftonline.us/${tenantId}/v2.0` });
    expect(
      validateConsentIdToken(token, {
        ...expectation,
        authorityHost: "https://login.microsoftonline.us/",
      }).ok,
    ).toBe(true);
  });
});

const TOKEN_ENDPOINT = new RegExp(`login\\.microsoftonline\\.com/${tenantId}/oauth2/v2\\.0/token`);

describe("redeemConsentSignInCode", () => {
  it("redeems the code at the claimed tenant with the app's credentials", async () => {
    const fake = createFakeGraph([
      {
        method: "POST",
        url: TOKEN_ENDPOINT,
        respond: { status: 200, json: { id_token: "the.id.token" } },
      },
    ]);
    const result = await redeemConsentSignInCode({
      app,
      tenantId,
      code: "c0de",
      redirectUri,
      fetchImpl: fake.fetch,
    });
    expect(result).toEqual({ ok: true, idToken: "the.id.token" });
    expect(fake.calls[0]?.redirect).toBe("error");
    const form = new URLSearchParams(String(fake.calls[0]?.body));
    expect(Object.fromEntries(form)).toEqual({
      client_id: clientId,
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: redirectUri,
      scope: CONSENT_SIGN_IN_SCOPE,
      client_secret: "s3cret",
    });
  });

  it("passes Entra's error through without throwing", async () => {
    const fake = createFakeGraph([
      {
        method: "POST",
        url: TOKEN_ENDPOINT,
        respond: {
          status: 400,
          json: { error: "invalid_grant", error_description: "AADSTS54005: code already redeemed" },
        },
      },
    ]);
    expect(
      await redeemConsentSignInCode({
        app,
        tenantId,
        code: "c",
        redirectUri,
        fetchImpl: fake.fetch,
      }),
    ).toEqual({
      ok: false,
      error: "invalid_grant",
      description: "AADSTS54005: code already redeemed",
      status: 400,
    });
  });

  it("treats an answer without id_token as a failure", async () => {
    const fake = createFakeGraph([
      {
        method: "POST",
        url: TOKEN_ENDPOINT,
        respond: { status: 200, json: { access_token: "a" } },
      },
    ]);
    expect(
      await redeemConsentSignInCode({
        app,
        tenantId,
        code: "c",
        redirectUri,
        fetchImpl: fake.fetch,
      }),
    ).toMatchObject({ ok: false, error: "no_id_token" });
  });
});

const MEMBERSHIPS = new RegExp(`/users/${objectId}/transitiveMemberOf`);

function membershipPage(roleTemplateIds: string[], nextLink?: string): FixtureResponse {
  return {
    status: 200,
    json: {
      value: [
        { "@odata.type": "#microsoft.graph.group", id: "g1", displayName: "Staff" },
        ...roleTemplateIds.map((roleTemplateId) => ({
          "@odata.type": "#microsoft.graph.directoryRole",
          id: `r-${roleTemplateId}`,
          roleTemplateId,
        })),
      ],
      ...(nextLink ? { "@odata.nextLink": nextLink } : {}),
    },
  };
}

describe("lookupDirectoryRoleTemplateIds", () => {
  it("collects directory roles across pages and ignores groups", async () => {
    const next = `https://graph.microsoft.com/v1.0/users/${objectId}/transitiveMemberOf?$skiptoken=2`;
    const fake = createFakeGraph([
      {
        url: MEMBERSHIPS,
        respond: [
          membershipPage([HELPDESK_ADMIN], next),
          membershipPage([GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID]),
        ],
      },
    ]);
    const result = await lookupDirectoryRoleTemplateIds(fake.client(), objectId);
    expect(result).toEqual({
      ok: true,
      roleTemplateIds: [HELPDESK_ADMIN, GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID],
    });
    expect(fake.calls[1]?.url).toBe(next);
  });

  it("reports Graph errors", async () => {
    const fake = createFakeGraph([
      {
        url: MEMBERSHIPS,
        respond: {
          status: 403,
          json: {
            error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" },
          },
        },
      },
    ]);
    expect(await lookupDirectoryRoleTemplateIds(fake.client(), objectId)).toEqual({
      ok: false,
      status: 403,
      code: "Authorization_RequestDenied",
      message: "Insufficient privileges",
    });
  });
});

describe("proveConsentingAdmin", () => {
  function setup(options: {
    token?: FixtureResponse;
    memberships?: FixtureResponse | FixtureResponse[];
  }) {
    const fake = createFakeGraph([
      {
        method: "POST",
        url: TOKEN_ENDPOINT,
        respond: options.token ?? { status: 200, json: { id_token: idToken() } },
      },
      { url: MEMBERSHIPS, respond: options.memberships ?? membershipPage([]) },
    ]);
    let retries = 0;
    const prove = () =>
      proveConsentingAdmin({
        app,
        tenantId,
        code: "c0de",
        redirectUri,
        nonce,
        graph: fake.client(),
        onRoleLookupRetry: () => {
          retries += 1;
        },
        roleLookupRetryDelaysMs: [1, 1],
        sleep: async () => {},
        fetchImpl: fake.fetch,
        now: () => nowMs,
      });
    return { fake, prove, retries: () => retries };
  }

  it("accepts a Global Administrator named by the wids claim without asking Graph", async () => {
    const { fake, prove } = setup({
      token: {
        status: 200,
        json: { id_token: idToken({ wids: [GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID] }) },
      },
    });
    const proof = await prove();
    expect(proof).toMatchObject({ ok: true, admin: { tenantId, objectId } });
    expect(fake.callsTo("GET", "transitiveMemberOf")).toHaveLength(0);
  });

  it("confirms the role in the directory when the token has no wids", async () => {
    const { prove } = setup({
      memberships: membershipPage([PRIVILEGED_ROLE_ADMINISTRATOR_ROLE_TEMPLATE_ID]),
    });
    expect(await prove()).toMatchObject({
      ok: true,
      admin: { roleTemplateIds: [PRIVILEGED_ROLE_ADMINISTRATOR_ROLE_TEMPLATE_ID] },
    });
  });

  it("rejects a member or guest without an admin role", async () => {
    const { prove } = setup({ memberships: membershipPage([HELPDESK_ADMIN]) });
    expect(await prove()).toEqual({
      ok: false,
      reason: "not_an_admin",
      detail: null,
      account: { objectId, username: "admin@contoso.onmicrosoft.com" },
    });
  });

  it("waits for the permissions to arrive before giving up on the role lookup", async () => {
    const denied: FixtureResponse = {
      status: 403,
      json: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } },
    };
    const eventually = setup({
      memberships: [denied, membershipPage([GLOBAL_ADMINISTRATOR_ROLE_TEMPLATE_ID])],
    });
    expect((await eventually.prove()).ok).toBe(true);
    expect(eventually.retries()).toBe(1);

    const never = setup({ memberships: denied });
    expect(await never.prove()).toMatchObject({
      ok: false,
      reason: "role_check_failed",
      detail: "Authorization_RequestDenied: Insufficient privileges",
    });
    expect(never.retries()).toBe(2);
  });

  it("rejects an id_token issued for another tenant", async () => {
    const { prove } = setup({
      token: { status: 200, json: { id_token: idToken({ tid: otherTenant }) } },
    });
    expect(await prove()).toEqual({
      ok: false,
      reason: "identity_mismatch",
      detail: "tenant",
      account: null,
    });
  });

  it("reports a code that could not be redeemed", async () => {
    const { prove } = setup({
      token: { status: 400, json: { error: "invalid_grant", error_description: "expired" } },
    });
    expect(await prove()).toEqual({
      ok: false,
      reason: "sign_in_failed",
      detail: "invalid_grant: expired",
      account: null,
    });
  });
});
