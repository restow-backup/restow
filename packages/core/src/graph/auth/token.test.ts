import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { must } from "../testing/fake-graph.js";
import {
  CachingTokenProvider,
  ClientCredentialsTokenProvider,
  TenantTokenProviders,
  TokenAcquisitionError,
  buildClientAssertion,
  certificateThumbprintSha1Hex,
  derFromPem,
  tokenEndpointFor,
} from "./token.js";

function tokenEndpointFake(
  answer: (params: URLSearchParams, callIndex: number) => { status: number; json: unknown },
) {
  const calls: URLSearchParams[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const params = new URLSearchParams(String(init?.body ?? ""));
    calls.push(params);
    const { status, json } = answer(params, calls.length - 1);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("client credentials with a secret", () => {
  it("posts the grant to the tenant's v2.0 endpoint and caches until shortly before expiry", async () => {
    let now = 1_000_000;
    const endpoint = tokenEndpointFake(() => ({
      status: 200,
      json: { token_type: "Bearer", expires_in: 3600, access_token: "tok-1" },
    }));
    const provider = new ClientCredentialsTokenProvider({
      tenantId: "contoso.onmicrosoft.com",
      app: { clientId: "app-id", credential: { type: "secret", clientSecret: "s3cr3t" } },
      fetchImpl: endpoint.fetchImpl,
      now: () => now,
    });

    expect(await provider.getToken()).toBe("tok-1");
    expect(await provider.getToken()).toBe("tok-1");
    expect(endpoint.calls).toHaveLength(1);
    const params = must(endpoint.calls[0]);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("client_id")).toBe("app-id");
    expect(params.get("client_secret")).toBe("s3cr3t");
    expect(params.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(tokenEndpointFor("contoso.onmicrosoft.com")).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
    );

    // Five minutes before expiry the token is refreshed.
    now += (3600 - 200) * 1000;
    expect(await provider.getToken()).toBe("tok-1");
    expect(endpoint.calls).toHaveLength(2);
  });

  it("refuses to follow redirects, so the secret is never re-sent to another host", async () => {
    let redirect: RequestInit["redirect"];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(JSON.stringify({ expires_in: 3600, access_token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const provider = new ClientCredentialsTokenProvider({
      tenantId: "t",
      app: { clientId: "c", credential: { type: "secret", clientSecret: "x" } },
      fetchImpl,
    });

    await provider.getToken();
    expect(redirect).toBe("error");
  });

  it("coalesces concurrent refreshes into one request", async () => {
    const endpoint = tokenEndpointFake((_, index) => ({
      status: 200,
      json: { expires_in: 3600, access_token: `tok-${index}` },
    }));
    const provider = new ClientCredentialsTokenProvider({
      tenantId: "t",
      app: { clientId: "c", credential: { type: "secret", clientSecret: "x" } },
      fetchImpl: endpoint.fetchImpl,
    });
    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);
    expect(tokens).toEqual(["tok-0", "tok-0", "tok-0"]);
    expect(endpoint.calls).toHaveLength(1);
  });

  it("raises a TokenAcquisitionError carrying Entra's code, never the secret", async () => {
    const endpoint = tokenEndpointFake(() => ({
      status: 401,
      json: {
        error: "invalid_client",
        error_description: "AADSTS7000215: Invalid client secret provided.",
        correlation_id: "corr-1",
      },
    }));
    const provider = new ClientCredentialsTokenProvider({
      tenantId: "t",
      app: { clientId: "c", credential: { type: "secret", clientSecret: "super-secret-value" } },
      fetchImpl: endpoint.fetchImpl,
    });
    const error = await provider.getToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenAcquisitionError);
    expect((error as TokenAcquisitionError).code).toBe("invalid_client");
    expect((error as TokenAcquisitionError).status).toBe(401);
    expect((error as TokenAcquisitionError).correlationId).toBe("corr-1");
    expect((error as Error).message).toContain("AADSTS7000215");
    expect((error as Error).message).not.toContain("super-secret-value");
  });

  it("memoises one provider per tenant", () => {
    const providers = new TenantTokenProviders({
      clientId: "c",
      credential: { type: "secret", clientSecret: "x" },
    });
    const a = providers.forTenant("tenant-a");
    expect(providers.forTenant("tenant-a")).toBe(a);
    expect(providers.forTenant("tenant-b")).not.toBe(a);
    providers.forget("tenant-a");
    expect(providers.forTenant("tenant-a")).not.toBe(a);
  });
});

describe("client credentials with a certificate", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const thumbprintHex = createHash("sha1").update("fake-der").digest("hex");

  it("builds an RS256 client assertion with the x5t thumbprint that verifies with the public key", () => {
    const assertion = buildClientAssertion({
      clientId: "app-id",
      audience: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      credential: {
        type: "certificate",
        privateKeyPem,
        thumbprintSha1Hex: thumbprintHex.toUpperCase(),
      },
      nowMs: 1_700_000_000_000,
    });
    const [header, claims, signature] = assertion.split(".");
    const decodedHeader = JSON.parse(Buffer.from(must(header), "base64url").toString());
    const decodedClaims = JSON.parse(Buffer.from(must(claims), "base64url").toString());

    expect(decodedHeader).toEqual({
      alg: "RS256",
      typ: "JWT",
      x5t: Buffer.from(thumbprintHex, "hex").toString("base64url"),
    });
    expect(decodedClaims).toMatchObject({
      aud: "https://login.microsoftonline.com/t/oauth2/v2.0/token",
      iss: "app-id",
      sub: "app-id",
      nbf: 1_700_000_000,
      exp: 1_700_000_600,
    });
    expect(typeof decodedClaims.jti).toBe("string");
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(must(signature), "base64url"));
    expect(verified).toBe(true);
  });

  it("derives the thumbprint from a PEM certificate", () => {
    const der = Buffer.from("fake-der");
    const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----\n`;
    expect(derFromPem(pem)).toEqual(der);
    expect(certificateThumbprintSha1Hex(pem)).toBe(thumbprintHex);
    expect(() => derFromPem("not a pem")).toThrow();
  });

  it("sends the assertion instead of a secret", async () => {
    const endpoint = tokenEndpointFake(() => ({
      status: 200,
      json: { expires_in: "3599", access_token: "tok-cert" },
    }));
    const provider = new ClientCredentialsTokenProvider({
      tenantId: "t",
      app: {
        clientId: "app-id",
        credential: { type: "certificate", privateKeyPem, thumbprintSha1Hex: thumbprintHex },
      },
      fetchImpl: endpoint.fetchImpl,
    });
    expect(await provider.getToken()).toBe("tok-cert");
    const params = must(endpoint.calls[0]);
    expect(params.get("client_secret")).toBeNull();
    expect(params.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(params.get("client_assertion")?.split(".")).toHaveLength(3);
  });
});

describe("CachingTokenProvider.fromAcquirer", () => {
  it("wraps an external acquirer (msal) and honours invalidate()", async () => {
    let acquisitions = 0;
    const provider = CachingTokenProvider.fromAcquirer(async () => {
      acquisitions += 1;
      return { accessToken: `t${acquisitions}`, expiresAtMs: Date.now() + 3_600_000 };
    });
    expect(await provider.getToken()).toBe("t1");
    expect(await provider.getToken()).toBe("t1");
    provider.invalidate();
    expect(await provider.getToken()).toBe("t2");
  });
});
