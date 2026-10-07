/**
 * Postgres-backed test of the notification mail transports with sealed
 * credentials: the own Microsoft 365 app registration and the Google service
 * account key go to the installation secret store (never to `settings` or a
 * response), switching transports deletes what the new one does not use, a
 * test send opens the stored credential (Graph faked at `fetch`), and removing
 * the configuration destroys every credential.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_mailtransports_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { type Database, auditLog, createDb, secrets, settings } from "@restow/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type TestDatabaseRoles, provisionTestRoles } from "../../testing/database-roles.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { updateSettingsSchema } from "./schemas.js";

const DATABASE = "restow_api_mailtransports_test";
const actor = { id: "provider-admin", email: "admin@provider.test", ip: "192.0.2.10" };
const context = { observedOrigin: null };
const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CLIENT_SECRET = "fixture~own~app~secret~value";

const PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const KEY_FILE = JSON.stringify({
  type: "service_account",
  project_id: "restow-notify",
  private_key_id: "kid",
  private_key: PRIVATE_KEY,
  client_email: "notify@restow-notify.iam.gserviceaccount.com",
  client_id: "112233445566778899",
});

describe.skipIf(!testDatabaseAdminUrl)(
  "mail transports with sealed credentials against Postgres",
  () => {
    let db: Database;
    let roles: TestDatabaseRoles | undefined;
    let service: typeof import("./service.js");
    let providerDb: Database;

    const mailSecrets = () =>
      db
        .select({ kind: secrets.kind, ciphertext: secrets.ciphertext })
        .from(secrets)
        .where(isNull(secrets.tenantId));
    const row = async () => (await db.select().from(settings))[0];
    const patch = (body: unknown) => updateSettingsSchema.parse(body);

    beforeAll(async () => {
      const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
      roles = await provisionTestRoles(url);
      process.env.DATABASE_URL = roles.appUrl;
      process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
      process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
      db = createDb(url);
      service = await import("./service.js");
      providerDb = (await import("../../db.js")).providerDb;
      await db.insert(settings).values({ singleton: true, operatingMode: "local" });
    }, 60_000);

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    afterAll(async () => {
      const shared = await import("../../db.js");
      await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
      await db?.$client.end();
      await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
      await roles?.drop(testDatabaseAdminUrl as string);
    });

    it("seals the Google key, keeps only its public facts and never returns it", async () => {
      const view = await service.updateSettings(
        providerDb,
        patch({
          mail: {
            transport: "google",
            google: { sender: "alerts@example.com", serviceAccountKey: KEY_FILE },
          },
        }),
        actor,
        context,
      );
      expect(view.mail).toEqual({
        transport: "google",
        google: {
          sender: "alerts@example.com",
          serviceAccountEmail: "notify@restow-notify.iam.gserviceaccount.com",
          clientId: "112233445566778899",
          keyStored: true,
        },
      });
      expect(JSON.stringify(view)).not.toContain("PRIVATE KEY");
      const stored = await row();
      expect(stored?.mailTransport).toBe("google");
      expect(JSON.stringify(stored?.mailConfig)).not.toContain("PRIVATE KEY");
      const sealed = await mailSecrets();
      expect(sealed.map((secret) => secret.kind)).toEqual(["mail_google_key"]);
      expect(sealed[0]?.ciphertext).not.toContain("PRIVATE");

      // A new sender keeps the stored key.
      const again = await service.updateSettings(
        providerDb,
        patch({ mail: { transport: "google", google: { sender: "ops@example.com" } } }),
        actor,
        context,
      );
      expect(again.mail).toMatchObject({ google: { sender: "ops@example.com", keyStored: true } });
    });

    it("switches to the own Microsoft 365 app: seals its secret, deletes the Google key", async () => {
      const view = await service.updateSettings(
        providerDb,
        patch({
          mail: {
            transport: "graph",
            graph: {
              sender: "alerts@contoso.com",
              tenantId: TENANT,
              app: "own",
              ownApp: {
                clientId: CLIENT_ID,
                credentialKind: "secret",
                clientSecret: CLIENT_SECRET,
              },
            },
          },
        }),
        actor,
        context,
      );
      expect(view.mail).toEqual({
        transport: "graph",
        graph: {
          sender: "alerts@contoso.com",
          tenantId: TENANT,
          app: "own",
          ownApp: { clientId: CLIENT_ID, credentialKind: "secret", credentialStored: true },
        },
      });
      expect(JSON.stringify(view)).not.toContain(CLIENT_SECRET);
      const sealed = await mailSecrets();
      expect(sealed.map((secret) => secret.kind)).toEqual(["mail_graph_app"]);
      expect(sealed[0]?.ciphertext).not.toContain(CLIENT_SECRET);

      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "settings.updated"), isNull(auditLog.tenantId)))
        .orderBy(auditLog.createdAt)
        .limit(1)
        .offset(2);
      expect(JSON.stringify(entry?.details)).not.toContain(CLIENT_SECRET);
      expect((entry?.details as { changes: string[] }).changes).toContain(
        "mail.graphAppCredential",
      );
    });

    it("tests with the stored credential and explains Graph's refusal", async () => {
      const calls: string[] = [];
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/oauth2/v2.0/token")) {
          expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe(CLIENT_SECRET);
          return Response.json({ access_token: "eyJ.fixture", expires_in: 3600 });
        }
        return Response.json(
          { error: { code: "ErrorAccessDenied", message: "Access is denied." } },
          { status: 403 },
        );
      });
      const result = await service.sendTestMail(providerDb, { to: "ops@example.com" }, actor, "de");
      expect(result).toMatchObject({
        ok: false,
        transport: "graph",
        failure: { reason: "graph_send_denied" },
      });
      expect(calls).toEqual([
        `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
        "https://graph.microsoft.com/v1.0/users/alerts%40contoso.com/sendMail",
      ]);
    });

    it("refuses a draft for another app without its credential", async () => {
      await expect(
        service.sendTestMail(
          providerDb,
          {
            mail: {
              transport: "graph",
              graph: {
                sender: "alerts@contoso.com",
                tenantId: TENANT,
                app: "own",
                ownApp: {
                  clientId: "99999999-8888-7777-6666-555555555555",
                  credentialKind: "secret",
                },
              },
            },
          },
          actor,
          "en",
        ),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("removing the configuration destroys every mail credential", async () => {
      const view = await service.removeMailConfiguration(providerDb, actor, context);
      expect(view.mail).toEqual({ transport: null });
      expect(await mailSecrets()).toEqual([]);
      const [entry] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, "settings.mail.removed"), isNull(auditLog.tenantId)));
      expect(entry?.details).toMatchObject({
        previousTransport: "graph",
        credentialsDeleted: ["mail_graph_app"],
      });
    });
  },
);
