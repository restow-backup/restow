/**
 * Forwarded copies against Postgres (docs/IMAP.md "Weiterleitung", 0.4.4), on the
 * application and installation roles with Row Level Security:
 *
 *   - the forwarding routes: 404 without the capability; the list issues nothing, says
 *     which accounts a job wants forwarded, pages by login; an account's address is issued
 *     once (idempotent, audited with a fingerprint), resolves at RCPT TO, and a rotation
 *     revokes the old one at once (audited);
 *   - the receiver: a plain copy to an account address belongs to that account, a second
 *     account in the same delivery gets a capture row; a plain copy to the tenant address is
 *     assigned by its headers; a journal report is still one; the IMAP sync and a forwarded
 *     copy of the same mail (both orders); the forwarded copies counted per account and the
 *     first journal report on the journal setup.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archive,
  EnvKeyProvider,
  generateDek,
  InstallationDefaultResolver,
  kekFromBase64,
} from "@restow/core";
import {
  archiveForwardAddresses,
  archiveItemCaptures,
  archiveItemMailboxes,
  archiveItems,
  auditLog,
  backupJobMembers,
  backupJobs,
  createDb,
  type Database,
  license,
  PgArchiveAppendStore,
  protectedObjects,
  providers,
  sources,
  tenantKeys,
  tenants,
  user,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../../../apps/api/src/auth.js";
import { DEFAULT_ARCHIVE_RETENTION_POLICY } from "../../../../apps/api/src/features/archive/retention-policy.js";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import { setInstallationDefaultResolver } from "../../../../apps/api/src/lib/installation-default.js";
import type { TenantEnv } from "../../../../apps/api/src/middleware/session.js";
import {
  provisionTestRoles,
  type TestDatabaseRoles,
} from "../../../../apps/api/src/testing/database-roles.js";
import { loadTenantKeyring, PgChunkIndex, tenantRunner } from "../journal/chunkstore.js";
import type { JournalReceiverDeps } from "../journal/receiver.js";
import { resolveArchiveRecipient } from "../journal/recipient.js";
import { resolveTenantWritableStorage } from "../journal/storage.js";
import type { ForwardingAccountDto, ForwardingDto, ForwardingEnvironment } from "./service.js";

const DATABASE = "restow_ee_forwarding_test";
const HOST = "archive.example.test";
const CRLF = "\r\n";

beforeAll(() => setInstallationDefaultResolver(new InstallationDefaultResolver({ ttlMs: 0 })));
afterAll(() => setInstallationDefaultResolver(null));

function testTenantAdmin(userId: string): MiddlewareHandler<TenantEnv> {
  return async (c, next) => {
    c.set("tenantId", c.req.header("x-restow-tenant") ?? "");
    c.set("role", "tenant_admin");
    c.set("user", { id: userId, email: "admin@contoso.example" } as unknown as SessionUser);
    await next();
  };
}

function copy(messageId: string, headers: string[] = [], body = "See you there."): Buffer {
  return Buffer.from(
    [
      ...headers,
      "From: Bob <bob@example.org>",
      "To: anna@contoso.example",
      "Subject: Plans",
      "Date: Tue, 03 Nov 2026 09:00:00 +0000",
      `Message-ID: <${messageId}>`,
      "",
      body,
      "",
    ].join(CRLF),
  );
}

function journalReport(messageId: string): Buffer {
  const original = [
    "From: sender@contoso.example",
    "To: anna@contoso.example",
    "Subject: Reported",
    `Message-ID: <${messageId}>`,
    "",
    "Body text.",
    "",
  ].join(CRLF);
  const boundary = "forwarding-test-boundary";
  return Buffer.from(
    [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "Sender: sender@contoso.example",
      `Message-Id: <${messageId}>`,
      "Recipient: anna@contoso.example",
      `--${boundary}`,
      "Content-Type: message/rfc822",
      "",
      original,
      `--${boundary}--`,
      "",
    ].join(CRLF),
  );
}

describe.skipIf(!testDatabaseAdminUrl)("forwarded copies against Postgres", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let roles: TestDatabaseRoles | undefined;
  let app: Hono;
  let contoso: string;
  let fabrikam: string;
  let imapSource: string;
  let anna: string;
  let ben: string;
  let carla: string;
  let fabrikamAccount: string;
  let storageDir: string;
  let deps: JournalReceiverDeps;
  let keyProvider: EnvKeyProvider;
  const adminId = randomUUID();
  const environment: ForwardingEnvironment = {
    journal: {
      port: 25,
      hostname: HOST,
      tlsCertPath: "/certs/journal.pem",
      tlsKeyPath: "/certs/journal.key",
      maxSizeBytes: 150 * 1024 * 1024,
    },
    docsTroubleshootingUrl: "https://docs.example.test/administrators/troubleshooting/",
    receiverState: () => ({ phase: "listening", port: 25 }),
  };

  const asTenant = (tenantId: string) => ({ "x-restow-tenant": tenantId });

  async function call<T>(method: string, path: string, tenantId = contoso): Promise<T> {
    const res = await app.request(path, { method, headers: asTenant(tenantId) });
    expect(res.status, `${method} ${path}`).toBe(200);
    return (await res.json()) as T;
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    roles = await provisionTestRoles(url);
    process.env.DATABASE_URL = roles.appUrl;
    process.env.DATABASE_PROVIDER_URL = roles.providerUrl;
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    storageDir = await mkdtemp(join(tmpdir(), "restow-forwarding-test-"));
    process.env.STORAGE_TARGET = "local";
    process.env.STORAGE_LOCAL_PATH = storageDir;
    owner = createDb(url);
    appDb = createDb(roles.appUrl);
    providerDb = createDb(roles.providerUrl);

    const { buildForwardingRoutes, FORWARDING_PATH } = await import("./routes.js");
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

    const kek = kekFromBase64(randomBytes(32).toString("base64"));
    keyProvider = new EnvKeyProvider(kek);
    for (const tenantId of [contoso, fabrikam]) {
      const wrapped = await keyProvider.wrapDek(generateDek(1));
      await owner
        .insert(tenantKeys)
        .values({ tenantId, keyVersion: 1, encryptedDek: wrapped.toString("base64") });
    }
    deps = {
      db: appDb,
      keyProvider,
      retentionPolicyFor: async () => DEFAULT_ARCHIVE_RETENTION_POLICY,
    };

    const [imap] = await owner
      .insert(sources)
      .values({ tenantId: contoso, kind: "imap", name: "Hoster", host: "imap.hoster.example" })
      .returning();
    imapSource = imap?.id ?? "";
    const accounts = await owner
      .insert(protectedObjects)
      .values(
        ["anna@contoso.example", "ben@contoso.example", "carla@contoso.example"].map((login) => ({
          tenantId: contoso,
          sourceId: imapSource,
          kind: "imap" as const,
          externalId: login,
        })),
      )
      .returning();
    [anna, ben, carla] = accounts.map((row) => row.id) as [string, string, string];
    const [fabrikamSource] = await owner
      .insert(sources)
      .values({ tenantId: fabrikam, kind: "imap", name: "Hoster", host: "imap.hoster.example" })
      .returning();
    const [other] = await owner
      .insert(protectedObjects)
      .values({
        tenantId: fabrikam,
        sourceId: fabrikamSource?.id ?? "",
        kind: "imap",
        externalId: "zoe@fabrikam.example",
      })
      .returning();
    fabrikamAccount = other?.id ?? "";

    // Anna's job wants the forwarded copy; Ben's only the IMAP sync; Carla is in no job.
    const [forwardJob, syncJob] = await owner
      .insert(backupJobs)
      .values([
        {
          tenantId: contoso,
          kind: "mail",
          name: "Forward",
          archive: true,
          archiveCapture: { imap: { sync: true, forward: true } },
        },
        { tenantId: contoso, kind: "mail", name: "Sync", archive: true },
      ])
      .returning();
    await owner.insert(backupJobMembers).values([
      { tenantId: contoso, jobId: forwardJob?.id ?? "", protectedObjectId: anna },
      { tenantId: contoso, jobId: syncJob?.id ?? "", protectedObjectId: ben },
    ]);

    app = new Hono();
    app.onError(errorHandler);
    app.notFound(notFoundHandler);
    app.route(
      FORWARDING_PATH,
      gateRoutes(
        providerDb,
        "archive.journalReceiver",
        buildForwardingRoutes({
          db: appDb,
          requireAdmin: testTenantAdmin(adminId),
          environment: () => environment,
        }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    const shared = await import("../../../../apps/api/src/db.js");
    await Promise.all([
      shared.db.$client.end(),
      shared.providerDb.$client.end(),
      shared.authDb.$client.end(),
    ]);
    await appDb?.$client.end();
    await providerDb?.$client.end();
    await owner?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
    if (roles) {
      await roles.drop(testDatabaseAdminUrl as string);
    }
    if (storageDir) {
      await rm(storageDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("answers 404 without the Business edition", async () => {
    const res = await app.request("/archive/forwarding", { headers: asTenant(contoso) });
    expect(res.status).toBe(404);
    const post = await app.request(`/archive/forwarding/${anna}/address`, {
      method: "POST",
      headers: asTenant(contoso),
    });
    expect(post.status).toBe(404);
  });

  describe("with the Business edition", () => {
    beforeAll(async () => {
      await owner.insert(license).values({
        edition: "business",
        active: true,
        installationId: "test-installation",
      });
    });

    let annaAddress = "";

    it("lists the accounts without issuing anything, and pages by login", async () => {
      const page = await call<ForwardingDto>("GET", "/archive/forwarding");
      expect(page.accounts.map((a) => [a.login, a.forwardWanted, a.status, a.address])).toEqual([
        ["anna@contoso.example", true, "no_address", null],
        ["ben@contoso.example", false, "no_address", null],
        ["carla@contoso.example", false, "no_address", null],
      ]);
      expect(page.hostname).toBe(HOST);
      expect(page.receiver).toEqual({ listening: true, reason: null });
      expect(page.tenantAddress).toBeNull();
      expect(page.nextCursor).toBeNull();
      expect(await owner.select().from(archiveForwardAddresses)).toEqual([]);

      const wanted = await call<ForwardingDto>("GET", "/archive/forwarding?wanted=true");
      expect(wanted.accounts.map((a) => a.login)).toEqual(["anna@contoso.example"]);

      const first = await call<ForwardingDto>("GET", "/archive/forwarding?limit=2");
      expect(first.accounts).toHaveLength(2);
      const rest = await call<ForwardingDto>(
        "GET",
        `/archive/forwarding?limit=2&cursor=${first.nextCursor}`,
      );
      expect(rest.accounts.map((a) => a.login)).toEqual(["carla@contoso.example"]);
      expect(rest.nextCursor).toBeNull();
      const bad = await app.request("/archive/forwarding?cursor=nope", {
        headers: asTenant(contoso),
      });
      expect(bad.status).toBe(400);
    });

    it("issues an account's address once, audited with a fingerprint, resolvable at RCPT TO", async () => {
      const issued = await call<ForwardingAccountDto>(
        "POST",
        `/archive/forwarding/${anna}/address`,
      );
      expect(issued.address).toMatch(
        new RegExp(`^archive\\+[a-z2-7]{32}@${HOST.replaceAll(".", "\\.")}$`),
      );
      expect(issued.status).toBe("no_copies");
      const again = await call<ForwardingAccountDto>("POST", `/archive/forwarding/${anna}/address`);
      expect(again.address).toBe(issued.address);
      annaAddress = issued.address as string;

      const entries = await owner
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, contoso),
            eq(auditLog.action, "archive.forward.address_created"),
          ),
        );
      expect(entries).toHaveLength(1);
      expect(entries[0]?.target).toBe(anna);
      const token = annaAddress.slice("archive+".length, annaAddress.indexOf("@"));
      expect(JSON.stringify(entries[0])).not.toContain(token);
      expect(Object.keys(entries[0]?.details ?? {})).toEqual(["fingerprint"]);

      expect(await resolveArchiveRecipient(providerDb, annaAddress.toUpperCase())).toEqual({
        kind: "account",
        tenantId: contoso,
        protectedObjectId: anna,
      });
    });

    it("refuses an account of another tenant, an unknown id and a non-IMAP object", async () => {
      for (const id of [fabrikamAccount, randomUUID(), "not-a-uuid"]) {
        const res = await app.request(`/archive/forwarding/${id}/address`, {
          method: "POST",
          headers: asTenant(contoso),
        });
        expect(res.status).toBe(404);
      }
    });

    it("rotates: the old address is refused at once, the rotation is audited", async () => {
      const rotated = await call<ForwardingAccountDto>("POST", `/archive/forwarding/${ben}/rotate`);
      const benFirst = rotated.address as string;
      const again = await call<ForwardingAccountDto>("POST", `/archive/forwarding/${ben}/rotate`);
      expect(again.address).not.toBe(benFirst);
      expect(await resolveArchiveRecipient(providerDb, benFirst)).toBeNull();
      expect(await resolveArchiveRecipient(providerDb, again.address as string)).toMatchObject({
        protectedObjectId: ben,
      });
      const actions = (
        await owner
          .select({ action: auditLog.action, details: auditLog.details })
          .from(auditLog)
          .where(and(eq(auditLog.tenantId, contoso), eq(auditLog.target, ben)))
      ).map((row) => [row.action, Object.keys(row.details ?? {}).sort()]);
      expect(actions).toEqual([
        ["archive.forward.address_created", ["fingerprint"]],
        ["archive.forward.address_rotated", ["fingerprint", "previousFingerprint"]],
      ]);
    });

    it("archives a copy to an account address for that account, a second account by a capture row", async () => {
      const { receiveArchiveMail } = await import("../journal/receiver.js");
      const receipt = await receiveArchiveMail(
        {
          tenantId: contoso,
          recipients: [
            { kind: "account", tenantId: contoso, protectedObjectId: anna },
            { kind: "account", tenantId: contoso, protectedObjectId: carla },
          ],
          mailFrom: "SRS0=x=y=example.org=bob@hoster.example",
          rcptTo: [annaAddress, "archive+other@archive.example.test"],
        },
        copy("plans-1@example.org", [`Delivered-To: ${annaAddress}`]),
        deps,
      );
      expect(receipt).toMatchObject({ kind: "forwarded_copy", outcome: "stored" });
      const [item] = await owner
        .select()
        .from(archiveItems)
        .where(eq(archiveItems.id, receipt.itemId));
      expect(item?.capturedVia).toBe("smtp_forward");
      expect(item?.protectedObjectId).toBe(anna);
      expect(item?.subject).toBe("Plans");
      const captures = await owner
        .select()
        .from(archiveItemCaptures)
        .where(eq(archiveItemCaptures.archiveItemId, receipt.itemId));
      expect(captures.map((row) => [row.capturedVia, row.protectedObjectId])).toEqual([
        ["smtp_forward", carla],
      ]);

      const page = await call<ForwardingDto>("GET", "/archive/forwarding");
      const byLogin = new Map(page.accounts.map((a) => [a.login, a]));
      expect(byLogin.get("anna@contoso.example")).toMatchObject({
        status: "receiving",
        activity: { last24Hours: 1, last7Days: 1 },
      });
      expect(byLogin.get("carla@contoso.example")?.activity.last7Days).toBe(1);
    });

    it("assigns a copy to the tenant address by its headers; a journal report stays one", async () => {
      const { receiveArchiveMail } = await import("../journal/receiver.js");
      const tenantCopy = await receiveArchiveMail(
        {
          tenantId: contoso,
          recipients: [{ kind: "tenant", tenantId: contoso }],
          mailFrom: "bob@example.org",
          rcptTo: [`journal+t@${HOST}`],
        },
        copy("routed-1@example.org", ["X-Original-To: ben@contoso.example"]),
        deps,
      );
      const [item] = await owner
        .select()
        .from(archiveItems)
        .where(eq(archiveItems.id, tenantCopy.itemId));
      expect(item?.protectedObjectId).toBeNull();
      expect(item?.capturedVia).toBe("smtp_forward");
      const assigned = await owner
        .select({ objectId: archiveItemMailboxes.protectedObjectId })
        .from(archiveItemMailboxes)
        .where(eq(archiveItemMailboxes.archiveItemId, tenantCopy.itemId));
      // To: anna (header) and ben (X-Original-To).
      expect(assigned.map((row) => row.objectId).sort()).toEqual([anna, ben].sort());

      const report = await receiveArchiveMail(
        {
          tenantId: contoso,
          recipients: [{ kind: "tenant", tenantId: contoso }],
          mailFrom: "journal@contoso.onmicrosoft.com",
          rcptTo: [`journal+t@${HOST}`],
        },
        journalReport("reported-1@contoso.example"),
        deps,
      );
      expect(report.kind).toBe("journal_report");
      const [reported] = await owner
        .select()
        .from(archiveItems)
        .where(eq(archiveItems.id, report.itemId));
      expect(reported?.capturedVia).toBe("journal");

      const page = await call<ForwardingDto>("GET", "/archive/forwarding");
      expect(page.tenantActivity.last7Days).toBe(1);

      const { getJournalSetup } = await import("../journal/setup.js");
      const setup = await getJournalSetup(
        appDb,
        contoso,
        { userId: adminId, label: "admin@contoso.example", ip: null },
        environment,
      );
      expect(setup.firstReportAt).not.toBeNull();
      expect(setup.counts.last24Hours).toBe(1);
    });

    it("dedupes the IMAP sync and a forwarded copy of one mail by their rank", async () => {
      const { receiveArchiveMail } = await import("../journal/receiver.js");
      const imapSync = async (raw: Buffer, ref: string) =>
        archive.captureArchiveItem({
          tenantId: contoso,
          storage: await resolveTenantWritableStorage(appDb, contoso),
          keys: await loadTenantKeyring({ db: appDb, tenantId: contoso, keyProvider }),
          index: new PgChunkIndex(tenantRunner(appDb, contoso), contoso),
          store: new PgArchiveAppendStore(appDb, contoso) as archive.ArchiveAppendStore,
          original: raw,
          source: "imap_sync",
          receivedAt: new Date(),
          envelope: null,
          flags: [],
          messageId: /Message-ID: <([^>]+)>/.exec(raw.toString())?.[1] ?? null,
          retentionPolicy: DEFAULT_ARCHIVE_RETENTION_POLICY,
          protectedObjectId: anna,
          externalRef: ref,
          duplicates: "merge",
        });
      const forward = (raw: Buffer) =>
        receiveArchiveMail(
          {
            tenantId: contoso,
            recipients: [{ kind: "account", tenantId: contoso, protectedObjectId: anna }],
            mailFrom: "bob@example.org",
            rcptTo: [annaAddress],
          },
          raw,
          deps,
        );

      // The forwarded copy first (the usual order: at transport): the IMAP sync of the same
      // mail, with the mailbox's own headers, is a capture row on it, no second item.
      const delivered = copy("first-forwarded@example.org", ["Received: by mx.hoster.example"]);
      const inMailbox = copy("first-forwarded@example.org", [
        "Return-Path: <bob@example.org>",
        "Received: by imap.hoster.example",
      ]);
      const forwarded = await forward(delivered);
      const synced = await imapSync(inMailbox, "INBOX;1;7");
      expect(synced).toMatchObject({ outcome: "duplicate", itemId: forwarded.itemId });

      // The IMAP sync first: the forwarded copy is the stronger capture (at transport) and
      // becomes the item that supersedes the synced one; search shows the newer only.
      const late = copy("synced-first@example.org");
      const first = await imapSync(late, "INBOX;1;8");
      expect(first.outcome).toBe("stored");
      const second = await forward(late);
      expect(second.outcome).toBe("stored");
      const [superseding] = await owner
        .select()
        .from(archiveItems)
        .where(eq(archiveItems.id, second.itemId));
      expect(superseding?.supersedesItemId).toBe(first.outcome === "stored" ? first.record.id : "");

      // The same copy delivered twice (a sender's retry after a lost 250): one item.
      const retry = await forward(late);
      expect(retry).toMatchObject({ outcome: "duplicate", itemId: second.itemId });
    });
  });
});
