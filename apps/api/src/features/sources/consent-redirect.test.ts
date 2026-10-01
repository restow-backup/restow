import type { Database } from "@restow/db";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../../config.js";
import { errorHandler } from "../../problem.js";
import { scriptedDb } from "../../routes/v1/testing/scripted-db.js";
import type { ConsentCallbackOutcome } from "./service.js";

/**
 * Where the public admin-consent callback sends a signed-in operator. The
 * callback is reached by a top-level navigation, so the Origin, Referer and
 * forwarding headers name wherever the browser came from; the redirect must
 * only ever go to the configured public origin or stay on the origin the
 * request arrived at. The consent handling itself is replaced (its rules are
 * covered in service.test.ts); the public-origin lookup is the real one, on a
 * scripted settings row.
 */

const state = vi.hoisted(() => ({
  getSession: vi.fn(),
  handleConsentCallback: vi.fn(),
  db: null as unknown,
}));

vi.mock("../../auth.js", () => ({ auth: { api: { getSession: state.getSession } } }));
vi.mock("../../db.js", () => {
  const pool = new Proxy(
    {},
    { get: (_target, property) => (state.db as Record<PropertyKey, unknown>)[property] },
  );
  return { db: pool, providerDb: pool };
});
vi.mock("./service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  handleConsentCallback: state.handleConsentCallback,
}));

const { sourcesRoutes } = await import("./routes.js");

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";
const SOURCE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CALLBACK = "/api/v1/sources/m365/consent/callback?state=signed&admin_consent=True";

const granted: ConsentCallbackOutcome = {
  kind: "granted",
  tenantId: TENANT,
  sourceId: SOURCE,
  verification: null,
};

/** Headers a hostile page and a spoofing client can put on the navigation. */
const FOREIGN_HEADERS = {
  referer: "https://attacker.example/phish",
  origin: "https://attacker.example",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "attacker.example",
};

const configuredPublicUrl = config.publicUrl;

function app(settingsPublicUrl: string | null) {
  // resolvePublicOrigin reads the settings row once.
  const script = scriptedDb([settingsPublicUrl === null ? [] : [{ publicUrl: settingsPublicUrl }]]);
  state.db = script.db as Database;
  const hono = new Hono();
  hono.onError(errorHandler);
  hono.route("/api/v1/sources", sourcesRoutes);
  return hono;
}

async function redirectFor(settingsPublicUrl: string | null, headers: Record<string, string>) {
  const res = await app(settingsPublicUrl).request(`http://restow.internal:3000${CALLBACK}`, {
    headers,
  });
  expect(res.status).toBe(302);
  return res.headers.get("location") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  config.publicUrl = undefined;
  state.handleConsentCallback.mockResolvedValue(granted);
  // A signed-in operator finishes the round trip in the web app.
  state.getSession.mockResolvedValue({
    session: { id: "session-id", userId: "operator-id", authMethod: "passkey" },
    user: { id: "operator-id", email: "ops@provider.example", role: "admin" },
  });
});

afterEach(() => {
  config.publicUrl = configuredPublicUrl;
});

describe("the consent callback redirect without a configured public URL", () => {
  it("stays on the origin the request arrived at, whatever the headers claim", async () => {
    const location = await redirectFor(null, FOREIGN_HEADERS);
    expect(location).toBe(`/sources/${SOURCE}?consent=granted&tenant=${TENANT}`);
    expect(location).not.toContain("attacker.example");
  });

  it("never turns a protocol-relative path into another host", async () => {
    state.handleConsentCallback.mockResolvedValue({ kind: "invalid_state", reason: "expired" });
    const location = await redirectFor(null, FOREIGN_HEADERS);
    expect(location).toBe("/sources?consent=invalid_state&reason=expired");
    expect(location.startsWith("//")).toBe(false);
  });
});

describe("the consent callback redirect with a configured public URL", () => {
  it("uses the public URL from the settings", async () => {
    const location = await redirectFor("https://restow.example.com/", FOREIGN_HEADERS);
    expect(location).toBe(
      `https://restow.example.com/sources/${SOURCE}?consent=granted&tenant=${TENANT}`,
    );
  });

  it("uses the public URL from the environment", async () => {
    config.publicUrl = "https://backup.example.net";
    const location = await redirectFor(null, FOREIGN_HEADERS);
    expect(new URL(location).origin).toBe("https://backup.example.net");
  });
});

describe("the consent callback without a Restow session", () => {
  it("shows the landing page instead of redirecting", async () => {
    state.getSession.mockResolvedValue(null);
    const res = await app(null).request(CALLBACK, { headers: FOREIGN_HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});
