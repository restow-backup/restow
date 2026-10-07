/**
 * Postgres-backed tests of the own password over HTTP, with real better-auth
 * sessions (lib/password-reset.ts, auth.ts):
 *
 *   - "Forgot your password?": the answer never tells whether an address has
 *     an account; only an account with a password and an authenticator app
 *     gets a mail, at most one per interval; the link points at the public
 *     URL; the new password ends every session, keeps the authenticator app
 *     and is written to the installation audit chain;
 *   - the setup state offers the reset only with mail and a public URL;
 *   - changing the own password checks the current one, may sign the other
 *     sessions out and is audited;
 *   - the session list and signing one session out.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser. Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createOTP } from "@better-auth/utils/otp";
import { type Database, account, auditLog, createDb, settings, twoFactor, user } from "@restow/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dropDatabase } from "../features/snapshots/testing/explorer-fixture.js";
import type { NotificationMessage } from "../notify-core.js";
import { provisionTestRoles } from "../testing/database-roles.js";

const sent: NotificationMessage[] = [];

// The transport from the environment (SMTP_* below) delivers into `sent`.
vi.mock("../notify.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../notify.js")>();
  return {
    ...original,
    createNotifier: () => ({
      send: async (message: NotificationMessage) => {
        sent.push(message);
        return { ok: true };
      },
    }),
  };
});

const DATABASE = `restow_password_reset_test_${randomBytes(4).toString("hex")}`;
const PUBLIC_URL = "http://localhost:3000";
const testDatabaseAdminUrl = process.env.RESTOW_TEST_DATABASE_URL;

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!testDatabaseAdminUrl)("the own password against Postgres", () => {
  let owner: Database;
  let app: Hono;
  let authModule: typeof import("../auth.js");
  let ipCounter = 1;

  function authCall(path: string, body?: unknown, cookie?: string): Promise<Response> {
    ipCounter += 1;
    return authModule.auth.handler(
      new Request(`${PUBLIC_URL}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          origin: PUBLIC_URL,
          "x-forwarded-for": `198.51.100.${ipCounter % 250}`,
          ...(cookie ? { cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

  async function secretOf(userId: string): Promise<string> {
    const context = await authModule.auth.$context;
    const [stored] = await owner
      .select({ secret: twoFactor.secret })
      .from(twoFactor)
      .where(eq(twoFactor.userId, userId));
    return symmetricDecrypt({ key: context.secretConfig, data: stored?.secret ?? "" });
  }

  /** An account with a password and, with `authenticator`, an enrolled app; its full session. */
  async function createAccount(
    email: string,
    password: string,
    { authenticator }: { authenticator: boolean },
  ): Promise<{ id: string; cookie: string }> {
    const id = randomUUID();
    const context = await authModule.auth.$context;
    await owner.insert(user).values({ id, name: email, email, role: "admin" });
    await owner.insert(account).values({
      id: randomUUID(),
      accountId: id,
      providerId: "credential",
      userId: id,
      password: await context.password.hash(password),
    });
    const first = await authCall("/sign-in/email", { email, password });
    const passwordOnly = cookieOf(first, "session_token");
    if (!authenticator) {
      return { id, cookie: passwordOnly };
    }
    expect((await authCall("/two-factor/enable", { password }, passwordOnly)).status).toBe(200);
    const code = await createOTP(await secretOf(id), { digits: 6, period: 30 }).totp();
    const verified = await authCall("/two-factor/verify-totp", { code }, passwordOnly);
    expect(verified.status).toBe(200);
    return { id, cookie: cookieOf(verified, "session_token") };
  }

  const installationAudit = async (action: string) =>
    (await owner.select().from(auditLog).where(isNull(auditLog.tenantId))).filter(
      (entry) => entry.action === action,
    );

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
    // Notification mail from the environment (delivered into `sent` by the mock above).
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_FROM = "restow@example.com";

    authModule = await import("../auth.js");
    const { buildApp } = await import("../app.js");
    app = buildApp();
    await owner.insert(settings).values({
      singleton: true,
      operatingMode: "public",
      publicUrl: PUBLIC_URL,
      setupCompletedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    const shared = await import("../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it("offers the reset by mail on the login page", async () => {
    const response = await app.fetch(new Request(`${PUBLIC_URL}/api/v1/setup/state`));
    const state = (await response.json()) as { passwordReset: boolean; notificationMail: boolean };
    expect(state.notificationMail).toBe(true);
    expect(state.passwordReset).toBe(true);
  });

  it("answers an unknown address like a known one, and mails nothing", async () => {
    const response = await authCall("/request-password-reset", { email: "nobody@example.com" });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toEqual([]);
  });

  it("mails nothing to an account without an authenticator app", async () => {
    await createAccount("no-app@example.com", "no-app-password-1", { authenticator: false });
    const response = await authCall("/request-password-reset", { email: "no-app@example.com" });
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toEqual([]);
  });

  it("resets the password by mail, ends every session and keeps the authenticator", async () => {
    const email = "reset@example.com";
    const { id, cookie } = await createAccount(email, "old-password-1234", { authenticator: true });

    const response = await authCall("/request-password-reset", { email });
    expect(response.status).toBe(200);
    await waitFor(() => sent.length === 1);
    expect(sent[0]?.to).toBe(email);
    const link = /https?:\/\/\S+/.exec(sent[0]?.text ?? "")?.[0] ?? "";
    const url = new URL(link);
    expect(url.origin).toBe(PUBLIC_URL);
    expect(url.pathname).toBe("/reset-password");
    const token = url.searchParams.get("token") ?? "";
    expect(token).not.toBe("");

    // A second request soon after sends no second mail.
    expect((await authCall("/request-password-reset", { email })).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toHaveLength(1);

    const reset = await authCall("/reset-password", { token, newPassword: "new-password-5678" });
    expect(reset.status).toBe(200);
    // The token works once.
    expect(
      (await authCall("/reset-password", { token, newPassword: "other-password-9999" })).status,
    ).toBe(400);

    // The old session is gone; the new password still needs the authenticator code.
    expect((await authCall("/get-session", undefined, cookie)).status).toBe(200);
    const session = (await (await authCall("/get-session", undefined, cookie)).json()) as unknown;
    expect(session).toBeNull();
    const old = await authCall("/sign-in/email", { email, password: "old-password-1234" });
    expect(old.status).toBe(401);
    const signIn = await authCall("/sign-in/email", { email, password: "new-password-5678" });
    expect(signIn.status).toBe(200);
    expect(((await signIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);

    const entries = await installationAudit("account.password_reset");
    expect(entries.map((entry) => entry.target)).toContain(id);
  });

  it("changes the own password only with the current one, and audits it", async () => {
    const email = "change@example.com";
    const { id, cookie } = await createAccount(email, "current-password-1", {
      authenticator: true,
    });
    const wrong = await authCall(
      "/change-password",
      { currentPassword: "not-the-password", newPassword: "changed-password-2" },
      cookie,
    );
    expect(wrong.status).toBe(400);
    expect(await installationAudit("account.password_changed")).toHaveLength(0);

    const changed = await authCall(
      "/change-password",
      {
        currentPassword: "current-password-1",
        newPassword: "changed-password-2",
        revokeOtherSessions: true,
      },
      cookie,
    );
    expect(changed.status).toBe(200);
    // The replacement session is a full one (it keeps how the old one was established).
    const fresh = cookieOf(changed, "session_token");
    const me = await app.fetch(
      new Request(`${PUBLIC_URL}/api/v1/me`, { headers: { cookie: fresh } }),
    );
    expect(me.status).toBe(200);

    const entries = await installationAudit("account.password_changed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.target).toBe(id);
    expect(entries[0]?.details).toMatchObject({ otherSessionsEnded: true });
  });

  it("lists the own sessions and signs one of them out", async () => {
    const email = "sessions@example.com";
    const password = "session-password-1";
    const { id, cookie } = await createAccount(email, password, { authenticator: true });
    // A second browser.
    const first = await authCall("/sign-in/email", { email, password });
    const challenge = cookieOf(first, "two_factor");
    const code = await createOTP(await secretOf(id), { digits: 6, period: 30 }).totp();
    const other = cookieOf(
      await authCall("/two-factor/verify-totp", { code }, challenge),
      "session_token",
    );

    const listed = (await (await authCall("/list-sessions", undefined, cookie)).json()) as {
      token: string;
    }[];
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const otherToken = decodeURIComponent(other.split("=")[1] ?? "").split(".")[0] ?? "";
    expect(listed.map((row) => row.token)).toContain(otherToken);

    expect((await authCall("/revoke-session", { token: otherToken }, cookie)).status).toBe(200);
    const after = (await (await authCall("/get-session", undefined, other)).json()) as unknown;
    expect(after).toBeNull();
  });
});
