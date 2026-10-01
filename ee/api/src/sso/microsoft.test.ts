/**
 * The Microsoft (Entra ID) sign-in of the Business module (./config.ts),
 * registered into the core's better-auth instance through the auth extension
 * point exactly as apps/api/src/ee.ts does:
 *
 *   - it creates no user for an unknown Entra account, not even when the
 *     client asks for a sign-up, while a user whose Microsoft account is
 *     linked keeps signing in;
 *   - a signed-in user cannot set their own Entra identity.
 *
 * The Microsoft identity platform is an in-process fake: `fetch` is stubbed
 * before the auth module loads (the provider reads its OIDC discovery document
 * on start), and it answers only the discovery, token and userinfo requests the
 * sign-in makes. No request leaves the test.
 *
 * The configuration test always runs. The ones that need a database run when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the suite
 * creates a database and two roles and drops them again); skipped otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createDb } from "@restow/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as AuthModule from "../../../../apps/api/src/auth.js";
import {
  registerAuthExtension,
  resetExtensionsForTesting,
} from "../../../../apps/api/src/extensions.js";
import { dropDatabase } from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import {
  type TestDatabaseRoles,
  provisionTestRoles,
} from "../../../../apps/api/src/testing/database-roles.js";
import { MICROSOFT_DISCOVERY_URL, MICROSOFT_PROVIDER_ID, microsoftSignIn } from "./config.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

const PUBLIC_URL = "http://localhost:3000";
const DATABASE = `restow_ee_sso_test_${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// A fake Microsoft identity platform
// ---------------------------------------------------------------------------

/** Discovery documents of Entra ID live below this origin (see MICROSOFT_DISCOVERY_URL). */
const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com/";
/** The fake's own endpoints, on a reserved domain that never resolves. */
const FAKE_IDP = {
  issuer: "https://identity.invalid/fake-tenant/v2.0",
  authorize: "https://identity.invalid/oauth2/v2.0/authorize",
  token: "https://identity.invalid/oauth2/v2.0/token",
  userInfo: "https://identity.invalid/oidc/userinfo",
};

interface FakeProfile {
  sub: string;
  email: string;
  name: string;
  email_verified: boolean;
}

interface FakeIdentityPlatform {
  /** Who the next userinfo request says signed in. */
  profile: FakeProfile | null;
  /** Every URL the auth module requested, in order. */
  requests: string[];
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(platform: FakeIdentityPlatform): typeof fetch {
  return async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    platform.requests.push(url);
    if (
      url.startsWith(MICROSOFT_LOGIN_ORIGIN) &&
      url.endsWith("/.well-known/openid-configuration")
    ) {
      return json({
        issuer: FAKE_IDP.issuer,
        authorization_endpoint: FAKE_IDP.authorize,
        token_endpoint: FAKE_IDP.token,
        userinfo_endpoint: FAKE_IDP.userInfo,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (url === FAKE_IDP.token) {
      return json({
        access_token: randomBytes(24).toString("base64url"),
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url === FAKE_IDP.userInfo && platform.profile) {
      return json(platform.profile);
    }
    // Anything else would have gone to the network.
    throw new TypeError(`fetch failed: the fake identity platform does not serve ${url}`);
  };
}

/** A loopback port nothing listens on: bound once by the OS, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("no port assigned");
  }
  return address.port;
}

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

// ---------------------------------------------------------------------------
// Setup: the API's auth module on the suite's database (or on none)
// ---------------------------------------------------------------------------

const platform: FakeIdentityPlatform = { profile: null, requests: [] };
let authModule: typeof AuthModule;
let auth: (typeof AuthModule)["auth"];
let owner: ReturnType<typeof createDb> | undefined;
let roles: TestDatabaseRoles | undefined;

beforeAll(async () => {
  vi.stubGlobal("fetch", fakeFetch(platform));
  if (adminUrl) {
    const admin = createDb(adminUrl);
    try {
      await admin.$client.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.$client.end();
    }
    const ownerUrl = urlFor(adminUrl, DATABASE);
    roles = await provisionTestRoles(ownerUrl);
    owner = createDb(ownerUrl);
    vi.stubEnv("DATABASE_URL", roles.appUrl);
    vi.stubEnv("DATABASE_PROVIDER_URL", roles.providerUrl);
  } else {
    // The configuration tests never query; any query would fail like in an outage.
    const unreachable = `postgres://restow:unused@127.0.0.1:${await closedPort()}/restow`;
    vi.stubEnv("DATABASE_URL", unreachable);
    vi.stubEnv("DATABASE_PROVIDER_URL", unreachable);
  }
  vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(32).toString("base64url"));
  vi.stubEnv("RESTOW_PUBLIC_URL", PUBLIC_URL);
  vi.stubEnv("ENTRA_SSO_CLIENT_ID", randomUUID());
  vi.stubEnv("ENTRA_SSO_CLIENT_SECRET", randomBytes(24).toString("base64url"));
  // The Business auth entry reads the configuration on import, so it loads
  // after the environment is set, and registers before the core builds its
  // better-auth instance, exactly as apps/api/src/ee.ts does.
  const { eeAuthExtension } = await import("../auth.js");
  registerAuthExtension(eeAuthExtension);
  // The API reads its configuration and opens its pools on import.
  authModule = await import("../../../../apps/api/src/auth.js");
  auth = authModule.auth;
  await auth.$context;
});

afterAll(async () => {
  const { db, providerDb } = await import("../../../../apps/api/src/db.js");
  await Promise.all([db.$client.end(), providerDb.$client.end(), owner?.$client.end()]);
  if (adminUrl) {
    await dropDatabase(adminUrl, DATABASE);
    await roles?.drop(adminUrl);
  }
  vi.unstubAllEnvs();
  resetExtensionsForTesting();
  vi.unstubAllGlobals();
});

/** The parts of the resolved auth context these tests look at. */
interface InspectedContext {
  rateLimit: { enabled: boolean; storage: string };
  socialProviders: unknown;
  checkSchema?: () => Promise<void> | undefined;
}

async function context(): Promise<InspectedContext> {
  return (await auth.$context) as unknown as InspectedContext;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("the Microsoft sign-in configuration", () => {
  it("configures the Microsoft sign-in so that it never creates a user", async () => {
    const provider = microsoftSignIn({
      ssoClientId: "client-id",
      ssoClientSecret: "client-secret",
    });
    expect(provider).toMatchObject({
      providerId: MICROSOFT_PROVIDER_ID,
      discoveryUrl: MICROSOFT_DISCOVERY_URL,
      disableImplicitSignUp: true,
      disableSignUp: true,
    });
    expect(MICROSOFT_DISCOVERY_URL.startsWith(MICROSOFT_LOGIN_ORIGIN)).toBe(true);

    // The running instance registered it that way (after discovery, served by the fake).
    expect(platform.requests).toContain(MICROSOFT_DISCOVERY_URL);
    const providers = (await (
      await context()
    ).socialProviders) as {
      id: string;
      disableImplicitSignUp?: boolean;
      options?: { disableSignUp?: boolean };
    }[];
    expect(providers.find((p) => p.id === MICROSOFT_PROVIDER_ID)).toMatchObject({
      disableImplicitSignUp: true,
      options: { disableSignUp: true },
    });
  });
});

// ---------------------------------------------------------------------------
// On Postgres
// ---------------------------------------------------------------------------

function ownerDb(): NonNullable<typeof owner> {
  if (!owner) {
    throw new Error("the Postgres suite needs RESTOW_TEST_DATABASE_URL");
  }
  return owner;
}

async function query<R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  return (await ownerDb().$client.query<R>(text, values)).rows;
}

describe.skipIf(!adminUrl)("Microsoft sign-in on Postgres", () => {
  const clientIp = "198.51.100.40";

  /** Start the sign-in, then come back from the (fake) Microsoft login with a code. */
  async function signInWithMicrosoft(
    profile: FakeProfile,
    body: Record<string, unknown> = {},
  ): Promise<Response> {
    platform.profile = profile;
    const start = await auth.handler(
      new Request(`${PUBLIC_URL}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": clientIp,
        },
        body: JSON.stringify({
          provider: MICROSOFT_PROVIDER_ID,
          callbackURL: "/",
          disableRedirect: true,
          ...body,
        }),
      }),
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorize = new URL(url);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(FAKE_IDP.authorize);
    const state = authorize.searchParams.get("state") ?? "";
    const cookies = start.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    const callback = new URL(`${PUBLIC_URL}/api/auth/callback/${MICROSOFT_PROVIDER_ID}`);
    callback.searchParams.set("code", randomBytes(16).toString("base64url"));
    callback.searchParams.set("state", state);
    return auth.handler(
      new Request(callback, { headers: { cookie: cookies, "x-forwarded-for": clientIp } }),
    );
  }

  function person(name: string): FakeProfile {
    const local = `${name}-${randomBytes(3).toString("hex")}`;
    return { sub: randomUUID(), email: `${local}@contoso.test`, name, email_verified: true };
  }

  async function usersNamed(email: string): Promise<number> {
    const rows = await query<{ count: string }>(
      'SELECT count(*) AS count FROM "user" WHERE email = $1',
      [email],
    );
    return Number(rows[0]?.count);
  }

  async function accountsOf(accountId: string): Promise<number> {
    const rows = await query<{ count: string }>(
      "SELECT count(*) AS count FROM account WHERE provider_id = $1 AND account_id = $2",
      [MICROSOFT_PROVIDER_ID, accountId],
    );
    return Number(rows[0]?.count);
  }

  function errorOf(response: Response): string | null {
    const location = response.headers.get("location");
    return location ? new URL(location, PUBLIC_URL).searchParams.get("error") : null;
  }

  it("creates no user for an unknown Entra account", async () => {
    const stranger = person("Stranger");
    const response = await signInWithMicrosoft(stranger);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBe("signup_disabled");
    expect(await usersNamed(stranger.email)).toBe(0);
    expect(await accountsOf(stranger.sub)).toBe(0);
    // It really reached the provider: the refusal is Restow's, not a failed exchange.
    expect(platform.requests).toContain(FAKE_IDP.userInfo);
  });

  it("creates no user even when the client asks for a sign-up", async () => {
    const stranger = person("Insistent Stranger");
    const response = await signInWithMicrosoft(stranger, { requestSignUp: true });

    expect(errorOf(response)).toBe("signup_disabled");
    expect(await usersNamed(stranger.email)).toBe(0);
    expect(await accountsOf(stranger.sub)).toBe(0);
  });

  /** A user Restow already knows, with their Microsoft account linked. */
  async function linkedUser(name: string): Promise<{ profile: FakeProfile; userId: string }> {
    const profile = person(name);
    const userId = randomUUID();
    await query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [
      userId,
      profile.name,
      profile.email,
    ]);
    await query(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [randomUUID(), profile.sub, MICROSOFT_PROVIDER_ID, userId],
    );
    return { profile, userId };
  }

  function sessionCookieOf(response: Response): string {
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .find((pair) => pair.includes("session_token="));
    if (!cookie) {
      throw new Error("the sign-in set no session cookie");
    }
    return cookie;
  }

  it("keeps signing in a user whose Microsoft account is linked", async () => {
    const { profile, userId } = await linkedUser("Adele Vance");

    const response = await signInWithMicrosoft(profile);

    expect(response.status).toBe(302);
    expect(errorOf(response)).toBeNull();
    expect(response.headers.get("location")).toBe("/");
    expect(sessionCookieOf(response)).toBeTruthy();
    const sessions = await query<{ count: string }>(
      "SELECT count(*) AS count FROM session WHERE user_id = $1",
      [userId],
    );
    expect(Number(sessions[0]?.count)).toBe(1);
    expect(await usersNamed(profile.email)).toBe(1);
  });

  it("refuses a signed-in user who tries to set their own Entra identity", async () => {
    const { profile, userId } = await linkedUser("Alex Wilber");
    const cookie = sessionCookieOf(await signInWithMicrosoft(profile));

    const response = await auth.handler(
      new Request(`${PUBLIC_URL}/api/auth/update-user`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          cookie,
          "x-forwarded-for": clientIp,
        },
        body: JSON.stringify({ entraTenantId: randomUUID(), entraObjectId: randomUUID() }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "FIELD_NOT_ALLOWED" });
    const [stored] = await query<{
      entra_tenant_id: string | null;
      entra_object_id: string | null;
    }>('SELECT entra_tenant_id, entra_object_id FROM "user" WHERE id = $1', [userId]);
    expect(stored).toEqual({ entra_tenant_id: null, entra_object_id: null });
  });
});
