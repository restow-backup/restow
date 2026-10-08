/**
 * Postgres-backed tests of two guards against locking oneself out, over HTTP
 * with real better-auth sessions:
 *
 *   - moving the authenticator app to a new phone (lib/authenticator-replace.ts):
 *     the old key and the old recovery codes keep working until the first code
 *     of the new key is confirmed; a wrong code changes nothing; after the
 *     confirmation only the new key signs in;
 *   - the passkey impact (features/settings/passkey-impact.ts): how many
 *     accounts could no longer sign in once passkeys stop working, and whether
 *     the requesting account is one of them.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser. Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { type Database, account, createDb, passkey, twoFactor, user } from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropDatabase } from "../features/snapshots/testing/explorer-fixture.js";
import { provisionTestRoles } from "../testing/database-roles.js";

const DATABASE = `restow_sign_in_safety_test_${randomBytes(4).toString("hex")}`;
const PUBLIC_URL = "http://localhost:3000";
const testDatabaseAdminUrl = process.env.RESTOW_TEST_DATABASE_URL;

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

describe.skipIf(!testDatabaseAdminUrl)("sign-in safety against Postgres", () => {
  let owner: Database;
  let app: Hono;
  let authModule: typeof import("../auth.js");
  const adminId = randomUUID();
  const adminEmail = "owner@provider.example";
  const password = "first-owner-password-1";
  let cookie: string;

  function authPost(path: string, body: unknown, withCookie?: string): Promise<Response> {
    return authModule.auth.handler(
      new Request(`${PUBLIC_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
          ...(withCookie ? { cookie: withCookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  function cookieOf(response: Response, name: string): string {
    const pair = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .find((candidate) => candidate.includes(`${name}=`) && !candidate.endsWith("="));
    if (!pair) {
      throw new Error(`no ${name} cookie (status ${response.status})`);
    }
    return pair;
  }

  async function storedSecret(): Promise<string> {
    const context = await authModule.auth.$context;
    const [stored] = await owner
      .select({ secret: twoFactor.secret })
      .from(twoFactor)
      .where(eq(twoFactor.userId, adminId));
    return symmetricDecrypt({ key: context.secretConfig, data: stored?.secret ?? "" });
  }

  /** Password plus a TOTP code of `secret`; the status of the second step. */
  async function signInWith(secret: string): Promise<Response> {
    const first = await authPost("/sign-in/email", { email: adminEmail, password });
    expect(first.status).toBe(200);
    const challenge = cookieOf(first, "two_factor");
    const code = await createOTP(secret, { digits: 6, period: 30 }).totp();
    return authPost("/two-factor/verify-totp", { code }, challenge);
  }

  async function call(path: string, withCookie: string): Promise<Response> {
    return app.fetch(
      new Request(`${PUBLIC_URL}/api/v1${path}`, {
        headers: { cookie: withCookie, origin: PUBLIC_URL },
      }),
    );
  }

  beforeAll(async () => {
    const admin = createDb(testDatabaseAdminUrl as string);
    try {
      await admin.$client.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.$client.end();
    }
    const ownerUrl = urlFor(testDatabaseAdminUrl as string, DATABASE);
    const roles = await provisionTestRoles(ownerUrl);
    owner = createDb(ownerUrl);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
    process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;

    authModule = await import("../auth.js");
    const { buildApp } = await import("../app.js");
    app = buildApp();

    const context = await authModule.auth.$context;
    await owner
      .insert(user)
      .values({ id: adminId, name: "First Owner", email: adminEmail, role: "admin" });
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: adminId,
      providerId: "credential",
      userId: adminId,
      password: await context.password.hash(password),
    });
    const first = await authPost("/sign-in/email", { email: adminEmail, password });
    const passwordOnly = cookieOf(first, "session_token");
    expect((await authPost("/two-factor/enable", { password }, passwordOnly)).status).toBe(200);
    const code = await createOTP(await storedSecret(), { digits: 6, period: 30 }).totp();
    const verified = await authPost("/two-factor/verify-totp", { code }, passwordOnly);
    expect(verified.status).toBe(200);
    cookie = cookieOf(verified, "session_token");
  }, 120_000);

  afterAll(async () => {
    const shared = await import("../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("keeps the old authenticator until the new one is confirmed", async () => {
    const oldSecret = await storedSecret();

    expect(
      (await authPost("/two-factor/replace", { password: "wrong-password-123" }, cookie)).status,
    ).toBe(400);

    const started = await authPost("/two-factor/replace", { password }, cookie);
    expect(started.status).toBe(200);
    const body = (await started.json()) as { totpURI: string; backupCodes: string[] };
    expect(body.backupCodes).toHaveLength(10);
    const newSecret = new URL(body.totpURI).searchParams.get("secret");
    expect(newSecret).toBeTruthy();

    // Nothing changed yet: the stored key is the old one and signs in.
    expect(await storedSecret()).toBe(oldSecret);
    expect((await signInWith(oldSecret)).status).toBe(200);

    // A wrong code changes nothing either.
    const wrong = await authPost("/two-factor/replace/confirm", { code: "000000" }, cookie);
    expect(wrong.status).toBe(401);
    expect(await storedSecret()).toBe(oldSecret);
  });

  it("swaps key and recovery codes once the new phone's code is confirmed", async () => {
    const oldSecret = await storedSecret();
    const started = await authPost("/two-factor/replace", { password }, cookie);
    const body = (await started.json()) as { totpURI: string; backupCodes: string[] };
    // The otpauth URI carries the key base32-encoded; the stored key is the raw string.
    const code = await (async () => {
      const uri = new URL(body.totpURI);
      expect(uri.searchParams.get("issuer")).toBeTruthy();
      const context = await authModule.auth.$context;
      const pending = await context.internalAdapter.findVerificationValue(
        `restow-totp-replace:${adminId}`,
      );
      const raw = JSON.parse(
        await symmetricDecrypt({ key: context.secretConfig, data: pending?.value ?? "" }),
      ) as { secret: string };
      return createOTP(raw.secret, { digits: 6, period: 30 }).totp();
    })();

    const confirmed = await authPost("/two-factor/replace/confirm", { code }, cookie);
    expect(confirmed.status).toBe(200);

    const newSecret = await storedSecret();
    expect(newSecret).not.toBe(oldSecret);
    expect((await signInWith(newSecret)).status).toBe(200);
    expect((await signInWith(oldSecret)).status).toBe(401);

    // The new recovery codes are the ones that work now.
    const first = await authPost("/sign-in/email", { email: adminEmail, password });
    const challenge = cookieOf(first, "two_factor");
    const recovered = await authPost(
      "/two-factor/verify-backup-code",
      { code: body.backupCodes[0] },
      challenge,
    );
    expect(recovered.status).toBe(200);

    // A second confirmation has nothing left to confirm.
    expect((await authPost("/two-factor/replace/confirm", { code }, cookie)).status).toBe(400);
  });

  it("counts the accounts that only have a passkey, the requester included", async () => {
    const before = (await (await call("/settings/passkey-impact", cookie)).json()) as {
      accountsWithPasskeys: number;
      accountsLockedOut: number;
      self: { lockedOut: boolean; hasAuthenticator: boolean };
    };
    expect(before).toMatchObject({ accountsWithPasskeys: 0, accountsLockedOut: 0 });
    expect(before.self).toMatchObject({ lockedOut: false, hasAuthenticator: true });

    const passkeyRow = (userId: string) => ({
      id: randomUUID(),
      userId,
      publicKey: "key",
      credentialID: randomUUID(),
      counter: 0,
      deviceType: "multiDevice",
      backedUp: true,
    });
    // The owner (password + authenticator) and a member with nothing but a passkey.
    const memberId = randomUUID();
    await owner
      .insert(user)
      .values({ id: memberId, name: "Member", email: "member@provider.example" });
    await owner.insert(passkey).values([passkeyRow(adminId), passkeyRow(memberId)]);

    const after = (await (await call("/settings/passkey-impact", cookie)).json()) as {
      accountsWithPasskeys: number;
      accountsLockedOut: number;
      self: { lockedOut: boolean; hasPasskey: boolean };
    };
    expect(after).toMatchObject({ accountsWithPasskeys: 2, accountsLockedOut: 1 });
    expect(after.self).toMatchObject({ lockedOut: false, hasPasskey: true });
  });
});
