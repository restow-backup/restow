/**
 * Postgres-backed test of the command-line administrator recovery
 * (`restow admin recover`, cli/admin-recovery.ts) on a real installation set
 * up through the wizard's own route:
 *
 *   - only an enabled owner of the provider team can be recovered; an unknown
 *     address, an end user, a technician and a disabled owner are refused, and
 *     so is a password the policy does not allow, all without a change;
 *   - recovery replaces the password, removes the authenticator app and the
 *     passkeys and ends every session, in one transaction, and writes
 *     `account.access_recovered` to the installation audit chain;
 *   - afterwards the old password and the old session are worthless, the new
 *     password signs in and the session must enrol an authenticator app
 *     before anything else;
 *   - an owner who had only passkeys gets a password and loses the passkeys.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; without it
 * the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  account,
  auditLog,
  createDb,
  passkey,
  providerMembers,
  session,
  twoFactor,
  user,
} from "@restow/db";
import { asc, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../testing/database-roles.js";

const DATABASE = "restow_api_admin_recovery_test";
const PUBLIC_URL = "http://localhost:3000";
const SETUP_TOKEN = "RECOVERY-TEST-SETUP-TOKEN-0001";
const OWNER_EMAIL = "owner@example.com";
const OWNER_PASSWORD = "first-owner-password-1";
const NEW_PASSWORD = "recovered-owner-password-2";

describe.skipIf(!testDatabaseAdminUrl)(
  "command-line administrator recovery against Postgres",
  () => {
    let owner: Database;
    let roles: TestDatabaseRoles | undefined;
    let app: Hono;
    let authModule: typeof import("../auth.js");
    let recovery: typeof import("./admin-recovery.js");
    let installation: Database;
    let verifyAuditChain: typeof import("../lib/audit.js").verifyAuditChain;
    let ownerId: string;
    let ownerCookie: string;

    beforeAll(async () => {
      const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
      roles = await provisionTestRoles(url);
      process.env.DATABASE_URL = roles.appUrl;
      process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
      process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
      process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
      process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
      process.env.RESTOW_SETUP_TOKEN = SETUP_TOKEN;
      owner = createDb(url);

      ({ app } = await import("../app.js"));
      authModule = await import("../auth.js");
      recovery = await import("./admin-recovery.js");
      ({ providerDb: installation } = await import("../db.js"));
      ({ verifyAuditChain } = await import("../lib/audit.js"));
      const { DISCLAIMER_VERSION } = await import("../lib/disclaimer.js");

      const setup = await app.fetch(
        new Request(`${PUBLIC_URL}/api/v1/setup`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-restow-setup-token": SETUP_TOKEN },
          body: JSON.stringify({
            disclaimer: { version: DISCLAIMER_VERSION, accepted: true },
            operatingMode: "local",
            providerName: "Recovery Test Operator",
            firstAdmin: { name: "Owner", email: OWNER_EMAIL, password: OWNER_PASSWORD },
            mail: {
              transport: "smtp",
              smtp: { host: "mail.example.com", port: 587, from: "restow@example.com" },
            },
          }),
        }),
      );
      expect(setup.status).toBe(201);
      const signedIn = await signInWithAuthenticator(OWNER_EMAIL, OWNER_PASSWORD);
      ownerId = signedIn.userId;
      ownerCookie = signedIn.cookie;
      // A passkey of the lost device.
      await owner.insert(passkey).values(fakePasskey(ownerId));
    }, 60_000);

    afterAll(async () => {
      const shared = await import("../db.js");
      await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
      await owner?.$client.end();
      Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
      await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
      await roles?.drop(testDatabaseAdminUrl as string);
    }, 30_000);

    function fakePasskey(userId: string) {
      return {
        id: randomUUID(),
        name: "Lost laptop",
        publicKey: "fixture-public-key",
        userId,
        credentialID: randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      };
    }

    function authPost(path: string, body: Record<string, unknown>, cookie?: string) {
      return authModule.auth.handler(
        new Request(`${PUBLIC_URL}/api/auth${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: PUBLIC_URL,
            "x-forwarded-for": "198.51.100.90",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    }

    function sessionCookieOf(response: Response): string {
      const cookie = response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0] ?? "")
        .find((pair) => pair.includes("session_token="));
      if (!cookie) {
        throw new Error(`the response set no session cookie (status ${response.status})`);
      }
      return cookie;
    }

    /** Password sign-in plus the mandatory authenticator enrolment; the fully assured cookie. */
    async function signInWithAuthenticator(email: string, password: string) {
      const signIn = await authPost("/sign-in/email", { email, password });
      expect(signIn.status).toBe(200);
      const passwordOnly = sessionCookieOf(signIn);
      const enable = await authPost("/two-factor/enable", { password }, passwordOnly);
      expect(enable.status).toBe(200);
      const [row] = await owner.select({ id: user.id }).from(user).where(eq(user.email, email));
      const { symmetricDecrypt } = await import("better-auth/crypto");
      const context = await authModule.auth.$context;
      const [stored] = await owner
        .select({ secret: twoFactor.secret })
        .from(twoFactor)
        .where(eq(twoFactor.userId, row?.id as string));
      const rawSecret = await symmetricDecrypt({
        key: context.secretConfig,
        data: stored?.secret as string,
      });
      const { code } = await authModule.auth.api.generateTOTP({ body: { secret: rawSecret } });
      const verify = await authPost("/two-factor/verify-totp", { code }, passwordOnly);
      expect(verify.status).toBe(200);
      return { cookie: sessionCookieOf(verify), userId: row?.id as string };
    }

    async function createAccount(options: {
      email: string;
      role: string | null;
      teamRole?: "owner" | "administrator" | "technician" | "read_only";
      banned?: boolean;
      password?: string;
    }): Promise<string> {
      const id = randomUUID();
      await owner.insert(user).values({
        id,
        name: options.email,
        email: options.email,
        emailVerified: false,
        role: options.role,
        banned: options.banned ?? false,
      });
      if (options.password) {
        const context = await authModule.auth.$context;
        await owner.insert(account).values({
          id: randomUUID(),
          accountId: id,
          providerId: "credential",
          userId: id,
          password: await context.password.hash(options.password),
        });
      }
      if (options.teamRole) {
        await owner.insert(providerMembers).values({ userId: id, role: options.teamRole });
      }
      return id;
    }

    const me = (cookie: string) =>
      app.fetch(new Request(`${PUBLIC_URL}/api/v1/me`, { headers: { cookie } }));

    const recoveredEntries = async () =>
      (
        await owner
          .select()
          .from(auditLog)
          .where(isNull(auditLog.tenantId))
          .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
      ).filter((entry) => entry.action === "account.access_recovered");

    it("lists the administrators, owners first", async () => {
      await createAccount({
        email: "tech@example.com",
        role: "admin",
        teamRole: "technician",
        password: OWNER_PASSWORD,
      });
      await createAccount({ email: "user@example.com", role: "user", password: OWNER_PASSWORD });
      const admins = await recovery.listProviderAdmins(installation);
      expect(admins.map((admin) => [admin.email, admin.teamRole])).toEqual([
        [OWNER_EMAIL, "owner"],
        ["tech@example.com", "technician"],
      ]);
      expect(admins[0]).toMatchObject({ password: true, authenticatorApp: true, passkeys: 1 });
    });

    it("refuses everyone but an enabled owner, and a password the policy does not allow", async () => {
      await createAccount({ email: "gone@example.com", role: "admin", banned: true });
      for (const [email, reason] of [
        ["nobody@example.com", "not_found"],
        ["user@example.com", "not_provider_admin"],
        ["tech@example.com", "not_owner"],
        ["gone@example.com", "disabled"],
      ] as const) {
        await expect(recovery.recoveryTarget(installation, email)).rejects.toMatchObject({
          reason,
        });
        await expect(
          recovery.recoverAdminAccess(installation, { email, password: NEW_PASSWORD }),
        ).rejects.toMatchObject({ reason });
      }
      await expect(
        recovery.recoverAdminAccess(installation, { email: OWNER_EMAIL, password: "short" }),
      ).rejects.toMatchObject({ reason: "password_policy" });
      expect(await recoveredEntries()).toEqual([]);
      // The owner is untouched: the old session still works.
      expect((await me(ownerCookie)).status).toBe(200);
    });

    it("replaces the password, removes the second factors and ends every session", async () => {
      const result = await recovery.recoverAdminAccess(installation, {
        email: ` ${OWNER_EMAIL.toUpperCase()} `,
        password: NEW_PASSWORD,
      });
      expect(result).toMatchObject({
        userId: ownerId,
        email: OWNER_EMAIL,
        passwordCreated: false,
        authenticatorRemoved: true,
        passkeysRemoved: 1,
      });
      expect(result.sessionsEnded).toBeGreaterThanOrEqual(1);

      expect(await owner.select().from(twoFactor).where(eq(twoFactor.userId, ownerId))).toEqual([]);
      expect(await owner.select().from(passkey).where(eq(passkey.userId, ownerId))).toEqual([]);
      expect(await owner.select().from(session).where(eq(session.userId, ownerId))).toEqual([]);
      const [row] = await owner.select().from(user).where(eq(user.id, ownerId));
      expect(row?.twoFactorEnabled).toBe(false);

      const entries = await recoveredEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor: "system",
        actorUserId: null,
        target: ownerId,
        targetType: "user",
        onBehalfOf: OWNER_EMAIL,
        ip: null,
      });
      expect(entries[0]?.details).toMatchObject({
        via: "command_line",
        passwordCreated: false,
        authenticatorRemoved: true,
        passkeysRemoved: 1,
      });
      const chain = await owner
        .select()
        .from(auditLog)
        .where(isNull(auditLog.tenantId))
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
      expect(verifyAuditChain(chain)).toMatchObject({ ok: true });
    });

    it("leaves the old password and session worthless and asks the new session for an authenticator", async () => {
      expect((await me(ownerCookie)).status).toBe(401);
      expect(
        (await authPost("/sign-in/email", { email: OWNER_EMAIL, password: OWNER_PASSWORD })).status,
      ).toBe(401);

      const signIn = await authPost("/sign-in/email", {
        email: OWNER_EMAIL,
        password: NEW_PASSWORD,
      });
      expect(signIn.status).toBe(200);
      const response = await me(sessionCookieOf(signIn));
      expect(response.status).toBe(403);
      expect(((await response.json()) as { type: string }).type).toBe(
        "urn:restow:problem:totp-enrollment-required",
      );
    });

    it("gives an owner who had only passkeys a password and removes the passkeys", async () => {
      const passkeyOnly = await createAccount({ email: "keys@example.com", role: "admin" });
      await owner.insert(passkey).values(fakePasskey(passkeyOnly));
      const result = await recovery.recoverAdminAccess(installation, {
        email: "keys@example.com",
        password: NEW_PASSWORD,
      });
      expect(result).toMatchObject({
        passwordCreated: true,
        authenticatorRemoved: false,
        passkeysRemoved: 1,
      });
      expect(await owner.select().from(passkey).where(eq(passkey.userId, passkeyOnly))).toEqual([]);
      expect((await recoveredEntries()).at(-1)?.details).toMatchObject({ passwordCreated: true });
      // The password path is open now: a passkey without an authenticator app would refuse it.
      const signIn = await authPost("/sign-in/email", {
        email: "keys@example.com",
        password: NEW_PASSWORD,
      });
      expect(signIn.status).toBe(200);
    });

    it("names the sign-in page of the installation", async () => {
      expect(await recovery.signInUrl(installation, "https://fallback.example.com")).toBe(
        "https://fallback.example.com/login",
      );
    });
  },
);
