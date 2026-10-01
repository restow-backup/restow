import { describe, expect, it } from "vitest";
import {
  GOOGLE_TOKEN_ENDPOINT,
  OAuth2Error,
  parseOAuth2Secret,
  refreshAccessToken,
  resolveScope,
  resolveTokenEndpoint,
} from "./oauth2.js";

const microsoft = parseOAuth2Secret(
  JSON.stringify({
    provider: "microsoft",
    refreshToken: "rt-1",
    clientId: "client",
    clientSecret: "shh-not-real",
    tenantId: "contoso.onmicrosoft.com",
  }),
);

describe("parseOAuth2Secret", () => {
  it("validates the required fields without echoing values", () => {
    expect(() => parseOAuth2Secret("not json")).toThrow(OAuth2Error);
    expect(() => parseOAuth2Secret(JSON.stringify({ provider: "x" }))).toThrow(/provider/);
    expect(() => parseOAuth2Secret(JSON.stringify({ provider: "google" }))).toThrow(
      /refreshToken is required/,
    );
    expect(() =>
      parseOAuth2Secret(JSON.stringify({ provider: "custom", refreshToken: "a", clientId: "b" })),
    ).toThrow(/tokenEndpoint/);
    try {
      parseOAuth2Secret(JSON.stringify({ provider: "google", refreshToken: "top-secret-value" }));
    } catch (error) {
      expect((error as Error).message).not.toContain("top-secret-value");
    }
  });

  it("derives endpoints and scopes per provider", () => {
    expect(resolveTokenEndpoint(microsoft)).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
    );
    expect(resolveScope(microsoft)).toContain("IMAP.AccessAsUser.All");
    const google = parseOAuth2Secret(
      JSON.stringify({ provider: "google", refreshToken: "rt", clientId: "c" }),
    );
    expect(resolveTokenEndpoint(google)).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(resolveScope(google)).toBe("https://mail.google.com/");
    const custom = parseOAuth2Secret(
      JSON.stringify({
        provider: "custom",
        refreshToken: "rt",
        clientId: "c",
        tokenEndpoint: "https://idp.example.test/token",
        scope: "imap",
      }),
    );
    expect(resolveTokenEndpoint(custom)).toBe("https://idp.example.test/token");
    expect(resolveScope(custom)).toBe("imap");
  });
});

describe("refreshAccessToken", () => {
  it("posts a refresh_token grant and reports a rotated refresh token", async () => {
    let seen: { url: string; body: URLSearchParams } | null = null;
    const token = await refreshAccessToken(microsoft, {
      now: () => 1_000_000,
      fetch: async (url, init) => {
        seen = { url, body: new URLSearchParams(String(init.body)) };
        return Response.json({ access_token: "at", expires_in: 600, refresh_token: "rt-2" });
      },
    });
    expect(token).toEqual({ accessToken: "at", expiresAt: 1_600_000, rotatedRefreshToken: "rt-2" });
    const request = seen as unknown as { url: string; body: URLSearchParams };
    expect(request.url).toContain("contoso.onmicrosoft.com");
    expect(request.body.get("grant_type")).toBe("refresh_token");
    expect(request.body.get("refresh_token")).toBe("rt-1");
    expect(request.body.get("client_secret")).toBe("shh-not-real");
    expect(request.body.get("scope")).toContain("offline_access");
  });

  it("does not report rotation when the same refresh token comes back", async () => {
    const token = await refreshAccessToken(microsoft, {
      fetch: async () => Response.json({ access_token: "at", refresh_token: "rt-1" }),
    });
    expect(token.rotatedRefreshToken).toBeNull();
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it("surfaces provider errors with status and code", async () => {
    await expect(
      refreshAccessToken(microsoft, {
        fetch: async () =>
          Response.json(
            { error: "invalid_grant", error_description: "AADSTS70000: token expired" },
            { status: 400 },
          ),
      }),
    ).rejects.toMatchObject({ name: "OAuth2Error", status: 400, code: "invalid_grant" });
  });

  it("wraps network failures", async () => {
    await expect(
      refreshAccessToken(microsoft, {
        fetch: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ name: "OAuth2Error", code: "network" });
  });
});
