import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ licensed: false, experimental: true }));

vi.mock("../../../../apps/api/src/db.js", () => ({ db: {} }));
vi.mock("../../../../apps/api/src/config.js", () => ({
  config: {
    entra: {
      ssoClientId: "sso-app-id",
      ssoClientSecret: "sso-app-credential",
      get ssoExperimental() {
        return state.experimental;
      },
    },
  },
}));
vi.mock("../license/gate.js", () => ({
  hasCapability: async (_db: unknown, capability: string) =>
    capability === "auth.microsoftSso" && state.licensed,
}));

const { microsoftSignInGuard, microsoftSignInProvider } = await import("./access.js");

/** The guard in front of a stand-in for better-auth, mounted the way apps/api/src/app.ts does. */
function app(): Hono {
  const hono = new Hono();
  for (const path of microsoftSignInGuard.paths) {
    hono.use(path, microsoftSignInGuard.handler);
  }
  hono.all("/api/auth/*", (c) => c.text("better-auth"));
  return hono;
}

const PUBLIC = { operatingMode: "public" as const, publicUrl: "https://restow.example.com" };

beforeEach(() => {
  state.licensed = false;
  state.experimental = true;
});

describe("the Microsoft sign-in guard", () => {
  it("answers 404 on every Microsoft sign-in path without the capability", async () => {
    for (const path of [
      "/api/auth/sign-in/social",
      "/api/auth/sign-in/oauth2",
      "/api/auth/oauth2/callback/microsoft",
      "/api/auth/callback/microsoft",
      "/api/auth/link-social",
    ]) {
      const res = await app().request(path, { method: "POST" });
      expect(res.status, path).toBe(404);
    }
  });

  it("hands the request to better-auth with the capability", async () => {
    state.licensed = true;
    const res = await app().request("/api/auth/callback/microsoft");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("better-auth");
  });

  it("answers 404 without the experimental switch, licensed or not", async () => {
    state.licensed = true;
    state.experimental = false;
    for (const path of ["/api/auth/sign-in/social", "/api/auth/callback/microsoft"]) {
      const res = await app().request(path, { method: "POST" });
      expect(res.status, path).toBe(404);
    }
  });

  it("leaves every other sign-in path alone", async () => {
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/passkey/generate-authenticate-options",
    ]) {
      const res = await app().request(path, { method: "POST" });
      expect(res.status, path).toBe(200);
    }
  });
});

describe("the Microsoft sign-in provider", () => {
  it("is offered only when licensed and configured for a public installation", async () => {
    expect(await microsoftSignInProvider.available(PUBLIC)).toBe(false);
    state.licensed = true;
    expect(await microsoftSignInProvider.available(PUBLIC)).toBe(true);
    expect(
      await microsoftSignInProvider.available({ operatingMode: "local", publicUrl: null }),
    ).toBe(false);
  });

  it("is never offered without the experimental switch, even licensed and configured", async () => {
    state.licensed = true;
    state.experimental = false;
    expect(await microsoftSignInProvider.available(PUBLIC)).toBe(false);
  });
});
