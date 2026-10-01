/**
 * Postgres-backed tests of the directory service: the bulk protection
 * endpoint (explicit ids and "select all matching", reused per-object logic,
 * capped selection, cross-source ids ignored, audit) and the `selected`
 * protection mode (only explicitly included objects are protected, the rest
 * read as "not selected" rather than "excluded", the exclusion list plays no
 * part, switching modes never touches existing objects' backups).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_directory_test` is recreated there and dropped
 * after). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  auditLog,
  createDb,
  jobs,
  protectedObjects,
  providers,
  secrets,
  snapshots,
  sources,
  tenants,
  users,
} from "@restow/db";
import { and, eq } from "drizzle-orm";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import { rulesSchema } from "./schemas.js";

const DATABASE = "restow_api_directory_test";

type Service = typeof import("./service.js");
// `./enqueue.js` pulls in `jobs/queue.js` and then `config.js`, whose
// `config` singleton reads `RESTOW_MASTER_KEY` at module-evaluation time
// (apps/api/src/config.ts). CI runs this suite with only
// RESTOW_TEST_DATABASE_URL set, so it has to be a dynamic import loaded from
// `beforeAll` after the master key is set, exactly like `service` below, not
// a static import at the top of the file (that ran before `beforeAll` ever
// executed and made every test in this suite fail).
type Enqueue = typeof import("./enqueue.js");

const actor = (label = "admin@contoso.example") => ({
  userId: randomUUID(),
  label,
  ip: "192.0.2.10",
});

describe.skipIf(!testDatabaseAdminUrl)("directory service against Postgres", () => {
  let db: Database;
  let service: Service;
  let enqueueDirectorySync: Enqueue["enqueueDirectorySync"];
  let tenantId: string;

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    const boss = new PgBoss({ connectionString: url });
    await boss.start();
    await boss.createQueue("directory");
    await boss.createQueue("backup");
    await boss.stop({ graceful: false, wait: true });

    // Per-mailbox credentials are sealed with the tenant DEK; both the master
    // key and the tenant's own key must exist before that (same setup other
    // pg-backed suites use, e.g. webhooks/integrations.pg.test.ts). This also
    // has to run before the dynamic imports below, since both `./service.js`
    // and `./enqueue.js` pull in `config.js`, which reads the env once at
    // module-evaluation time.
    process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");

    db = createDb(url);
    service = await import("./service.js");
    enqueueDirectorySync = (await import("./enqueue.js")).enqueueDirectorySync;
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

  /** A fresh, connected m365 source with `n` mailboxes, everyone protected by default (`all` mode). */
  async function m365Source(name: string, n: number) {
    const [source] = await db
      .insert(sources)
      .values({
        tenantId,
        kind: "m365",
        name,
        status: "active",
        entraTenantId: randomUUID(),
      })
      .returning();
    const sourceId = source?.id as string;
    const objectIds: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const email = `user${i}@${name.toLowerCase()}.example`;
      const [user] = await db
        .insert(users)
        .values({ tenantId, email, displayName: `User ${i}`, entraObjectId: randomUUID() })
        .returning();
      const [object] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId,
          userId: user?.id,
          kind: "mailbox",
          origin: "directory_sync",
          status: "active",
          externalId: email,
          displayName: `User ${i}`,
        })
        .returning();
      objectIds.push(object?.id as string);
    }
    return { sourceId, objectIds };
  }

  /** A fresh IMAP source with `n` manually added accounts, all protected. */
  async function imapSource(name: string, n: number) {
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "imap", name, status: "active" })
      .returning();
    const sourceId = source?.id as string;
    const objectIds: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const [object] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId,
          kind: "imap",
          origin: "manual",
          status: "active",
          externalId: `account${i}@${name.toLowerCase()}.example`,
        })
        .returning();
      objectIds.push(object?.id as string);
    }
    return { sourceId, objectIds };
  }

  describe("bulk protection", () => {
    it("includes explicit ids, reusing the per-object logic, and audits it", async () => {
      const { sourceId, objectIds } = await m365Source("Bulk-Ids", 5);
      // Exclude two by hand first, so "include" has something to reverse.
      await service.setObjectProtection(
        db,
        tenantId,
        objectIds[0] as string,
        { action: "exclude" },
        actor(),
      );
      await service.setObjectProtection(
        db,
        tenantId,
        objectIds[1] as string,
        { action: "exclude" },
        actor(),
      );

      const target = [objectIds[0] as string, objectIds[1] as string, objectIds[2] as string];
      const result = await service.bulkSetProtection(
        db,
        tenantId,
        sourceId,
        { action: "include", objectIds: target, reason: "quarterly review" },
        actor("bulk-admin@contoso.example"),
      );
      expect(result).toMatchObject({ sourceId, action: "include", matched: 3, updated: 3 });

      const rows = await db
        .select()
        .from(protectedObjects)
        .where(and(eq(protectedObjects.sourceId, sourceId), eq(protectedObjects.status, "active")));
      expect(rows.map((row) => row.id).sort()).toEqual(
        [...objectIds].sort(), // everyone active again: the 3 targeted plus the 2 never touched
      );

      // One audit entry per object plus one batch summary, all naming the actor and reason.
      const perObject = await db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, "directory.protection.changed")),
        );
      const fromThisBulk = perObject.filter(
        (entry) => (entry.details as { action?: string } | null)?.action === "include",
      );
      expect(fromThisBulk.map((entry) => entry.target).sort()).toEqual([...target].sort());
      const [batch] = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantId),
            eq(auditLog.action, "directory.protection.bulk_changed"),
            eq(auditLog.target, sourceId),
          ),
        );
      expect(batch).toMatchObject({
        actor: "bulk-admin@contoso.example",
        details: expect.objectContaining({
          action: "include",
          reason: "quarterly review",
          selection: "ids",
          matched: 3,
          updated: 3,
        }),
      });
    });

    it("ignores ids that belong to a different source", async () => {
      const a = await m365Source("Bulk-Cross-A", 2);
      const b = await m365Source("Bulk-Cross-B", 1);

      const result = await service.bulkSetProtection(
        db,
        tenantId,
        a.sourceId,
        { action: "exclude", objectIds: [a.objectIds[0] as string, b.objectIds[0] as string] },
        actor(),
      );
      // Only the id that actually belongs to source A was applied.
      expect(result).toMatchObject({ matched: 2, updated: 1 });

      const [untouched] = await db
        .select({ status: protectedObjects.status })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, b.objectIds[0] as string));
      expect(untouched?.status).toBe("active");
    });

    it("selects everything a filter matches, queues the sync a reset needs, and reports the outcome", async () => {
      const { sourceId } = await m365Source("Bulk-Filter", 4);

      const result = await service.bulkSetProtection(
        db,
        tenantId,
        sourceId,
        { action: "reset", filter: { status: "active" } },
        actor(),
      );
      expect(result).toMatchObject({ matched: 4, updated: 4 });
      // A reset only the sync can settle; one must have been queued (or already was).
      expect(result.sync).not.toBeNull();
      expect(["queued", "already_queued"]).toContain(result.sync?.status);

      const [job] = await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.queue, "directory")));
      expect(job).toBeDefined();
    });

    it("rejects a bulk reset on an IMAP source instead of re-protecting excluded accounts (MEDIUM-2)", async () => {
      const { sourceId, objectIds } = await imapSource("Bulk-Imap-Reset", 3);
      await service.setObjectProtection(
        db,
        tenantId,
        objectIds[0] as string,
        { action: "exclude" },
        actor(),
      );

      await expect(
        service.bulkSetProtection(
          db,
          tenantId,
          sourceId,
          { action: "reset", objectIds: [objectIds[0] as string] },
          actor(),
        ),
      ).rejects.toMatchObject({ status: 409 });

      // The deliberately excluded account must still be excluded: IMAP has no
      // rules for "reset" to fall back to, unlike an M365 object.
      const [row] = await db
        .select({ status: protectedObjects.status })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectIds[0] as string));
      expect(row?.status).toBe("excluded");
    });
  });

  describe("`selected` protection mode", () => {
    it("protects only explicitly included objects; the rest read as not selected, not excluded", async () => {
      const { sourceId, objectIds } = await m365Source("Selected-Mode", 4);

      const rules = await service.updateRules(
        db,
        tenantId,
        sourceId,
        rulesSchema.parse({ mode: "selected", exclude: ["stale@example.com"] }),
        actor(),
      );
      // The list plays no part while `selected` is active, but it is kept
      // (not wiped) so a later switch back to `all`/`group` does not
      // silently un-exclude these identities (MEDIUM-1).
      expect(rules.rules).toMatchObject({ mode: "selected", exclude: ["stale@example.com"] });

      // Nothing is protected by default: `updateRules` itself only stores the
      // rules (a sync evaluates them). Simulate that sync's outcome first —
      // everyone falls back to excluded, since nobody has been chosen yet —
      // then an admin includes one object, exactly as `evaluateProtection`
      // and an `include` override would leave things.
      await db
        .update(protectedObjects)
        .set({ status: "excluded" })
        .where(eq(protectedObjects.sourceId, sourceId));
      await service.setObjectProtection(
        db,
        tenantId,
        objectIds[0] as string,
        { action: "include" },
        actor(),
      );

      const page = await service.listObjects(db, tenantId, {
        sourceId,
        page: 1,
        pageSize: 50,
        sort: "name",
        order: "asc",
      });
      const byId = new Map(page.items.map((item) => [item.id, item]));
      expect(byId.get(objectIds[0] as string)).toMatchObject({
        status: "active",
        override: "include",
        notSelected: false,
      });
      expect(byId.get(objectIds[1] as string)).toMatchObject({
        status: "excluded",
        override: null,
        notSelected: true,
      });

      // The `excluded` filter is only the explicit decisions; `not_selected`
      // is the mode's default. Together they cover every unprotected object.
      const excludedOnly = await service.listObjects(db, tenantId, {
        sourceId,
        status: "excluded",
        page: 1,
        pageSize: 50,
        sort: "name",
        order: "asc",
      });
      expect(excludedOnly.items.map((item) => item.id)).not.toContain(objectIds[1]);

      const notSelected = await service.listObjects(db, tenantId, {
        sourceId,
        status: "not_selected",
        page: 1,
        pageSize: 50,
        sort: "name",
        order: "asc",
      });
      expect(notSelected.items.map((item) => item.id).sort()).toEqual(
        [objectIds[1], objectIds[2], objectIds[3]].sort(),
      );
      expect(notSelected.items.every((item) => item.status === "excluded")).toBe(true);
    });

    it("keeps objects of a source whose config lacks scope and directory keys in the filters", async () => {
      // Sources created before the scope and directory keys existed have an
      // empty config; SQL NULL must not drop their rows from negated filters.
      const { sourceId, objectIds } = await m365Source("Legacy-Config", 2);
      await db
        .update(protectedObjects)
        .set({ status: "excluded" })
        .where(eq(protectedObjects.id, objectIds[0] as string));
      const query = { sourceId, page: 1, pageSize: 50, sort: "name", order: "asc" } as const;

      const excluded = await service.listObjects(db, tenantId, { ...query, status: "excluded" });
      expect(excluded.items.map((item) => item.id)).toEqual([objectIds[0]]);

      const notShared = await service.listObjects(db, tenantId, {
        ...query,
        sharedOrBlocked: false,
      });
      expect(notShared.items.map((item) => item.id).sort()).toEqual([...objectIds].sort());
    });

    it("never deletes backups when an object leaves the scope", async () => {
      const { sourceId, objectIds } = await m365Source("Selected-Mode-Backups", 1);
      const objectId = objectIds[0] as string;
      await db.insert(snapshots).values({
        tenantId,
        protectedObjectId: objectId,
        sequence: 1,
        startedAt: new Date("2026-09-01T00:00:00Z"),
        completedAt: new Date("2026-09-01T01:00:00Z"),
        manifestPath: `tenants/${tenantId}/manifests/${randomUUID()}`,
        itemCount: 10,
        byteSize: 1000,
      });

      await service.updateRules(
        db,
        tenantId,
        sourceId,
        rulesSchema.parse({ mode: "selected" }),
        actor(),
      );
      // The object was never included: it is not selected, and it has no
      // override, so a directory sync would exclude it. Simulate that.
      await db
        .update(protectedObjects)
        .set({ status: "excluded" })
        .where(eq(protectedObjects.id, objectId));

      const [snapshotRow] = await db
        .select()
        .from(snapshots)
        .where(eq(snapshots.protectedObjectId, objectId));
      expect(snapshotRow).toBeDefined();
      expect(snapshotRow?.status).toBe("active");
    });
  });

  describe("directory sync enqueue", () => {
    it("is idempotent: a second request finds the one already queued", async () => {
      const { sourceId } = await m365Source("Sync-Idempotent", 1);

      const first = await enqueueDirectorySync(db, tenantId, sourceId);
      expect(first.status).toBe("queued");

      const second = await enqueueDirectorySync(db, tenantId, sourceId);
      expect(second).toEqual({ status: "already_queued", jobId: first.jobId });

      const rows = await db
        .select()
        .from(jobs)
        .where(
          and(eq(jobs.tenantId, tenantId), eq(jobs.queue, "directory"), eq(jobs.status, "queued")),
        );
      expect(
        rows.filter(
          (row) => row.payload && (row.payload as { sourceId?: string }).sourceId === sourceId,
        ),
      ).toHaveLength(1);
    });
  });

  describe("per-mailbox credentials (imapAuthMode per_mailbox)", () => {
    /** A fresh per_mailbox IMAP source with one manually added account, no password yet. */
    async function perMailboxSource(name: string) {
      const [source] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name,
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
          config: { imapAuthMode: "per_mailbox" },
        })
        .returning();
      const sourceId = source?.id as string;
      const outcome = await service.importAccounts(
        db,
        tenantId,
        sourceId,
        [{ line: null, login: `box@${name.toLowerCase()}.example` }],
        actor(),
        { dryRun: false },
      );
      const objectId = (
        await db
          .select({ id: protectedObjects.id })
          .from(protectedObjects)
          .where(eq(protectedObjects.sourceId, sourceId))
      )[0]?.id as string;
      return { sourceId, objectId, login: outcome.accounts[0]?.login as string };
    }

    it("sets a password, never returns it, and audits without the value", async () => {
      const { objectId } = await perMailboxSource("Creds-Set");
      const before = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));

      const dto = await service.setObjectCredential(
        db,
        tenantId,
        objectId,
        { password: "s3cret-mailbox-password" },
        actor("provider@contoso.example"),
      );

      expect(dto.credential).toEqual({
        authMode: "per_mailbox",
        hasPassword: true,
        status: "untested",
        checkedAt: null,
        error: null,
        errorReason: null,
        failure: null,
      });
      expect(JSON.stringify(dto)).not.toContain("s3cret-mailbox-password");

      const after = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
      const entry = after.find(
        (row) => row.id !== undefined && !before.some((b) => b.id === row.id),
      );
      expect(entry?.action).toBe("directory.account.credential_set");
      expect(JSON.stringify(entry)).not.toContain("s3cret-mailbox-password");

      const [row] = await db
        .select({
          secretRef: protectedObjects.secretRef,
          status: protectedObjects.credentialStatus,
        })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectId));
      expect(row?.secretRef).toBeTruthy();
      expect(row?.status).toBe("untested");
    });

    it("replacing an existing password keeps the same secret row and resets the check", async () => {
      const { objectId } = await perMailboxSource("Creds-Replace");
      await service.setObjectCredential(db, tenantId, objectId, { password: "first" }, actor());
      const [{ secretRef: firstSecretRef }] = await db
        .select({ secretRef: protectedObjects.secretRef })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectId));
      await db
        .update(protectedObjects)
        .set({ credentialStatus: "ok", credentialCheckedAt: new Date() })
        .where(eq(protectedObjects.id, objectId));

      await service.setObjectCredential(db, tenantId, objectId, { password: "second" }, actor());
      const [row] = await db
        .select({
          secretRef: protectedObjects.secretRef,
          status: protectedObjects.credentialStatus,
          checkedAt: protectedObjects.credentialCheckedAt,
        })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectId));
      expect(row?.secretRef).toBe(firstSecretRef);
      expect(row?.status).toBe("untested");
      expect(row?.checkedAt).toBeNull();
    });

    it("test-login refuses a mailbox with no password, with a clear cause and no crash", async () => {
      const { objectId } = await perMailboxSource("Creds-NoPassword");
      await expect(service.testObjectCredential(db, tenantId, objectId, actor())).rejects.toThrow(
        /no password/i,
      );
    });

    it("cannot be set or tested from another tenant (tenant isolation)", async () => {
      const { objectId } = await perMailboxSource("Creds-Isolation");
      const [provider] = await db.insert(providers).values({ name: "Other" }).returning();
      const [otherTenant] = await db
        .insert(tenants)
        .values({
          providerId: provider?.id as string,
          name: "Other Tenant",
          slug: `other-${randomUUID().slice(0, 8)}`,
        })
        .returning();
      const otherTenantId = otherTenant?.id as string;

      await expect(
        service.setObjectCredential(db, otherTenantId, objectId, { password: "x" }, actor()),
      ).rejects.toThrow(/not found/i);
      await expect(
        service.testObjectCredential(db, otherTenantId, objectId, actor()),
      ).rejects.toThrow(/not found/i);
    });

    it("rejects a password on a non-IMAP object", async () => {
      const { objectIds } = await m365Source("Creds-M365", 1);
      await expect(
        service.setObjectCredential(
          db,
          tenantId,
          objectIds[0] as string,
          { password: "x" },
          actor(),
        ),
      ).rejects.toThrow(/only imap accounts/i);
    });

    it("rejects setting a password on a shared or master_user source, which has none of its own", async () => {
      // Regression: nothing read a password sealed here (the CSV import
      // already refuses to seal one outside per_mailbox), but the endpoint
      // itself still accepted and stored one, an unaudited secret sitting
      // unused. Matches the CSV behaviour: reject with 409 instead.
      const [sharedSource] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name: "Creds-Shared-Reject",
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
          username: "shared-login@hoster.example",
          config: {},
        })
        .returning();
      const sharedOutcome = await service.importAccounts(
        db,
        tenantId,
        sharedSource?.id as string,
        [{ line: null, login: "shared-box@hoster.example" }],
        actor(),
        { dryRun: false },
      );
      expect(sharedOutcome.created).toBe(1);
      const [sharedObjectId] = await db
        .select({ id: protectedObjects.id })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, sharedSource?.id as string));
      await expect(
        service.setObjectCredential(
          db,
          tenantId,
          sharedObjectId?.id as string,
          { password: "x" },
          actor(),
        ),
      ).rejects.toThrow(/no password of its own/i);

      const [masterSource] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name: "Creds-Master-Reject",
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
          config: {
            imapAuthMode: "master_user",
            masterUser: { username: "master", style: "dovecot_separator" },
          },
        })
        .returning();
      const masterOutcome = await service.importAccounts(
        db,
        tenantId,
        masterSource?.id as string,
        [{ line: null, login: "master-box@hoster.example" }],
        actor(),
        { dryRun: false },
      );
      expect(masterOutcome.created).toBe(1);
      const [masterObjectId] = await db
        .select({ id: protectedObjects.id })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, masterSource?.id as string));
      await expect(
        service.setObjectCredential(
          db,
          tenantId,
          masterObjectId?.id as string,
          { password: "x" },
          actor(),
        ),
      ).rejects.toThrow(/no password of its own/i);
    });

    it("CSV import with a password column seals it and never echoes it back", async () => {
      const [source] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name: "Creds-Csv",
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
          config: { imapAuthMode: "per_mailbox" },
        })
        .returning();
      const sourceId = source?.id as string;

      const outcome = await service.importAccountsCsv(
        db,
        tenantId,
        sourceId,
        "login,password\nalice@creds-csv.example,alice-secret\n",
        actor(),
        { dryRun: false },
      );
      expect(outcome.accounts).toEqual([
        {
          login: "alice@creds-csv.example",
          email: "alice@creds-csv.example",
          displayName: null,
          state: "new",
          hasPassword: true,
        },
      ]);
      expect(JSON.stringify(outcome)).not.toContain("alice-secret");

      const [row] = await db
        .select({
          secretRef: protectedObjects.secretRef,
          status: protectedObjects.credentialStatus,
        })
        .from(protectedObjects)
        .where(
          and(
            eq(protectedObjects.sourceId, sourceId),
            eq(protectedObjects.externalId, "alice@creds-csv.example"),
          ),
        );
      expect(row?.secretRef).toBeTruthy();
      expect(row?.status).toBe("untested");
    });

    it("CSV import on a shared source never seals a password column, and says so", async () => {
      // Regression: the code sealed a CSV password regardless of auth mode
      // while the schema and csv.ts docs both said it was "ignored" outside
      // per_mailbox; an unneeded secret was stored.
      const [source] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name: "Creds-Csv-Shared",
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
          username: "shared-login@creds-csv-shared.example",
          config: { imapAuthMode: "shared" },
        })
        .returning();
      const sourceId = source?.id as string;

      const outcome = await service.importAccountsCsv(
        db,
        tenantId,
        sourceId,
        "login,password\nbob@creds-csv-shared.example,bob-secret\n",
        actor(),
        { dryRun: false },
      );
      // The row is still imported; only its password is not what gets stored.
      expect(outcome.accounts).toEqual([
        {
          login: "bob@creds-csv-shared.example",
          email: "bob@creds-csv-shared.example",
          displayName: null,
          state: "new",
          hasPassword: false,
        },
      ]);
      expect(JSON.stringify(outcome)).not.toContain("bob-secret");

      const [row] = await db
        .select({
          secretRef: protectedObjects.secretRef,
          status: protectedObjects.credentialStatus,
        })
        .from(protectedObjects)
        .where(
          and(
            eq(protectedObjects.sourceId, sourceId),
            eq(protectedObjects.externalId, "bob@creds-csv-shared.example"),
          ),
        );
      expect(row?.secretRef).toBeNull();
      expect(row?.status).toBeNull();
    });

    it("never queues a first backup for a per_mailbox account imported without a password", async () => {
      // Regression: queuing it anyway produced a first job certain to fail
      // with "no password set" (and a job.failed webhook/ticket) for every
      // mailbox of a hoster customer before the admin could reach it.
      const [source] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name: "Creds-NoQueue",
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
          config: { imapAuthMode: "per_mailbox" },
        })
        .returning();
      const sourceId = source?.id as string;

      const outcome = await service.importAccountsCsv(
        db,
        tenantId,
        sourceId,
        "login,password\nwithpw@creds-noqueue.example,pw-secret\nwithoutpw@creds-noqueue.example,\n",
        actor(),
        { dryRun: false },
      );
      expect(outcome.accounts.map((a) => ({ login: a.login, hasPassword: a.hasPassword }))).toEqual(
        [
          { login: "withpw@creds-noqueue.example", hasPassword: true },
          { login: "withoutpw@creds-noqueue.example", hasPassword: false },
        ],
      );

      const objects = await db
        .select({ id: protectedObjects.id, externalId: protectedObjects.externalId })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, sourceId));
      const withPassword = objects.find((o) => o.externalId === "withpw@creds-noqueue.example");
      const withoutPassword = objects.find(
        (o) => o.externalId === "withoutpw@creds-noqueue.example",
      );

      const backupJobs = await db
        .select({ protectedObjectId: jobs.protectedObjectId })
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.queue, "backup")));
      const queuedIds = new Set(backupJobs.map((row) => row.protectedObjectId));
      expect(queuedIds.has(withPassword?.id as string)).toBe(true);
      expect(queuedIds.has(withoutPassword?.id as string)).toBe(false);

      // Setting the missing password afterwards queues the first backup it
      // never got.
      await service.setObjectCredential(
        db,
        tenantId,
        withoutPassword?.id as string,
        { password: "now-set" },
        actor(),
      );
      const afterSet = await db
        .select({ protectedObjectId: jobs.protectedObjectId })
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.queue, "backup")));
      expect(afterSet.some((row) => row.protectedObjectId === withoutPassword?.id)).toBe(true);
    });
  });

  describe("deleteAccount", () => {
    it("removes the mailbox's sealed password from `secrets`, not only the protected_objects row", async () => {
      // Regression: `protected_objects.secret_ref` references `secrets` with
      // ON DELETE SET NULL, which only covers the secret being deleted first.
      // Deleting the object itself left the secret behind, unreferenced and
      // still decryptable, since nothing ever selected it by anything other
      // than id.
      const [source] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name: "Delete-Account-Cleanup",
          status: "active",
          host: "imap.hoster.test",
          port: 993,
          security: "tls",
          config: { imapAuthMode: "per_mailbox" },
        })
        .returning();
      const sourceId = source?.id as string;
      await service.importAccounts(
        db,
        tenantId,
        sourceId,
        [{ line: null, login: "delete-me@hoster.example" }],
        actor(),
        { dryRun: false },
      );
      const [object] = await db
        .select({ id: protectedObjects.id })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, sourceId));
      const objectId = object?.id as string;
      const dto = await service.setObjectCredential(
        db,
        tenantId,
        objectId,
        { password: "s3cret-mailbox-password" },
        actor(),
      );
      expect(dto.credential?.hasPassword).toBe(true);
      const [{ secretRef }] = await db
        .select({ secretRef: protectedObjects.secretRef })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectId));
      expect(secretRef).toBeTruthy();

      await service.deleteAccount(db, tenantId, objectId, actor());

      const [objectRow] = await db
        .select()
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectId));
      expect(objectRow).toBeUndefined();
      const [secretRow] = await db
        .select()
        .from(secrets)
        .where(eq(secrets.id, secretRef as string));
      expect(secretRow).toBeUndefined();
    });

    it("leaves a manually added account with no password of its own alone (nothing to clean up)", async () => {
      const { objectIds } = await imapSource("Delete-Account-No-Password", 1);
      await service.deleteAccount(db, tenantId, objectIds[0] as string, actor());
      const [row] = await db
        .select()
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectIds[0] as string));
      expect(row).toBeUndefined();
    });
  });
});
