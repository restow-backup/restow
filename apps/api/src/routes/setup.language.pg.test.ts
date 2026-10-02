/**
 * Postgres-backed test of the two things the setup wizard's first-run steps
 * added (apps/web routes/setup):
 *
 *   - the language the operator chose in the first step is the language of the
 *     operator's own organisation (`tenants.language`) and of the names of the
 *     alert rules created with it; the mails and reports of that tenant follow
 *     the tenant's language (the installation keeps no default language of its
 *     own, only the fallback constant of @restow/i18n);
 *   - the mail step can be skipped: the setup is complete without a transport,
 *     `settings.mail_transport` and `mail_config` stay null, and everything that
 *     would send mail says "no transport" instead of failing (an invitation shows
 *     its link to copy, `createInstallationNotifier` answers null).
 *
 * One installation, one setup: the tests run in file order. The suite drives the
 * real application (apps/api/src/app.ts) on the roles Row Level Security binds, as
 * routes/setup.pg.test.ts does. Runs when RESTOW_TEST_DATABASE_URL points at a
 * Postgres server; without it the suite is skipped.
 */
import { randomBytes } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  reportRules,
  secrets,
  settings,
  tenants,
  user,
} from "@restow/db";
import { createI18n } from "@restow/i18n";
import { eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../features/snapshots/testing/explorer-fixture.js";
import { type TestDatabaseRoles, provisionTestRoles } from "../testing/database-roles.js";

const DATABASE = "restow_api_setup_language_test";
const PUBLIC_URL = "http://localhost:3000";
const ADMIN_EMAIL = "ops@example.com";
const ADMIN_PASSWORD = "correct-horse-battery-1";
const SETUP_TOKEN = "7QKMZ-RT4VX-9HBNP-2WCAE";
const PROVIDER_NAME = "Beispiel IT-Service GmbH";

/** What the wizard sends when the operator skips the mail step: no `mail`, no test message. */
const SKIPPED_MAIL_SETUP = {
  operatingMode: "local",
  providerName: PROVIDER_NAME,
  language: "de",
  firstAdmin: { name: "Operator", email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  sendTest: false,
};

describe.skipIf(!testDatabaseAdminUrl)("setup language and skipped mail against Postgres", () => {
  let owner: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let version: string;

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
    ({ DISCLAIMER_VERSION: version } = await import("../lib/disclaimer.js"));
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await owner?.$client.end();
    Reflect.deleteProperty(process.env, "RESTOW_SETUP_TOKEN");
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    await roles?.drop(testDatabaseAdminUrl as string);
  }, 30_000);

  const submitSetup = (body: Record<string, unknown>) =>
    Promise.resolve(
      app.fetch(
        new Request(`${PUBLIC_URL}/api/v1/setup`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-restow-setup-token": SETUP_TOKEN,
          },
          body: JSON.stringify(body),
        }),
      ),
    );

  const settingsRow = async () => (await owner.select().from(settings).limit(1))[0];

  it("refuses a test message without a mail transport, with a 422 on sendTest, and writes nothing", async () => {
    const response = await submitSetup({
      ...SKIPPED_MAIL_SETUP,
      disclaimer: { version, accepted: true },
      sendTest: true,
    });
    expect(response.status).toBe(422);
    const problem = (await response.json()) as { issues?: { path: string[] }[] };
    expect(problem.issues?.map((issue) => issue.path)).toEqual([["sendTest"]]);
    expect(await owner.select({ id: user.id }).from(user)).toEqual([]);
    expect(await settingsRow()).toBeUndefined();
    expect(await owner.select({ id: tenants.id }).from(tenants)).toEqual([]);
  });

  it("refuses a language the wizard does not offer, and writes nothing", async () => {
    const response = await submitSetup({
      ...SKIPPED_MAIL_SETUP,
      language: "fr",
      disclaimer: { version, accepted: true },
    });
    expect(response.status).toBe(422);
    expect(await settingsRow()).toBeUndefined();
  });

  it("completes the setup without a mail transport and attempts no test message", async () => {
    const response = await submitSetup({
      ...SKIPPED_MAIL_SETUP,
      disclaimer: { version, accepted: true },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      ownOrganisation: { created: true },
      testSend: { attempted: false, ok: false },
    });

    const row = await settingsRow();
    expect(row?.setupCompletedAt).not.toBeNull();
    expect(row?.mailTransport).toBeNull();
    expect(row?.mailConfig).toBeNull();
    // No transport, so no SMTP password in the secret store either.
    expect(
      await owner.select({ id: secrets.id }).from(secrets).where(eq(secrets.kind, "smtp_password")),
    ).toEqual([]);

    const completed = (await owner.select().from(auditLog).where(isNull(auditLog.tenantId))).find(
      (entry) => entry.action === "setup.completed",
    );
    expect(completed?.details).toMatchObject({ mailTransport: null });
  });

  it("reports the installation as configured without a mail transport", async () => {
    const response = await app.fetch(new Request(`${PUBLIC_URL}/api/v1/setup/state`));
    expect(await response.json()).toMatchObject({ configured: true, mailTransport: null });
  });

  it("makes the chosen language the language of the own organisation and of the names of its alert rules", async () => {
    const rows = await owner.select().from(tenants);
    expect(rows).toHaveLength(1);
    const own = rows[0] as (typeof rows)[number];
    expect(own).toMatchObject({ name: PROVIDER_NAME, kind: "internal", language: "de" });

    // The rules are written in the tenant's language, and their mails follow the tenant's
    // language as long as a rule names none of its own (features/reports/dispatcher.ts).
    const german = createI18n({ lng: "de" });
    const rules = await owner.select().from(reportRules).where(eq(reportRules.tenantId, own.id));
    expect(rules.map((rule) => rule.name).sort()).toEqual(
      [
        String(german.t("reports:defaultRules.jobFailures")),
        String(german.t("reports:defaultRules.readinessRed")),
      ].sort(),
    );
    expect(rules.map((rule) => rule.language)).toEqual([null, null]);
  });

  it("says 'no transport' wherever mail would be sent, instead of failing", async () => {
    const shared = await import("../db.js");
    const { createInstallationNotifier } = await import("../features/settings/service.js");
    expect(await createInstallationNotifier(shared.db)).toBeNull();

    const { emailProviderInvitation } = await import("../features/accounts/service.js");
    // The owner then copies the link: the invitation exists, only the mail is not sent.
    expect(
      await emailProviderInvitation(shared.db, {
        email: "colleague@example.com",
        token: "not-a-real-token",
        language: "de",
      }),
    ).toBe("not_configured");
  });
});
