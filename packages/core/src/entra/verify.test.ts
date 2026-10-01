import { describe, expect, it } from "vitest";
import { TokenAcquisitionError } from "../graph/auth/token.js";
import { createFakeGraph } from "../graph/testing/fake-graph.js";
import { REQUIRED_PERMISSIONS } from "./permissions.js";
import {
  type RefreshableTokenProvider,
  TEST_CALL_SELECT,
  classifyTokenFailure,
  listFirstUsers,
  verifyTenantConnection,
} from "./verify.js";

function jwtWithRoles(roles: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ roles })).toString("base64url");
  return `${header}.${payload}.sig`;
}

function provider(token: string | Error): RefreshableTokenProvider & { invalidated: number } {
  return {
    invalidated: 0,
    invalidate() {
      this.invalidated += 1;
    },
    getToken: async () => {
      if (token instanceof Error) {
        throw token;
      }
      return token;
    },
  };
}

const usersPage = {
  value: [
    { id: "u1", displayName: "Alice", userPrincipalName: "alice@contoso.com" },
    { id: "u2", displayName: null, userPrincipalName: "shared@contoso.com" },
    { displayName: "no id, skipped" },
  ],
};

describe("classifyTokenFailure", () => {
  it("maps AADSTS codes to actionable hints", () => {
    const cases: Array<[string, string | undefined, string]> = [
      [
        "AADSTS700016: Application not found in the directory",
        "unauthorized_client",
        "consent_missing",
      ],
      ["AADSTS65001: The user or administrator has not consented", undefined, "consent_missing"],
      ["AADSTS7000215: Invalid client secret provided.", "invalid_client", "invalid_credentials"],
      [
        "AADSTS7000222: The provided client secret keys are expired.",
        "invalid_client",
        "credentials_expired",
      ],
      ["AADSTS90002: Tenant 'x' not found.", "invalid_request", "tenant_unknown"],
      ["something else", "unauthorized_client", "consent_missing"],
      ["something else", "invalid_client", "invalid_credentials"],
      ["something else", "temporarily_unavailable", "unknown"],
    ];
    for (const [message, code, hint] of cases) {
      const failure = classifyTokenFailure(
        new TokenAcquisitionError(message, { status: 401, code }),
      );
      expect(failure.hint, message).toBe(hint);
      expect(failure.code).toBe(code ?? null);
    }
    expect(classifyTokenFailure(new TokenAcquisitionError("AADSTS700016: x", {})).aadsts).toBe(
      "AADSTS700016",
    );
  });
});

describe("listFirstUsers", () => {
  it("asks for a minimal select and returns the sample", async () => {
    const fake = createFakeGraph([{ url: /\/users\?/, respond: { status: 200, json: usersPage } }]);
    const result = await listFirstUsers(fake.client(), 5);
    expect(result).toEqual({
      ok: true,
      usersSampled: 2,
      sample: [
        { id: "u1", displayName: "Alice", userPrincipalName: "alice@contoso.com" },
        { id: "u2", displayName: null, userPrincipalName: "shared@contoso.com" },
      ],
    });
    const call = fake.callsTo("GET", "/users")[0];
    const url = new URL(call?.url ?? "");
    expect(url.searchParams.get("$select")).toBe(TEST_CALL_SELECT);
    expect(url.searchParams.get("$top")).toBe("5");
  });

  it("surfaces Graph's error code and message on failure", async () => {
    const fake = createFakeGraph([
      {
        url: /\/users\?/,
        respond: {
          status: 403,
          json: {
            error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" },
          },
        },
      },
    ]);
    expect(await listFirstUsers(fake.client(), 5)).toEqual({
      ok: false,
      status: 403,
      code: "Authorization_RequestDenied",
      message: "Insufficient privileges",
    });
  });

  it("clamps the sample size into Graph's range", async () => {
    const fake = createFakeGraph([
      { url: /\/users\?/, respond: { status: 200, json: { value: [] } } },
    ]);
    await listFirstUsers(fake.client(), 5000);
    expect(new URL(fake.calls[0]?.url ?? "").searchParams.get("$top")).toBe("999");
  });
});

describe("verifyTenantConnection", () => {
  it("is green when the token carries every required role and the test call works", async () => {
    const fake = createFakeGraph([{ url: /\/users\?/, respond: { status: 200, json: usersPage } }]);
    const tokenProvider = provider(jwtWithRoles([...REQUIRED_PERMISSIONS]));
    const result = await verifyTenantConnection({
      tokenProvider,
      graph: fake.client(),
      now: () => new Date("2026-09-22T10:00:00Z"),
    });
    expect(tokenProvider.invalidated).toBe(1);
    expect(result.checkedAt).toBe("2026-09-22T10:00:00.000Z");
    expect(result.ok).toBe(true);
    expect(result.tokenAcquired).toBe(true);
    expect(result.permissions?.complete).toBe(true);
    expect(result.testCall).toMatchObject({ ok: true, usersSampled: 2 });
  });

  it("is red with the read-only pitfall named when Mail.Read was granted instead", async () => {
    const fake = createFakeGraph([{ url: /\/users\?/, respond: { status: 200, json: usersPage } }]);
    const roles = REQUIRED_PERMISSIONS.filter((p) => p !== "Mail.ReadWrite").concat("Mail.Read");
    const result = await verifyTenantConnection({
      tokenProvider: provider(jwtWithRoles(roles)),
      graph: fake.client(),
    });
    expect(result.ok).toBe(false);
    expect(result.permissions?.readOnlyInstead).toEqual([
      { expected: "Mail.ReadWrite", granted: "Mail.Read" },
    ]);
    // The test call still ran so the operator sees the whole picture.
    expect(result.testCall?.ok).toBe(true);
  });

  it("reports a token failure without touching Graph", async () => {
    const fake = createFakeGraph([]);
    const result = await verifyTenantConnection({
      tokenProvider: provider(
        new TokenAcquisitionError("AADSTS700016: Application not found", {
          status: 400,
          code: "unauthorized_client",
        }),
      ),
      graph: fake.client(),
    });
    expect(result).toMatchObject({
      ok: false,
      tokenAcquired: false,
      tokenError: { hint: "consent_missing", aadsts: "AADSTS700016", status: 400 },
      permissions: null,
      testCall: null,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("treats an opaque token as carrying no roles but still runs the test call", async () => {
    const fake = createFakeGraph([
      { url: /\/users\?/, respond: { status: 403, json: { error: { code: "Forbidden" } } } },
    ]);
    const result = await verifyTenantConnection({
      tokenProvider: provider("opaque"),
      graph: fake.client(),
    });
    expect(result.ok).toBe(false);
    expect(result.permissions?.missing).toEqual([...REQUIRED_PERMISSIONS]);
    expect(result.testCall).toMatchObject({ ok: false, status: 403, code: "Forbidden" });
  });
});
