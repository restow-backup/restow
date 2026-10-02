/**
 * The better-auth configuration of the API (./auth.ts):
 *
 *   - the auth rate-limit counters are kept in Postgres (`rate_limit`), so a
 *     restart of the api resets none of them;
 *   - the Entra identity fields of a user are server-only, and the Drizzle
 *     schema holds every table and column better-auth writes.
 *
 * The Microsoft sign-in (a Business module) is tested in
 * ee/api/src/sso/microsoft.test.ts.
 *
 * The configuration tests always run. The ones that need a database run when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser (the suite
 * creates a database and two roles and drops them again); skipped otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createDb } from "@restow/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthModule from "./auth.js";
import { dropDatabase } from "./features/snapshots/testing/explorer-fixture.js";
import { AUTH_RATE_LIMIT } from "./lib/auth-surface.js";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./lib/password-policy.js";
import { type TestDatabaseRoles, provisionTestRoles } from "./testing/database-roles.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;

const PUBLIC_URL = "http://localhost:3000";
const DATABASE = `restow_api_auth_test_${randomBytes(4).toString("hex")}`;
/** The account security review finding 5 covers: configured, but demo mode stays off. */
const DEMO_EMAIL = "demo-disabled@example.test";

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

let authModule: typeof AuthModule;
let auth: (typeof AuthModule)["auth"];
let owner: ReturnType<typeof createDb> | undefined;
let roles: TestDatabaseRoles | undefined;

beforeAll(async () => {
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
  // Demo mode itself stays off for this whole file (RESTOW_DEMO is not set);
  // the configured demo email is enough to exercise the "disabled" refusal
  // below without touching every other test's sign-in flow.
  vi.stubEnv("RESTOW_DEMO_EMAIL", DEMO_EMAIL);
  // The API reads its configuration and opens its pools on import.
  authModule = await import("./auth.js");
  auth = authModule.auth;
  await auth.$context;
});

afterAll(async () => {
  const { db, providerDb } = await import("./db.js");
  await Promise.all([db.$client.end(), providerDb.$client.end(), owner?.$client.end()]);
  if (adminUrl) {
    await dropDatabase(adminUrl, DATABASE);
    await roles?.drop(adminUrl);
  }
  vi.unstubAllEnvs();
});

/** The parts of the resolved auth context these tests look at. */
interface InspectedContext {
  rateLimit: { enabled: boolean; storage: string };
  password: { config: { minPasswordLength: number; maxPasswordLength: number } };
  checkSchema?: () => Promise<void> | undefined;
}

async function context(): Promise<InspectedContext> {
  return (await auth.$context) as unknown as InspectedContext;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("auth options", () => {
  it("keeps the rate limits of the auth surface, with the counters in the database", async () => {
    expect(auth.options.rateLimit).toEqual({ ...AUTH_RATE_LIMIT, storage: "database" });
    expect((await context()).rateLimit).toMatchObject({ enabled: true, storage: "database" });
  });

  it("takes the password length limits from the password policy, not from better-auth", async () => {
    // better-auth defaults to 128 characters and, since 1.7.6, refuses a longer
    // password on sign-in too. Restow accepts up to MAX_PASSWORD_LENGTH (setup
    // wizard, admin recovery), so an account with a 129-256 character password
    // must keep signing in. The release notes state these two limits.
    expect(auth.options.emailAndPassword).toMatchObject({
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
    });
    expect((await context()).password.config).toEqual({
      minPasswordLength: 12,
      maxPasswordLength: 256,
    });
    expect(MAX_PASSWORD_LENGTH).toBeGreaterThan(128);
  });

  it("lets only the server set a user's Entra identity", () => {
    expect(auth.options.user?.additionalFields).toEqual({
      entraObjectId: { type: "string", required: false, input: false },
      entraTenantId: { type: "string", required: false, input: false },
    });
  });

  it("finds every table and column better-auth writes in the Drizzle schema", async () => {
    // The check compares the options with the Drizzle schema in memory; a
    // missing `rate_limit` table or Entra column would reject every request.
    const check = (await context()).checkSchema;
    expect(check).toBeTypeOf("function");
    await expect(Promise.resolve(check?.())).resolves.toBeUndefined();
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

function signInWithPassword(clientIp: string): Promise<Response> {
  return auth.handler(
    new Request(`${PUBLIC_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: PUBLIC_URL,
        "x-forwarded-for": clientIp,
      },
      body: JSON.stringify({ email: "nobody@example.test", password: randomUUID() }),
    }),
  );
}

describe.skipIf(!adminUrl)("auth rate limits on Postgres", () => {
  beforeEach(async () => {
    await query("DELETE FROM rate_limit");
  });

  it("stores one counter per client and endpoint in the rate_limit table", async () => {
    const clientIp = "198.51.100.23";
    for (const attempt of [1, 2]) {
      const response = await signInWithPassword(clientIp);
      expect(response.status, `attempt ${attempt}`).not.toBe(429);
    }
    const rows = await query<{ key: string; count: number }>("SELECT key, count FROM rate_limit");
    expect(rows).toEqual([{ key: `${clientIp}|/sign-in/email`, count: 2 }]);
  });

  it("enforces a counter that outlived a restart of the api", async () => {
    const clientIp = "198.51.100.24";
    expect((await signInWithPassword(clientIp)).status).not.toBe(429);
    // What a previous api process left behind: the password window used up just now.
    const allowed = AUTH_RATE_LIMIT.customRules["/sign-in/email"].max;
    await query("UPDATE rate_limit SET count = $1, last_request = $2 WHERE key = $3", [
      allowed,
      Date.now(),
      `${clientIp}|/sign-in/email`,
    ]);

    const limited = await signInWithPassword(clientIp);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("x-retry-after"))).toBeGreaterThan(0);
    // Another client is not affected.
    expect((await signInWithPassword("198.51.100.25")).status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// The configured demo account while demo mode is off (security review finding 5)
// ---------------------------------------------------------------------------

describe.skipIf(!adminUrl)("the configured demo account, demo mode off, on Postgres", () => {
  async function passwordAccount(email: string, password: string): Promise<string> {
    const userId = randomUUID();
    const context = (await auth.$context) as unknown as {
      password: { hash(value: string): Promise<string> };
    };
    await query('INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)', [
      userId,
      email,
      email,
    ]);
    await query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $3, $4, now(), now())`,
      [randomUUID(), userId, userId, await context.password.hash(password)],
    );
    return userId;
  }

  function signInWithPassword(
    email: string,
    password: string,
    clientIp: string,
  ): Promise<Response> {
    return auth.handler(
      new Request(`${PUBLIC_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": clientIp,
        },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  it("refuses a password sign-in for RESTOW_DEMO_EMAIL while RESTOW_DEMO is not set", async () => {
    const password = randomBytes(12).toString("base64url");
    await passwordAccount(DEMO_EMAIL, password);

    const response = await signInWithPassword(DEMO_EMAIL, password, "198.51.100.60");

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "DEMO_ACCOUNT_DISABLED" });
    // The session the underlying sign-in created is torn down, not left valid.
    const sessions = await query<{ count: string }>(
      'SELECT count(*) AS count FROM session s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1',
      [DEMO_EMAIL],
    );
    expect(Number(sessions[0]?.count)).toBe(0);
  });

  it("keeps signing in every other password account normally", async () => {
    const password = randomBytes(12).toString("base64url");
    const email = "operator@example.test";
    await passwordAccount(email, password);

    const response = await signInWithPassword(email, password, "198.51.100.61");

    expect(response.status).toBe(200);
    const sessions = await query<{ count: string }>(
      'SELECT count(*) AS count FROM session s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1',
      [email],
    );
    expect(Number(sessions[0]?.count)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Password length on sign-in (better-auth 1.7.6 checks the limit there too)
// ---------------------------------------------------------------------------

describe.skipIf(!adminUrl)("password length on sign-in, on Postgres", () => {
  async function createAccount(email: string, password: string): Promise<void> {
    const userId = randomUUID();
    const context = (await auth.$context) as unknown as {
      password: { hash(value: string): Promise<string> };
    };
    await query('INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)', [
      userId,
      email,
      email,
    ]);
    await query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES ($1, $2, 'credential', $3, $4, now(), now())`,
      [randomUUID(), userId, userId, await context.password.hash(password)],
    );
  }

  function signIn(email: string, password: string, clientIp: string): Promise<Response> {
    return auth.handler(
      new Request(`${PUBLIC_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": clientIp,
        },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  function passwordOf(length: number): string {
    return randomBytes(length).toString("base64url").slice(0, length);
  }

  // The admin recovery (cli/admin-recovery.ts) and the setup wizard accept up to
  // MAX_PASSWORD_LENGTH; with better-auth's own default of 128 these would be refused.
  it.each([
    [129, "198.51.100.70"],
    [200, "198.51.100.71"],
    [MAX_PASSWORD_LENGTH, "198.51.100.72"],
  ])("signs in with a password of %i characters", async (length, clientIp) => {
    const email = `password-${length}@example.test`;
    const password = passwordOf(length);
    await createAccount(email, password);

    const response = await signIn(email, password, clientIp);

    expect(response.status).toBe(200);
  });

  it("refuses a password above the policy maximum before checking it", async () => {
    const response = await signIn(
      "password-too-long@example.test",
      passwordOf(MAX_PASSWORD_LENGTH + 1),
      "198.51.100.73",
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "PASSWORD_TOO_LONG" });
  });
});
