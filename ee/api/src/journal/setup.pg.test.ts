/**
 * Postgres-backed tests of the tenant's journal setup routes, mounted exactly
 * as the api mounts every ee/ route group (behind their license guard,
 * ../license/gate.ts `gateRoutes`): without the Business edition every path
 * answers 404 like an unregistered one; with it a tenant administrator gets
 * the journal address (issued and audited on the first call), sees what the
 * archive holds from the journal and can rotate the address, after which the
 * receiver's own lookup no longer finds the old one.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_ee_journal_setup_test` is recreated there
 * and dropped after, the roles with it). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  archiveItems,
  auditLog,
  createDb,
  license,
  providers,
  tenants,
  user,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../../../apps/api/src/auth.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import type { TenantEnv } from "../../../../apps/api/src/middleware/session.js";
import {
  type TestDatabaseRoles,
  provisionTestRoles,
} from "../../../../apps/api/src/testing/database-roles.js";
import type { JournalReceiverState } from "./receiver-state.js";
import { tenantIdForJournalAddress } from "./recipient.js";
import type { JournalSetupDto, JournalSetupEnvironment } from "./setup.js";

const DATABASE = "restow_ee_journal_setup_test";
const HOST = "archive.example.test";
const NOW = new Date("2026-09-30T12:00:00Z");

/** Stand-in for requireTenant("tenant_admin"): the tenant comes from the header. */
function testTenantAdmin(userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", "tenant_admin");
    c.set("user", { id: userId, email: "admin@contoso.example" } as unknown as SessionUser);
    await next();
  };
}

describe.skipIf(!testDatabaseAdminUrl)("journal setup against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  const adminId = randomUUID();

  let receiver: JournalReceiverState = { phase: "listening", port: 25 };
  let environment: JournalSetupEnvironment;

  const asTenant = (tenantId: string) => ({ "x-restow-tenant": tenantId });

  async function getSetup(tenantId: string): Promise<JournalSetupDto> {
    const res = await app.request("/archive/journal", { headers: asTenant(tenantId) });
    expect(res.status).toBe(200);
    return (await res.json()) as JournalSetupDto;
  }

  async function rotate(tenantId: string): Promise<JournalSetupDto> {
    const res = await app.request("/archive/journal/rotate", {
      method: "POST",
      headers: asTenant(tenantId),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as JournalSetupDto;
  }

  async function storedToken(tenantId: string): Promise<string | null> {
    const [row] = await owner.select().from(tenants).where(eq(tenants.id, tenantId));
    return row?.journalToken ?? null;
  }

  async function insertItem(
    tenantId: string,
    capturedVia: "journal" | "graph_sync",
    receivedAt: Date,
  ) {
    const id = randomUUID();
    await owner.insert(archiveItems).values({
      id,
      tenantId,
      messageId: `<${id}@contoso.example>`,
      itemHash: randomBytes(32).toString("hex"),
      chainHash: randomBytes(32).toString("hex"),
      receivedAt,
      capturedVia,
      storagePath: `tenants/${tenantId}/archive/${id}`,
    });
  }

  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);

    const { buildJournalRoutes, JOURNAL_PATH } = await import("./routes.js");
    const { gateRoutes } = await import("../license/gate.js");
    const { errorHandler, notFoundHandler } = await import("../../../../apps/api/src/problem.js");

    const [provider] = await owner.insert(providers).values({ name: "Provider" }).returning();
    const created = await owner
      .insert(tenants)
      .values([
        { providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" },
        { providerId: provider?.id ?? "", name: "Fabrikam", slug: "fabrikam" },
      ])
      .returning();
    contoso = created.find((row) => row.slug === "contoso")?.id ?? "";
    fabrikam = created.find((row) => row.slug === "fabrikam")?.id ?? "";
    await owner.insert(user).values({ id: adminId, name: "Admin", email: "admin@contoso.example" });

    environment = {
      journal: {
        port: 25,
        hostname: HOST,
        tlsCertPath: "/certs/journal.pem",
        tlsKeyPath: "/certs/journal.key",
        maxSizeBytes: 150 * 1024 * 1024,
      },
      docsTroubleshootingUrl: "https://docs.example.test/administrators/troubleshooting/",
      receiverState: () => receiver,
      now: () => NOW,
    };

    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route(
      JOURNAL_PATH,
      gateRoutes(
        appDb,
        "archive.journalReceiver",
        buildJournalRoutes({
          db: appDb,
          requireAdmin: testTenantAdmin(adminId),
          environment: () => environment,
        }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([shared.db.$client.end(), shared.providerDb.$client.end()]);
    await appDb?.$client.end();
    await providerDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
  }, 60_000);

  it("answers 404 on the Community edition, as for an unregistered path", async () => {
    for (const [method, path] of [
      ["GET", "/archive/journal"],
      ["POST", "/archive/journal/rotate"],
    ] as const) {
      const res = await app.request(path, { method, headers: asTenant(contoso) });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { title: string; detail: string };
      expect(body.title).toBe("Not Found");
      expect(body.detail).toBe(`No handler for ${method} ${path}.`);
    }
    expect(await storedToken(contoso)).toBeNull();
  });

  describe("with the Business edition", () => {
    beforeAll(async () => {
      await owner.insert(license).values({
        edition: "business",
        active: true,
        installationId: "test-installation",
      });
    });

    it("issues the address on the first view, audited, and keeps it afterwards", async () => {
      const first = await getSetup(contoso);
      const token = await storedToken(contoso);
      expect(token).toMatch(/^[a-z2-7]{32}$/);
      expect(first.address).toBe(`journal+${token}@${HOST}`);
      expect(first.localPart).toBe(`journal+${token}`);
      expect(first.hostname).toBe(HOST);
      expect(first.hostnameIssue).toBeNull();

      const again = await getSetup(contoso);
      expect(again.address).toBe(first.address);
      expect(await storedToken(contoso)).toBe(token);

      const created = await owner
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, contoso),
            eq(auditLog.action, "archive.journal.address_created"),
          ),
        );
      expect(created).toHaveLength(1);
      expect(created[0]?.actor).toBe("admin@contoso.example");
      expect(created[0]?.actorUserId).toBe(adminId);
      expect(created[0]?.target).toBe(contoso);
      expect(JSON.stringify(created[0]?.details)).not.toContain(token ?? "missing");
    });

    it("issues one token when two first views race", async () => {
      const [a, b] = await Promise.all([getSetup(fabrikam), getSetup(fabrikam)]);
      expect(a.address).toBe(b.address);
      expect(a.address).toBe(`journal+${await storedToken(fabrikam)}@${HOST}`);
      const created = await owner
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, fabrikam),
            eq(auditLog.action, "archive.journal.address_created"),
          ),
        );
      expect(created).toHaveLength(1);
    });

    it("gives every tenant its own address, and the receiver's lookup resolves each", async () => {
      const a = await getSetup(contoso);
      const b = await getSetup(fabrikam);
      expect(a.address).not.toBe(b.address);
      expect(await tenantIdForJournalAddress(providerDb, a.address as string)).toBe(contoso);
      expect(await tenantIdForJournalAddress(providerDb, b.address as string)).toBe(fabrikam);
      // The host of an address is not part of the lookup, and mail systems fold the case.
      expect(await tenantIdForJournalAddress(providerDb, (a.address as string).toUpperCase())).toBe(
        contoso,
      );
    });

    it("rotates the address: the old one no longer resolves, the new one does, audited", async () => {
      const before = await getSetup(contoso);
      const rotated = await rotate(contoso);

      expect(rotated.address).not.toBe(before.address);
      expect(rotated.address).toBe(`journal+${await storedToken(contoso)}@${HOST}`);
      expect(await getSetup(contoso)).toMatchObject({ address: rotated.address });

      expect(await tenantIdForJournalAddress(providerDb, before.address as string)).toBeNull();
      expect(await tenantIdForJournalAddress(providerDb, rotated.address as string)).toBe(contoso);
      // Another tenant's address is untouched.
      expect(await getSetup(fabrikam)).toMatchObject({
        address: `journal+${await storedToken(fabrikam)}@${HOST}`,
      });

      const rows = await owner
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, contoso),
            eq(auditLog.action, "archive.journal.address_rotated"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe("admin@contoso.example");
      const details = JSON.stringify(rows[0]?.details);
      expect(details).toMatch(/"fingerprint":"[0-9a-f]{12}"/);
      expect(details).not.toContain((await storedToken(contoso)) ?? "missing");
    });

    it("reports the journal's activity from the archive, for this tenant and source only", async () => {
      await insertItem(contoso, "journal", hoursAgo(1));
      await insertItem(contoso, "journal", hoursAgo(20));
      await insertItem(contoso, "journal", hoursAgo(72));
      await insertItem(contoso, "journal", hoursAgo(24 * 10));
      await insertItem(contoso, "graph_sync", hoursAgo(0.5));
      await insertItem(fabrikam, "journal", hoursAgo(0.1));

      const setup = await getSetup(contoso);
      expect(setup.counts).toEqual({ last24Hours: 2, last7Days: 3 });
      expect(setup.lastReportAt).toBe(hoursAgo(1).toISOString());
      expect(setup.status).toBe("receiving");
      expect(setup.receiver).toEqual({ listening: true, reason: null });

      const other = await getSetup(fabrikam);
      expect(other.counts).toEqual({ last24Hours: 1, last7Days: 1 });
    });

    it("says stale when reports came but none for more than a day", async () => {
      const later = new Date(NOW.getTime() + 3 * 24 * 3_600_000);
      environment = { ...environment, now: () => later };
      try {
        const setup = await getSetup(contoso);
        expect(setup.status).toBe("stale");
        expect(setup.counts.last24Hours).toBe(0);
        expect(setup.lastReportAt).toBe(hoursAgo(1).toISOString());
      } finally {
        environment = { ...environment, now: () => NOW };
      }
    });

    it("says no reports yet while the receiver listens and nothing arrived", async () => {
      const [other] = await owner
        .insert(tenants)
        .values({
          providerId: (await owner.select().from(providers))[0]?.id ?? "",
          name: "Northwind",
          slug: "northwind",
        })
        .returning();
      const setup = await getSetup(other?.id ?? "");
      expect(setup.status).toBe("no_reports");
      expect(setup.lastReportAt).toBeNull();
      expect(setup.counts).toEqual({ last24Hours: 0, last7Days: 0 });
    });

    it("says why the receiver is not running, whatever arrived before", async () => {
      const cases: [JournalReceiverState, number | undefined, string][] = [
        [{ phase: "unstarted" }, 25, "not_started"],
        [{ phase: "edition_not_licensed" }, 25, "restart_required"],
        [{ phase: "failed", message: "listen EADDRINUSE" }, 25, "listen_failed"],
        [{ phase: "tls_not_configured" }, 25, "tls_not_configured"],
        [
          { phase: "tls_invalid", message: "the certificate file /secret/place/fullchain.pem" },
          25,
          "tls_invalid",
        ],
        [
          { phase: "tls_expired", message: "the certificate in /secret/place expired on 2026" },
          25,
          "tls_expired",
        ],
      ];
      const saved = environment;
      try {
        for (const [state, port, reason] of cases) {
          receiver = state;
          environment = { ...saved, journal: { ...saved.journal, port } };
          const setup = await getSetup(contoso);
          expect(setup.status).toBe("receiver_down");
          expect(setup.receiver).toEqual({ listening: false, reason });
          // The reason is a code: no internal message reaches a tenant administrator.
          expect(JSON.stringify(setup)).not.toContain("EADDRINUSE");
          expect(JSON.stringify(setup)).not.toContain("/secret/place");
        }
      } finally {
        receiver = { phase: "listening", port: 25 };
        environment = saved;
      }
    });

    it("tells a receiver that was never configured from one that is configured but down", async () => {
      const saved = environment;
      try {
        for (const state of [
          { phase: "port_not_configured" },
          // Whatever a listener recorded, an unset port is the reason that counts.
          { phase: "tls_not_configured" },
          { phase: "unstarted" },
        ] as const) {
          receiver = state;
          environment = { ...saved, journal: { ...saved.journal, port: undefined } };
          const setup = await getSetup(contoso);
          expect(setup.status).toBe("not_configured");
          expect(setup.receiver).toEqual({ listening: false, reason: "port_not_configured" });
          expect(setup.requirements.smtpPort).toBeNull();
          // The address is still issued: it is the tenant's, whether or not the receiver runs.
          expect(setup.localPart).toMatch(/^journal\+[a-z0-9]{32}$/);
        }
        // The same listener states with a port set are a configured receiver that is down.
        receiver = { phase: "unstarted" };
        environment = saved;
        expect((await getSetup(contoso)).status).toBe("receiver_down");
      } finally {
        receiver = { phase: "listening", port: 25 };
        environment = saved;
      }
    });

    it("does not call a certificate configured that the receiver cannot serve", async () => {
      const saved = receiver;
      try {
        for (const state of [
          { phase: "tls_invalid", message: "unreadable" },
          { phase: "tls_expired", message: "expired" },
        ] as const) {
          receiver = state;
          expect((await getSetup(contoso)).requirements.tlsConfigured).toBe(false);
        }
        receiver = { phase: "tls_not_configured" };
        expect((await getSetup(contoso)).receiver.reason).toBe("tls_not_configured");
      } finally {
        receiver = saved;
      }
      expect((await getSetup(contoso)).requirements.tlsConfigured).toBe(true);
    });

    it("tells what the network and Exchange Online need, from the configuration", async () => {
      const setup = await getSetup(contoso);
      expect(setup.requirements).toEqual({
        dnsName: HOST,
        smtpPort: 25,
        exchangePort: 25,
        portMismatch: false,
        tlsConfigured: true,
        maxMessageMegabytes: 150,
      });
      expect(setup.docsUrl).toBe("https://docs.example.test/administrators/exchange-journaling/");

      const saved = environment;
      try {
        environment = {
          ...saved,
          journal: {
            ...saved.journal,
            port: 2525,
            tlsCertPath: undefined,
            tlsKeyPath: undefined,
          },
        };
        const other = await getSetup(contoso);
        expect(other.requirements.smtpPort).toBe(2525);
        expect(other.requirements.portMismatch).toBe(true);
        expect(other.requirements.tlsConfigured).toBe(false);
      } finally {
        environment = saved;
      }
    });

    it("says so when no journal host is configured, and still keeps the token", async () => {
      const saved = environment;
      try {
        for (const [hostname, issue] of [
          [undefined, "missing"],
          ["https://archive.example.test/", "invalid"],
        ] as const) {
          environment = { ...saved, journal: { ...saved.journal, hostname } };
          const setup = await getSetup(contoso);
          expect(setup.address).toBeNull();
          expect(setup.hostname).toBeNull();
          expect(setup.hostnameIssue).toBe(issue);
          expect(setup.localPart).toBe(`journal+${await storedToken(contoso)}`);
          expect(setup.requirements.dnsName).toBeNull();
        }
      } finally {
        environment = saved;
      }
    });
  });
});
