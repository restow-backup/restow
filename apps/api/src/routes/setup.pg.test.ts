/**
 * Postgres-backed test of the setup wizard's gate and of the operator
 * responsibility notice (lib/disclaimer.ts, lib/setup-token.ts):
 *
 *   - the public state reports the current notice version, not accepted, and
 *     that the setup token is required;
 *   - the setup is refused without the setup token (403), from another site
 *     (403) and with a body that is not JSON (415), and nothing is written;
 *   - with the token, the setup is refused with a 428 problem until the
 *     request carries the acceptance of the current notice, and an unticked
 *     box or another version is refused too, again writing nothing;
 *   - a completed setup records the acceptance (version, time, client address)
 *     with the new administrator as the one who accepted, followed by the
 *     completion, in the installation audit chain; an anonymous acceptance an
 *     earlier version stored before its setup does not count;
 *   - after setup the wizard is closed (409) and the token is gone;
 *   - an installation set up before the notice existed is not locked out: its
 *     provider admin keeps working and accepts through the settings route,
 *     recorded with their identity; a later text version asks again.
 *
 * The suite drives the real application (apps/api/src/app.ts) on the
 * application and installation roles Row Level Security binds, the same setup
 * `features/accounts/accounts.pg.test.ts` uses, including the mandatory
 * authenticator enrolment before a password session reaches anything else.
 *
 * The tests build on each other (one installation, first run to running), so
 * they run in file order. Runs when RESTOW_TEST_DATABASE_URL points at a
 * Postgres server; without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  type ProviderRole,
  account,
  auditLog,
  createDb,
  providerMembers,
  providers,
  settings,
  twoFactor,
  user,
} from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { asc, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../testing/database-roles.js";

const DATABASE = "restow_api_setup_disclaimer_test";
const PUBLIC_URL = "http://localhost:3000";
const ADMIN_EMAIL = "ops@example.com";
const ADMIN_PASSWORD = "correct-horse-battery-1";
const PRODUCT_NAME = "Acme Backup";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";

const SETUP_FIELDS = {
  operatingMode: "local",
  firstAdmin: { name: "Operator", email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  mail: {
    transport: "smtp",
    smtp: { host: "mail.example.com", port: 587, security: "starttls", from: "restow@example.com" },
  },
  sendTest: false,
};

interface Problem {
  type: string;
  status: number;
  version?: string;
}

describe.skipIf(!testDatabaseAdminUrl)(
  "setup wizard gate and operator notice against Postgres",
  () => {
    let owner: Database;
    let roles: TestDatabaseRoles | undefined;
    let app: Hono;
    let authModule: typeof import("../auth.js");
    let version: string;
    let verifyAuditChain: typeof import("../lib/audit.js").verifyAuditChain;

    beforeAll(async () => {
      const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
      roles = await provisionTestRoles(url);
      process.env.DATABASE_URL = roles.appUrl;
      process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
      process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
      process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
      process.env.RESTOW_PUBLIC_URL = PUBLIC_URL;
      process.env.RESTOW_PRODUCT_NAME = PRODUCT_NAME;
      process.env.RESTOW_SETUP_TOKEN = SETUP_TOKEN;
      owner = createDb(url);

      ({ app } = await import("../app.js"));
      authModule = await import("../auth.js");
      ({ verifyAuditChain } = await import("../lib/audit.js"));
      ({ DISCLAIMER_VERSION: version } = await import("../lib/disclaimer.js"));
    }, 60_000);

    afterAll(async () => {
      const shared = await import("../db.js");
      await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
      await owner?.$client.end();
      Reflect.deleteProperty(process.env, "RESTOW_PRODUCT_NAME");
      Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
      await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
      await roles?.drop(testDatabaseAdminUrl as string);
    }, 30_000);

    function call(
      method: string,
      path: string,
      options: { body?: unknown; headers?: Record<string, string>; contentType?: string } = {},
    ): Promise<Response> {
      return Promise.resolve(
        app.fetch(
          new Request(`${PUBLIC_URL}${path}`, {
            method,
            headers: {
              ...(options.body !== undefined
                ? { "content-type": options.contentType ?? "application/json" }
                : {}),
              ...options.headers,
            },
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          }),
        ),
      );
    }

    /** The wizard's setup call: the token header and the request body. */
    const submitSetup = (
      body: Record<string, unknown>,
      headers: Record<string, string> = { "x-restow-setup-token": SETUP_TOKEN },
    ) => call("POST", "/api/v1/setup", { body, headers });

    const state = async () =>
      (await (await call("GET", "/api/v1/setup/state")).json()) as {
        configured: boolean;
        productName: string;
        disclaimer: { version: string; accepted: boolean };
        setupToken: { required: boolean; source: string | null };
      };

    const settingsRow = async () => (await owner.select().from(settings).limit(1))[0];

    const installationChain = () =>
      owner
        .select()
        .from(auditLog)
        .where(isNull(auditLog.tenantId))
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id));

    const acceptedEntries = async () =>
      (await installationChain()).filter(
        (entry) => entry.action === "settings.disclaimer_accepted",
      );

    async function nothingWritten(): Promise<void> {
      expect(await owner.select({ id: user.id }).from(user)).toEqual([]);
      expect((await settingsRow())?.setupCompletedAt ?? null).toBeNull();
      expect(await installationChain()).toEqual([]);
    }

    // --- First run --------------------------------------------------------------------

    it("reports the notice as not accepted and the setup token as required on a fresh installation", async () => {
      const body = await state();
      expect(body.configured).toBe(false);
      // The branding reaches the web app through this public state, before anyone signs in.
      expect(body.productName).toBe(PRODUCT_NAME);
      expect(body.disclaimer).toEqual({ version, accepted: false });
      expect(body.setupToken).toEqual({ required: true, source: "environment" });
      expect(await settingsRow()).toBeUndefined();
    });

    it("refuses the setup without the setup token, or with a wrong one, and writes nothing", async () => {
      const full = { ...SETUP_FIELDS, disclaimer: { version, accepted: true } };
      const attempts: Record<string, string>[] = [
        {},
        { "x-restow-setup-token": "AAAAA-BBBBB-CCCCC-DDDDD" },
      ];
      for (const headers of attempts) {
        const response = await submitSetup(full, headers);
        expect(response.status).toBe(403);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        expect(((await response.json()) as Problem).type).toBe(
          "urn:restow:problem:setup-token-invalid",
        );
      }
      await nothingWritten();
    });

    it("checks the token in the wizard's first step without writing anything", async () => {
      const wrong = await call("POST", "/api/v1/setup/token", {
        headers: { "x-restow-setup-token": "nope" },
      });
      expect(wrong.status).toBe(403);
      // Case, spaces and dashes do not matter: what the operator copies is what counts.
      const right = await call("POST", "/api/v1/setup/token", {
        headers: { "x-restow-setup-token": ` ${SETUP_TOKEN.toLowerCase().replaceAll("-", " ")} ` },
      });
      expect(right.status).toBe(204);
      await nothingWritten();
    });

    it("refuses cross-site requests and bodies that are not JSON, token or not", async () => {
      const full = { ...SETUP_FIELDS, disclaimer: { version, accepted: true } };
      const token = { "x-restow-setup-token": SETUP_TOKEN };
      // A page on another site, as a browser marks it.
      const crossSite = await submitSetup(full, { ...token, "sec-fetch-site": "cross-site" });
      expect(crossSite.status).toBe(403);
      expect(((await crossSite.json()) as Problem).type).toBe(
        "urn:restow:problem:cross-site-request",
      );
      // An older browser without Sec-Fetch-Site still sends the page's origin.
      const foreignOrigin = await submitSetup(full, { ...token, origin: "https://evil.example" });
      expect(foreignOrigin.status).toBe(403);
      // The no-cors text/plain form post a cross-site page can send without a preflight.
      const textPlain = await call("POST", "/api/v1/setup", {
        body: full,
        contentType: "text/plain",
        headers: token,
      });
      expect(textPlain.status).toBe(415);
      const tokenCheck = await call("POST", "/api/v1/setup/token", {
        headers: { ...token, "sec-fetch-site": "cross-site" },
      });
      expect(tokenCheck.status).toBe(403);
      await nothingWritten();
    });

    it("refuses the setup until the request carries the acceptance of the notice", async () => {
      for (const disclaimer of [undefined, { version, accepted: false }, {}]) {
        const response = await submitSetup({ ...SETUP_FIELDS, disclaimer });
        expect(response.status).toBe(428);
        const problem = (await response.json()) as Problem;
        expect(problem.type).toBe("urn:restow:problem:disclaimer-required");
        expect(problem.version).toBe(version);
      }
      // The gate comes before the validation of the rest of the body.
      const bare = await submitSetup({ operatingMode: "local" });
      expect(bare.status).toBe(428);

      const stale = await submitSetup({
        ...SETUP_FIELDS,
        disclaimer: { version: "1999-01-01", accepted: true },
      });
      expect(stale.status).toBe(409);
      const problem = (await stale.json()) as Problem;
      expect(problem.type).toBe("urn:restow:problem:disclaimer-version-mismatch");
      expect(problem.version).toBe(version);
      await nothingWritten();
    });

    it("no longer offers the anonymous acceptance route", async () => {
      const response = await call("POST", "/api/v1/setup/disclaimer", {
        body: { version, accepted: true },
      });
      expect(response.status).toBe(404);
      await nothingWritten();
    });

    it("does not count an anonymous acceptance an earlier version stored before its setup", async () => {
      // What 0.1.0 left behind after an anonymous POST /setup/disclaimer.
      await owner.insert(settings).values({
        singleton: true,
        disclaimerVersion: version,
        disclaimerAcceptedAt: new Date("2026-09-30T10:00:00Z"),
        disclaimerAcceptedIp: "203.0.113.66",
      });
      expect(await state()).toMatchObject({ configured: false, disclaimer: { accepted: false } });
      const response = await submitSetup({ ...SETUP_FIELDS });
      expect(response.status).toBe(428);
    });

    it("sets up with the token and the acceptance, recorded with the new administrator", async () => {
      const before = Date.now();
      const response = await submitSetup(
        { ...SETUP_FIELDS, disclaimer: { version, accepted: true } },
        {
          "x-restow-setup-token": SETUP_TOKEN,
          // The client wrote the first hop; the edge appended the address it saw.
          "x-forwarded-for": "198.51.100.1, 192.0.2.77",
        },
      );
      expect(response.status).toBe(201);

      const row = await settingsRow();
      expect(row?.setupCompletedAt).not.toBeNull();
      expect(row?.disclaimerVersion).toBe(version);
      expect(row?.disclaimerAcceptedIp).toBe("192.0.2.77");
      expect(row?.disclaimerAcceptedAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
      // Without a provider name of its own, the operator row carries the product name.
      expect((await owner.select().from(providers).limit(1))[0]?.name).toBe(PRODUCT_NAME);

      const [admin] = await owner
        .select({ id: user.id })
        .from(user)
        .where(eq(user.email, ADMIN_EMAIL));
      const chain = await installationChain();
      expect(chain.map((entry) => entry.action)).toEqual([
        "settings.disclaimer_accepted",
        "setup.completed",
      ]);
      expect(chain[0]).toMatchObject({
        tenantId: null,
        actor: ADMIN_EMAIL,
        actorUserId: admin?.id,
        ip: "192.0.2.77",
        targetType: "installation",
        target: row?.id,
      });
      expect(chain[0]?.details).toEqual({ version, previousVersion: version, via: "setup" });
      expect(chain[1]).toMatchObject({
        actor: ADMIN_EMAIL,
        actorUserId: admin?.id,
        ip: "192.0.2.77",
      });
      expect(verifyAuditChain(chain)).toMatchObject({ ok: true, checked: 2 });

      expect(await state()).toMatchObject({
        configured: true,
        disclaimer: { version, accepted: true },
        setupToken: { required: false, source: null },
      });
    });

    it("closes the wizard once the installation is configured, token or not", async () => {
      const before = await settingsRow();
      const again = await submitSetup({ ...SETUP_FIELDS, disclaimer: { version, accepted: true } });
      expect(again.status).toBe(409);
      expect(((await again.json()) as Problem).type).toBe("urn:restow:problem:already-configured");
      const token = await call("POST", "/api/v1/setup/token", {
        headers: { "x-restow-setup-token": SETUP_TOKEN },
      });
      expect(token.status).toBe(409);
      expect(await settingsRow()).toEqual(before);
    });

    // --- An installation that predates the notice, or whose text changed ------------------------

    describe("a running installation", () => {
      function authPost(
        path: string,
        body: Record<string, unknown>,
        cookie?: string,
        clientIp = "198.51.100.70",
      ): Promise<Response> {
        return authModule.auth.handler(
          new Request(`${PUBLIC_URL}/api/auth${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: PUBLIC_URL,
              "x-forwarded-for": clientIp,
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

      /** Sign in with the password and enrol the mandatory authenticator app; the fully assured cookie. */
      async function signInAsProviderAdmin(
        email = ADMIN_EMAIL,
        password = ADMIN_PASSWORD,
        clientIp = "198.51.100.70",
      ): Promise<{ cookie: string; userId: string }> {
        const signIn = await authPost("/sign-in/email", { email, password }, undefined, clientIp);
        expect(signIn.status).toBe(200);
        const passwordOnly = sessionCookieOf(signIn);
        const enable = await authPost("/two-factor/enable", { password }, passwordOnly, clientIp);
        expect(enable.status).toBe(200);

        const [row] = await owner.select({ id: user.id }).from(user).where(eq(user.email, email));
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
        const verify = await authPost("/two-factor/verify-totp", { code }, passwordOnly, clientIp);
        expect(verify.status).toBe(200);
        return { cookie: sessionCookieOf(verify), userId: row?.id as string };
      }

      /** A provider admin with a team role other than the owner the wizard created, signed in and enrolled. */
      async function signInAsTeamMember(
        role: ProviderRole,
        clientIp: string,
      ): Promise<{ cookie: string; userId: string; email: string }> {
        const email = `${role}@example.com`;
        const context = await authModule.auth.$context;
        const userId = randomUUID();
        await owner
          .insert(user)
          .values({ id: userId, name: role, email, emailVerified: false, role: "admin" });
        await owner.insert(account).values({
          id: randomUUID(),
          accountId: userId,
          providerId: "credential",
          userId,
          password: await context.password.hash(ADMIN_PASSWORD),
        });
        await owner.insert(providerMembers).values({ userId, role, allTenants: true });
        const session = await signInAsProviderAdmin(email, ADMIN_PASSWORD, clientIp);
        return { ...session, email };
      }

      let admin: { cookie: string; userId: string };

      const acceptAsAdmin = (body: unknown, cookie?: string) =>
        call("POST", "/api/v1/settings/disclaimer", {
          body,
          headers: { origin: PUBLIC_URL, ...(cookie ? { cookie } : {}) },
        });

      /** What an installation set up before this feature looks like after the migration. */
      async function forgetAcceptance(previous: string | null): Promise<void> {
        await owner.update(settings).set({
          disclaimerVersion: previous,
          disclaimerAcceptedAt: null,
          disclaimerAcceptedIp: null,
        });
      }

      beforeAll(async () => {
        admin = await signInAsProviderAdmin();
      }, 30_000);

      it("is not locked out: the sign-in and the API keep working, the state asks for the notice", async () => {
        await forgetAcceptance(null);
        expect(await state()).toMatchObject({
          configured: true,
          disclaimer: { version, accepted: false },
        });

        const me = await call("GET", "/api/v1/me", { headers: { cookie: admin.cookie } });
        expect(me.status).toBe(200);
        // The setup wizard stays closed for good, accepted or not.
        const setupAgain = await submitSetup({
          ...SETUP_FIELDS,
          disclaimer: { version, accepted: true },
        });
        expect(setupAgain.status).toBe(409);
      });

      it("cannot be accepted anonymously", async () => {
        const response = await acceptAsAdmin({ version, accepted: true });
        expect(response.status).toBe(401);
        expect(await state()).toMatchObject({ disclaimer: { accepted: false } });
      });

      it("refuses an unticked box and another version from a provider admin", async () => {
        const unticked = await acceptAsAdmin({ version, accepted: false }, admin.cookie);
        expect(unticked.status).toBe(422);
        const stale = await acceptAsAdmin({ version: "1999-01-01", accepted: true }, admin.cookie);
        expect(stale.status).toBe(409);
        expect(await state()).toMatchObject({ disclaimer: { accepted: false } });
      });

      it("is refused with 403 to technicians and read-only members, whatever they send", async () => {
        const entriesBefore = (await acceptedEntries()).length;
        const members = [
          await signInAsTeamMember("technician", "198.51.100.71"),
          await signInAsTeamMember("read_only", "198.51.100.72"),
        ];
        for (const member of members) {
          const response = await acceptAsAdmin({ version, accepted: true }, member.cookie);
          expect(response.status).toBe(403);
          expect(((await response.json()) as Problem).type).toBe(
            "urn:restow:problem:provider-role-required",
          );
        }
        expect(await state()).toMatchObject({ disclaimer: { accepted: false } });
        expect(await acceptedEntries()).toHaveLength(entriesBefore);
        expect((await settingsRow())?.disclaimerVersion).toBeNull();
      });

      it("is accepted by a team administrator, recorded with their identity", async () => {
        const member = await signInAsTeamMember("administrator", "198.51.100.73");
        const response = await acceptAsAdmin({ version, accepted: true }, member.cookie);
        expect(response.status).toBe(200);
        expect((await acceptedEntries()).at(-1)).toMatchObject({
          actor: member.email,
          actorUserId: member.userId,
        });
        expect(await state()).toMatchObject({ disclaimer: { accepted: true } });
        // Back to "not accepted yet" for the owner's turn below.
        await forgetAcceptance(null);
      });

      it("is accepted by the provider admin after sign-in, recorded with who and from where", async () => {
        const entriesBefore = (await acceptedEntries()).length;
        const response = await call("POST", "/api/v1/settings/disclaimer", {
          body: { version, accepted: true },
          headers: { origin: PUBLIC_URL, cookie: admin.cookie, "x-forwarded-for": "203.0.113.20" },
        });
        expect(response.status).toBe(200);

        const row = await settingsRow();
        expect(row).toMatchObject({
          disclaimerVersion: version,
          disclaimerAcceptedIp: "203.0.113.20",
        });
        expect(row?.disclaimerAcceptedAt).toBeInstanceOf(Date);

        const entries = await acceptedEntries();
        expect(entries).toHaveLength(entriesBefore + 1);
        const last = entries.at(-1);
        expect(last).toMatchObject({
          actor: ADMIN_EMAIL,
          actorUserId: admin.userId,
          ip: "203.0.113.20",
          tenantId: null,
        });
        expect(last?.details).toEqual({ version, previousVersion: null, via: "sign_in" });
        expect(verifyAuditChain(await installationChain())).toMatchObject({ ok: true });
        expect(await state()).toMatchObject({ disclaimer: { version, accepted: true } });
      });

      it("asks again after a new text version and names the version it replaces", async () => {
        await forgetAcceptance("2020-01-01");
        expect(await state()).toMatchObject({ disclaimer: { version, accepted: false } });

        const response = await acceptAsAdmin({ version, accepted: true }, admin.cookie);
        expect(response.status).toBe(200);
        const last = (await acceptedEntries()).at(-1);
        expect(last?.details).toEqual({ version, previousVersion: "2020-01-01", via: "sign_in" });
        expect(await state()).toMatchObject({ disclaimer: { version, accepted: true } });
      });
    });
  },
);
