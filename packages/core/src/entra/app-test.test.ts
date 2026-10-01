import { describe, expect, it } from "vitest";
import type { ResolvedEntraApp } from "./app-registration.js";
import { classifyAppTestFailure, redactDetail, testAppRegistration } from "./app-test.js";
import { GRAPH_APPLICATION_PERMISSIONS, REQUIRED_PERMISSIONS } from "./permissions.js";

const SECRET = "Xy7~secret.value_1234567890abcdefghijklmn";

const app: ResolvedEntraApp = {
  source: "database",
  credentials: {
    clientId: "11111111-2222-3333-4444-555555555555",
    credential: { type: "secret", clientSecret: SECRET },
  },
  credentialKind: "secret",
  expiresAt: null,
  certificate: null,
  homeTenantId: "contoso.onmicrosoft.com",
  updatedAt: null,
  updatedBy: null,
  fingerprint: "f",
};

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.signature`;
}

/** A token endpoint that answers once, recording what it was asked. */
function tokenEndpoint(status: number, body: unknown) {
  const calls: { url: string; params: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), params: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function entraError(code: number, description: string) {
  return {
    error: "invalid_client",
    error_description: `AADSTS${code}: ${description} Trace ID: 0000 Correlation ID: 1111`,
    error_codes: [code],
  };
}

describe("testAppRegistration", () => {
  it("is green when every required application permission is in the token", async () => {
    const endpoint = tokenEndpoint(200, {
      access_token: jwt({ roles: [...REQUIRED_PERMISSIONS, "Sites.Read.All"] }),
      expires_in: 3600,
    });
    const result = await testAppRegistration({
      app,
      tenantId: "contoso.onmicrosoft.com",
      fetchImpl: endpoint.fetchImpl,
    });
    expect(result).toMatchObject({
      ok: true,
      tokenAcquired: true,
      reason: null,
      tenantId: "contoso.onmicrosoft.com",
      clientId: app.credentials.clientId,
      source: "database",
      credentialKind: "secret",
    });
    expect(result.permissions?.missing).toEqual([]);
    expect(result.permissions?.unexpected).toEqual(["Sites.Read.All"]);
    expect(endpoint.calls[0]?.url).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
    );
    expect(endpoint.calls[0]?.params.get("scope")).toBe("https://graph.microsoft.com/.default");
  });

  it("names missing permissions and the Mail.Read pitfall", async () => {
    const roles = REQUIRED_PERMISSIONS.filter(
      (permission) => permission !== "Mail.ReadWrite" && permission !== "Group.Read.All",
    );
    const endpoint = tokenEndpoint(200, { access_token: jwt({ roles: [...roles, "Mail.Read"] }) });
    const result = await testAppRegistration({
      app,
      tenantId: "contoso.onmicrosoft.com",
      fetchImpl: endpoint.fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("permissions_missing");
    expect(result.permissions?.missing).toEqual(["Mail.ReadWrite", "Group.Read.All"]);
    expect(result.permissions?.readOnlyInstead).toEqual([
      { expected: "Mail.ReadWrite", granted: "Mail.Read" },
    ]);
    expect(result.permissions?.checks).toHaveLength(GRAPH_APPLICATION_PERMISSIONS.length);
  });

  it("reads a token without any application permission as missing admin consent", async () => {
    const endpoint = tokenEndpoint(200, { access_token: jwt({ aud: "graph" }) });
    const result = await testAppRegistration({
      app,
      tenantId: "contoso.onmicrosoft.com",
      fetchImpl: endpoint.fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, tokenAcquired: true, reason: "consent_missing" });
  });

  const refusals: [number, string][] = [
    [7000215, "invalid_secret"],
    [7000222, "secret_expired"],
    [700016, "app_not_found"],
    [90002, "tenant_not_found"],
    [900023, "tenant_not_found"],
    [7000218, "credential_missing"],
    [700027, "invalid_certificate"],
    [65001, "consent_missing"],
    [50034, "other"],
  ];

  for (const [code, reason] of refusals) {
    it(`maps AADSTS${code} to ${reason}`, async () => {
      const endpoint = tokenEndpoint(401, entraError(code, "Refused."));
      const result = await testAppRegistration({
        app,
        tenantId: "contoso.onmicrosoft.com",
        fetchImpl: endpoint.fetchImpl,
      });
      expect(result).toMatchObject({
        ok: false,
        tokenAcquired: false,
        reason,
        aadsts: `AADSTS${code}`,
        permissions: null,
      });
      expect(result.detail).toContain(`AADSTS${code}`);
    });
  }

  it("never passes the secret on, even when Entra echoes it", async () => {
    const endpoint = tokenEndpoint(401, entraError(7000215, `Invalid client secret ${SECRET}.`));
    const result = await testAppRegistration({
      app,
      tenantId: "contoso.onmicrosoft.com",
      fetchImpl: endpoint.fetchImpl,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.detail).toContain("[redacted]");
  });

  it("reports an unreachable endpoint as a network problem", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    }) as unknown as typeof fetch;
    const result = await testAppRegistration({ app, tenantId: "contoso.com", fetchImpl });
    expect(result).toMatchObject({
      ok: false,
      reason: "network",
      aadsts: null,
      detail: "fetch failed (ENOTFOUND)",
    });
  });

  it("gives up after the timeout", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const result = await testAppRegistration({
      app,
      tenantId: "contoso.com",
      fetchImpl,
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      reason: "network",
      detail: "The token endpoint did not answer in time.",
    });
  });
});

describe("classifyAppTestFailure / redactDetail", () => {
  it("treat anything that is not an Entra answer as a network problem", () => {
    expect(classifyAppTestFailure(new Error("socket hang up"))).toEqual({
      reason: "network",
      aadsts: null,
      detail: "socket hang up",
    });
  });

  it("bound long messages", () => {
    expect(redactDetail("x".repeat(700), [])?.length).toBe(501);
    expect(redactDetail("  ", [])).toBeNull();
  });
});
