/**
 * Postgres-backed proof that a `per_mailbox` IMAP source is actually usable.
 * Regression: earlier, `createSource` always inserted status
 * `pending`, and the only thing that ever moved a source out of it was a
 * green source-level probe (`testSource`) — which a `per_mailbox` source can
 * never run, since it has no login of its own. That left every `per_mailbox`
 * source permanently `pending`, and `backupRejection` (apps/worker) refuses
 * to back up a `pending` source, so none of its mailboxes could ever be
 * protected. The documented migration path (an existing `shared` source
 * switched to `per_mailbox`) broke the same way: the mode change set
 * `connectionChanged`, which moved the source to `pending` with nothing left
 * to move it back out again.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_sources_status_test` is recreated there and dropped
 * after). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Database, createDb, protectedObjects, providers, sources, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { Actor } from "./service.js";

const DATABASE = "restow_sources_status_test";

type Service = typeof import("./service.js");
type DirectoryService = typeof import("../directory/service.js");

// A private-network literal: `assessHost` (@restow/core) classifies an IP
// address without a DNS lookup, so this test never depends on the network.
// A provider admin may save it directly (docs/IMAP.md).
const HOST = "10.0.0.5";

const providerAdmin = (): Actor => ({
  id: randomUUID(),
  email: "provider@contoso.example",
  ip: "192.0.2.10",
  isProviderAdmin: true,
});

// The directory feature's own Actor shape (label/userId, not id/email/isProviderAdmin):
// importAccounts and setObjectCredential live there, not in sources/service.ts.
const directoryActor = () => ({
  userId: randomUUID(),
  label: "provider@contoso.example",
  ip: "192.0.2.10",
});

describe.skipIf(!testDatabaseAdminUrl)("IMAP source status against Postgres", () => {
  let db: Database;
  let service: Service;
  let directoryService: DirectoryService;
  let tenantId: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
    db = createDb(url);
    service = await import("./service.js");
    directoryService = await import("../directory/service.js");
    const secretStore = await import("../../lib/secrets.js");

    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({
        providerId: provider?.id as string,
        name: "Contoso",
        slug: `contoso-${randomUUID().slice(0, 8)}`,
      })
      .returning();
    tenantId = tenant?.id as string;
    await db.transaction((tx) => secretStore.createTenantKey(tx, tenantId));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("a freshly created per_mailbox source is active immediately, not stuck pending", async () => {
    const created = await service.createSource(
      db,
      tenantId,
      {
        kind: "imap",
        name: "Hoster Per-Mailbox",
        host: HOST,
        port: 993,
        security: "tls",
        username: "unused@hoster.example",
        imapAuthMode: "per_mailbox",
      },
      providerAdmin(),
    );
    expect(created.status).toBe("active");
    expect(created.imap?.imapAuthMode).toBe("per_mailbox");
    expect(created.imap?.hasPassword).toBe(false);

    // Backup eligibility (apps/worker/src/handlers/backup.ts backupRejection)
    // only ever refuses a "pending" or "disabled" source; this one is neither.
    const [row] = await db.select().from(sources).where(eq(sources.id, created.id));
    expect(row?.status).toBe("active");
  });

  it("switching an existing shared source to per_mailbox does not leave it pending forever", async () => {
    const shared = await service.createSource(
      db,
      tenantId,
      {
        kind: "imap",
        name: "Migrating Source",
        host: HOST,
        port: 993,
        security: "tls",
        username: "shared-login@hoster.example",
        password: "s3cret-shared-password",
        imapAuthMode: "shared",
      },
      providerAdmin(),
    );
    expect(shared.status).toBe("pending");

    // The documented migration path: flip the mode, nothing else. No
    // password is sent (per_mailbox has none of its own) and none is needed.
    const migrated = await service.updateSource(
      db,
      tenantId,
      shared.id,
      { imapAuthMode: "per_mailbox" },
      providerAdmin(),
    );
    expect(migrated.status).toBe("active");
    expect(migrated.imap?.imapAuthMode).toBe("per_mailbox");
  });

  it("editing a per_mailbox source's host never demands a source-level password, since it has none of its own", async () => {
    const source = await service.createSource(
      db,
      tenantId,
      {
        kind: "imap",
        name: "Per-Mailbox Endpoint Edit",
        host: HOST,
        port: 993,
        security: "tls",
        username: "unused@hoster.example",
        imapAuthMode: "per_mailbox",
      },
      providerAdmin(),
    );

    const updated = await service.updateSource(
      db,
      tenantId,
      source.id,
      { host: "10.0.0.6", username: "still-unused@hoster.example" },
      providerAdmin(),
    );
    expect(updated.imap?.host).toBe("10.0.0.6");
    expect(updated.status).toBe("active");
  });

  it("clears every mailbox's stored password when a per_mailbox source's host changes, instead of reusing it against the new endpoint", async () => {
    // mayReuseStoredPassword's invariant (a stored password only ever travels
    // to the host it was sealed for) also has to hold per mailbox, not just
    // for the source-level secret: otherwise a tenant admin who repoints a
    // per_mailbox source at their own server, by accident or on purpose,
    // would have every mailbox's password sent there on the next backup,
    // restore or test login.
    const source = await service.createSource(
      db,
      tenantId,
      {
        kind: "imap",
        name: "Per-Mailbox Host Move",
        host: HOST,
        port: 993,
        security: "tls",
        username: "unused@hoster.example",
        imapAuthMode: "per_mailbox",
      },
      providerAdmin(),
    );
    const imported = await directoryService.importAccounts(
      db,
      tenantId,
      source.id,
      [
        { line: null, login: "alice@hoster.example", password: "alice-s3cret" },
        { line: null, login: "bob@hoster.example", password: "bob-s3cret" },
      ],
      directoryActor(),
      { dryRun: false },
    );
    expect(imported.created).toBe(2);

    const before = await db
      .select({ id: protectedObjects.id, secretRef: protectedObjects.secretRef })
      .from(protectedObjects)
      .where(eq(protectedObjects.sourceId, source.id));
    expect(before).toHaveLength(2);
    for (const row of before) {
      expect(row.secretRef).not.toBeNull();
    }

    await service.updateSource(db, tenantId, source.id, { host: "10.0.0.6" }, providerAdmin());

    const after = await db
      .select({
        id: protectedObjects.id,
        secretRef: protectedObjects.secretRef,
        credentialStatus: protectedObjects.credentialStatus,
        credentialCheckedAt: protectedObjects.credentialCheckedAt,
        credentialError: protectedObjects.credentialError,
      })
      .from(protectedObjects)
      .where(eq(protectedObjects.sourceId, source.id));
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.secretRef).toBeNull();
      expect(row.credentialStatus).toBeNull();
      expect(row.credentialCheckedAt).toBeNull();
      expect(row.credentialError).toBeNull();
    }

    // A host change that is not actually a change (same host, different
    // casing or spacing) must not wipe passwords that are still valid.
    const untouchedSource = await service.createSource(
      db,
      tenantId,
      {
        kind: "imap",
        name: "Per-Mailbox Host Unchanged",
        host: HOST,
        port: 993,
        security: "tls",
        username: "unused2@hoster.example",
        imapAuthMode: "per_mailbox",
      },
      providerAdmin(),
    );
    await directoryService.importAccounts(
      db,
      tenantId,
      untouchedSource.id,
      [{ line: null, login: "carol@hoster.example", password: "carol-s3cret" }],
      directoryActor(),
      { dryRun: false },
    );
    await service.updateSource(
      db,
      tenantId,
      untouchedSource.id,
      { host: `  ${HOST.toUpperCase()}  ` },
      providerAdmin(),
    );
    const [unchanged] = await db
      .select({ secretRef: protectedObjects.secretRef })
      .from(protectedObjects)
      .where(eq(protectedObjects.sourceId, untouchedSource.id));
    expect(unchanged?.secretRef).not.toBeNull();
  });
});
