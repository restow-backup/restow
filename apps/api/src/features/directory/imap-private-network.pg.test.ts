/**
 * Postgres-backed proof that "test login" (`testObjectCredential`) honours
 * the installation-wide `IMAP_ALLOW_PRIVATE_NETWORKS` flag the same way the
 * worker (`imapAccountFor`) and the source-level `testSource` already do.
 * Regression: before this, `resolveImapProbeInput` only
 * ever looked at the source's own `privateNetworkApproval`, so on an
 * installation that allows private networks (a local Dovecot, a LAN test
 * server) "test login" refused with `blocked_address` and marked the mailbox
 * "Login failed" even though a real backup or restore against the same host
 * succeeds — breaking the promise that backup, restore and test login
 * resolve a host identically.
 *
 * `IMAP_ALLOW_PRIVATE_NETWORKS` is read once into the process-wide config
 * singleton, so it is set before the api's config module (and everything
 * that imports it) is ever loaded in this file's isolated module graph.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_directory_private_net_test` is recreated there and
 * dropped after). Without it the suite is skipped.
 */
process.env.IMAP_ALLOW_PRIVATE_NETWORKS = "true";

import { randomBytes, randomUUID } from "node:crypto";
import { type Database, createDb, protectedObjects, providers, sources, tenants } from "@restow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../snapshots/testing/explorer-fixture.js";

const DATABASE = "restow_directory_private_net_test";

type Service = typeof import("./service.js");

const actor = () => ({ userId: randomUUID(), label: "admin@contoso.example", ip: "192.0.2.10" });

describe.skipIf(!testDatabaseAdminUrl)(
  "test login against a private-network host, IMAP_ALLOW_PRIVATE_NETWORKS=true",
  () => {
    let db: Database;
    let service: Service;
    let tenantId: string;

    beforeAll(async () => {
      const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
      process.env.RESTOW_MASTER_KEY = randomBytes(32).toString("base64");
      db = createDb(url);
      service = await import("./service.js");
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

    it("never refuses a private-network host with blocked_address, only what the connection itself finds", async () => {
      const [source] = await db
        .insert(sources)
        .values({
          tenantId,
          kind: "imap",
          name: "Local Dovecot",
          status: "active",
          // A loopback host with no `privateNetworkApproval` on the source: only
          // the installation-wide flag lets this through.
          host: "127.0.0.1",
          port: 1993,
          security: "tls",
          config: { imapAuthMode: "per_mailbox" },
        })
        .returning();
      const sourceId = source?.id as string;
      const [object] = await db
        .insert(protectedObjects)
        .values({
          tenantId,
          sourceId,
          kind: "imap",
          origin: "manual",
          status: "active",
          externalId: "box@local.example",
        })
        .returning();
      const objectId = object?.id as string;
      await service.setObjectCredential(db, tenantId, objectId, { password: "s3cret" }, actor());

      const { probe } = await service.testObjectCredential(db, tenantId, objectId, actor());
      // Nothing is listening on 127.0.0.1:1993 in CI, so the probe still fails —
      // the point is *how* it fails: never the address-policy refusal.
      expect(probe.ok).toBe(false);
      if (!probe.ok) {
        expect(probe.reason).not.toBe("blocked_address");
      }
    });
  },
);
