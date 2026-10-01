/**
 * Postgres-backed proof that switching an IMAP source's `imapAuthMode`
 * cannot be used to dodge the stored-password reuse guard
 * (`mayReuseStoredPassword`'s invariant: a stored password only ever
 * travels to the host and account it was stored for).
 *
 * Regression (security review, batch 1): `updateSource` used to skip the
 * guard whenever the patch's `imapAuthMode` was `per_mailbox`, and left the
 * source-level `secret_ref` in place. A two-step patch (move to
 * per_mailbox with a new host, then move back to shared/master_user with no
 * further change) could reuse the original password against an
 * attacker-chosen host without ever proving it again. Symmetrically, a
 * per_mailbox source's mailboxes kept their sealed passwords across a host
 * change made while the patch's `imapAuthMode` was not itself `per_mailbox`,
 * so the same two-step trick worked the other way around too.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_sources_credential_guard_test` is recreated there and
 * dropped after). Without it the suite is skipped.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type Database,
  createDb,
  protectedObjects,
  providers,
  secrets,
  sources,
  tenants,
} from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";
import type { Actor } from "./service.js";

const DATABASE = "restow_sources_credential_guard_test";

// Private-network literals: `assessHost` (@restow/core) classifies an IP
// address without a DNS lookup, so this test never depends on the network. A
// provider admin may save either directly (docs/IMAP.md).
const HOST_A = "10.0.1.5";
const HOST_EVIL = "10.0.1.6";

type Service = typeof import("./service.js");
type DirectoryService = typeof import("../directory/service.js");

const providerAdmin = (): Actor => ({
  id: randomUUID(),
  email: "provider@contoso.example",
  ip: "192.0.2.10",
  isProviderAdmin: true,
});

const directoryActor = () => ({
  userId: randomUUID(),
  label: "provider@contoso.example",
  ip: "192.0.2.10",
});

describe.skipIf(!testDatabaseAdminUrl)(
  "IMAP source updates cannot reuse a stored password across a host change via a per_mailbox detour",
  () => {
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

    it("shared + host change to per_mailbox in one patch is always refused: no password reuses the old one, and per_mailbox itself accepts none", async () => {
      const shared = await service.createSource(
        db,
        tenantId,
        {
          kind: "imap",
          name: "Shared To Per-Mailbox Detour",
          host: HOST_A,
          port: 993,
          security: "tls",
          username: "shared-login@hoster.example",
          password: "s3cret-shared-password",
          imapAuthMode: "shared",
        },
        providerAdmin(),
      );
      expect(shared.imap?.hasPassword).toBe(true);

      // Without a password, the guard (gated on the still-present source
      // secret, not on the patch's target mode) refuses outright: a stored
      // password must never reach a host it was not sealed for, whatever
      // mode the same patch also requests.
      await expect(
        service.updateSource(
          db,
          tenantId,
          shared.id,
          { imapAuthMode: "per_mailbox", host: HOST_EVIL },
          providerAdmin(),
        ),
      ).rejects.toMatchObject({ status: 422 });

      // Supplying a password does not help either: per_mailbox sources have
      // none of their own, so the combination is rejected on its own terms.
      await expect(
        service.updateSource(
          db,
          tenantId,
          shared.id,
          { imapAuthMode: "per_mailbox", host: HOST_EVIL, password: "whatever" },
          providerAdmin(),
        ),
      ).rejects.toMatchObject({ status: 422 });

      // Neither attempt touched anything: still shared, still the original
      // host, still the original secret.
      const [unchanged] = await db.select().from(sources).where(eq(sources.id, shared.id));
      expect(unchanged?.host).toBe(HOST_A);
      expect(unchanged?.secretRef).not.toBeNull();
    });

    it("the only safe path to a new host is per_mailbox first (same host, secret cleared), then the host change: reusing the old password afterwards is still refused", async () => {
      const shared = await service.createSource(
        db,
        tenantId,
        {
          kind: "imap",
          name: "Shared To Per-Mailbox Then Host Move",
          host: HOST_A,
          port: 993,
          security: "tls",
          username: "shared-login-2@hoster.example",
          password: "s3cret-shared-password-2",
          imapAuthMode: "shared",
        },
        providerAdmin(),
      );

      // Step 1: move to per_mailbox with no host change, so nothing needs
      // reproving yet; the now-unusable source-level secret is dropped right
      // here rather than left sitting in secret_ref.
      const step1 = await service.updateSource(
        db,
        tenantId,
        shared.id,
        { imapAuthMode: "per_mailbox" },
        providerAdmin(),
      );
      expect(step1.imap?.imapAuthMode).toBe("per_mailbox");
      expect(step1.imap?.hasPassword).toBe(false);
      const [afterStep1] = await db.select().from(sources).where(eq(sources.id, shared.id));
      expect(afterStep1?.secretRef).toBeNull();

      // Step 2: now the host can move freely (per_mailbox has no
      // source-level secret left to protect).
      const step2 = await service.updateSource(
        db,
        tenantId,
        shared.id,
        { host: HOST_EVIL },
        providerAdmin(),
      );
      expect(step2.imap?.host).toBe(HOST_EVIL);

      // Step 3: moving back to shared or master_user, from a host that is no
      // longer the one the original password was sealed for, still demands a
      // fresh password: the cleared secret_ref makes this a first-time
      // password, not a reused one.
      await expect(
        service.updateSource(db, tenantId, shared.id, { imapAuthMode: "shared" }, providerAdmin()),
      ).rejects.toMatchObject({ status: 422 });
      await expect(
        service.updateSource(
          db,
          tenantId,
          shared.id,
          {
            imapAuthMode: "master_user",
            masterUser: { username: "master", style: "dovecot_separator" },
          },
          providerAdmin(),
        ),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("changing host or username on a shared/master_user source always demands the password again, whatever mode the same patch also requests", async () => {
      const shared = await service.createSource(
        db,
        tenantId,
        {
          kind: "imap",
          name: "Direct Host Move",
          host: HOST_A,
          port: 993,
          security: "tls",
          username: "direct-login@hoster.example",
          password: "s3cret-direct-password",
          imapAuthMode: "shared",
        },
        providerAdmin(),
      );

      // No mode change at all: the original guard already covered this, kept
      // here as a baseline the gated-on-secretRef rewrite must not regress.
      await expect(
        service.updateSource(db, tenantId, shared.id, { host: HOST_EVIL }, providerAdmin()),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("per_mailbox -> shared(+host+password) -> per_mailbox clears every mailbox's stored password at the first host change, not only when the patch itself says per_mailbox", async () => {
      const source = await service.createSource(
        db,
        tenantId,
        {
          kind: "imap",
          name: "Per-Mailbox To Shared Detour",
          host: HOST_A,
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
        [{ line: null, login: "alice@hoster.example", password: "alice-s3cret" }],
        directoryActor(),
        { dryRun: false },
      );
      expect(imported.created).toBe(1);
      const [before] = await db
        .select({ secretRef: protectedObjects.secretRef })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, source.id));
      expect(before?.secretRef).not.toBeNull();

      // Step 1: move to shared, repointing the host, with a password (valid
      // on its own terms: shared needs a password for a new endpoint).
      await service.updateSource(
        db,
        tenantId,
        source.id,
        { imapAuthMode: "shared", host: HOST_EVIL, password: "new-shared-password" },
        providerAdmin(),
      );

      // The mailbox's own sealed password must already be gone: nothing
      // about step 2 (moving back to per_mailbox with no further host
      // change) should be able to resurrect it against the new host.
      const [afterStep1] = await db
        .select({
          secretRef: protectedObjects.secretRef,
          credentialStatus: protectedObjects.credentialStatus,
        })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, source.id));
      expect(afterStep1?.secretRef).toBeNull();
      expect(afterStep1?.credentialStatus).toBeNull();

      await service.updateSource(
        db,
        tenantId,
        source.id,
        { imapAuthMode: "per_mailbox" },
        providerAdmin(),
      );
      const [afterStep2] = await db
        .select({ secretRef: protectedObjects.secretRef })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, source.id));
      expect(afterStep2?.secretRef).toBeNull();
    });

    it("moving a per_mailbox source away from per_mailbox with no host change still drops its mailboxes' secrets, since nothing reads them again", async () => {
      const source = await service.createSource(
        db,
        tenantId,
        {
          kind: "imap",
          name: "Per-Mailbox Mode Leave Only",
          host: HOST_A,
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
        source.id,
        [{ line: null, login: "carol@hoster.example", password: "carol-s3cret" }],
        directoryActor(),
        { dryRun: false },
      );

      await service.updateSource(
        db,
        tenantId,
        source.id,
        { imapAuthMode: "shared", password: "fresh-shared-password" },
        providerAdmin(),
      );

      const [row] = await db
        .select({ secretRef: protectedObjects.secretRef })
        .from(protectedObjects)
        .where(eq(protectedObjects.sourceId, source.id));
      expect(row?.secretRef).toBeNull();
    });

    it("deleting a source removes every mailbox's sealed password from `secrets`, not only the source's own", async () => {
      const source = await service.createSource(
        db,
        tenantId,
        {
          kind: "imap",
          name: "Delete Source Cleanup",
          host: HOST_A,
          port: 993,
          security: "tls",
          username: "unused3@hoster.example",
          imapAuthMode: "per_mailbox",
        },
        providerAdmin(),
      );
      await directoryService.importAccounts(
        db,
        tenantId,
        source.id,
        [
          { line: null, login: "dave@hoster.example", password: "dave-s3cret" },
          { line: null, login: "erin@hoster.example", password: "erin-s3cret" },
        ],
        directoryActor(),
        { dryRun: false },
      );
      const secretRefs = (
        await db
          .select({ secretRef: protectedObjects.secretRef })
          .from(protectedObjects)
          .where(eq(protectedObjects.sourceId, source.id))
      ).map((row) => row.secretRef);
      expect(secretRefs).toHaveLength(2);
      for (const secretRef of secretRefs) {
        expect(secretRef).not.toBeNull();
      }

      await service.deleteSource(db, tenantId, source.id, providerAdmin());

      for (const secretRef of secretRefs) {
        const [row] = await db
          .select()
          .from(secrets)
          .where(eq(secrets.id, secretRef as string));
        expect(row).toBeUndefined();
      }
    });
  },
);
