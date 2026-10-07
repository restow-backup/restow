/**
 * Postgres-backed end-to-end test of the journal receiver: a raw journal
 * report goes in, a committed, chained archive item comes out, readable
 * back through the same catalog, with the chunk store actually written to
 * local disk (docs/ARCHIVE.md). Also proves two reports for the same tenant
 * chain correctly (second item's `prevChainHash` is the first's `chainHash`)
 * and that a malformed report is archived anyway, flagged, never dropped,
 * also a hostile one whose parse runs over the parser process's time limit,
 * and that a report built to inflate the parser's memory neither stalls nor
 * ends this process (packages/core archive/journal-isolated.ts);
 * (packages/core/src/archive/journal.ts's contract).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a
 * superuser (the database `restow_api_journal_test` is recreated there and
 * dropped after). Without it the suite is skipped.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvKeyProvider,
  InstallationDefaultResolver,
  generateDek,
  kekFromBase64,
} from "@restow/core";
import {
  type Database,
  archiveItemMailboxes,
  archiveItems,
  createDb,
  protectedObjects,
  providers,
  sources,
  tenantKeys,
  tenants,
  users,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ARCHIVE_RETENTION_POLICY } from "../../../../apps/api/src/features/archive/retention-policy.js";
import { setInstallationDefaultResolver } from "../../../../apps/api/src/lib/installation-default.js";
import { receiveJournalReport } from "./receiver.js";

// These suites set the installation default in the environment (STORAGE_*); read it from there,
// uncached, instead of from the installation pool of a configured server
// (lib/installation-default.ts).
beforeAll(() => setInstallationDefaultResolver(new InstallationDefaultResolver({ ttlMs: 0 })));
afterAll(() => setInstallationDefaultResolver(null));

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_api_journal_test";

function testDatabaseUrl(base: string): string {
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = testDatabaseUrl(base);
  await runMigrations(url);
  return url;
}

function rawJournalReport(
  subject: string,
  envelope: { sender?: string; recipients?: string[] } = {},
): Buffer {
  const recipients = envelope.recipients ?? ["mailbox@contoso.example"];
  const original = [
    "From: sender@contoso.example",
    `To: ${recipients[0]}`,
    `Subject: ${subject}`,
    "Message-ID: <msg-1@contoso.example>",
    "",
    "Body text.",
    "",
  ].join("\r\n");
  const report = [
    `Sender: ${envelope.sender ?? "journal@contoso.example"}`,
    "Message-Id: <journal-1@contoso.example>",
    ...recipients.map((recipient) => `Recipient: ${recipient}`),
    "",
    original,
  ].join("\r\n");
  const boundary = "restow-test-boundary";
  return Buffer.from(
    [
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      report.split("\r\n\r\n")[0],
      "",
      `--${boundary}`,
      "Content-Type: message/rfc822",
      "",
      original,
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
}

describe.skipIf(!adminUrl)("receiveJournalReport against Postgres", () => {
  let db: Database;
  let tenantId: string;
  let storageDir: string;

  beforeAll(async () => {
    const url = await recreateTestDatabase(adminUrl as string);
    db = createDb(url);
    storageDir = await mkdtemp(join(tmpdir(), "restow-journal-test-"));
    process.env.STORAGE_TARGET = "local";
    process.env.STORAGE_LOCAL_PATH = storageDir;

    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id as string, name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id as string;

    const kek = kekFromBase64(Buffer.from(randomBytes(32)).toString("base64"));
    const provider2 = new EnvKeyProvider(kek);
    const dek = generateDek(1);
    const wrapped = await provider2.wrapDek(dek);
    await db.insert(tenantKeys).values({
      tenantId,
      keyVersion: 1,
      encryptedDek: wrapped.toString("base64"),
    });

    (globalThis as { __journalTestKek?: Buffer }).__journalTestKek = kek;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await rm(storageDir, { recursive: true, force: true });
  });

  it("commits a journal report as a chained archive item and chains a second one to it", async () => {
    const kek = (globalThis as { __journalTestKek?: Buffer }).__journalTestKek as Buffer;
    const deps = {
      db,
      keyProvider: new EnvKeyProvider(kek),
      now: () => new Date("2026-01-05T09:00:00Z"),
      retentionPolicyFor: async () => DEFAULT_ARCHIVE_RETENTION_POLICY,
    };

    const first = await receiveJournalReport(tenantId, rawJournalReport("First report"), deps);
    expect(first.prevChainHash).toBeNull();
    expect(first.flags).toEqual([]);

    const second = await receiveJournalReport(tenantId, rawJournalReport("Second report"), deps);
    expect(second.prevChainHash).toBe(first.chainHash);

    const rows = await db
      .select({ chainHash: archiveItems.chainHash })
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tenantId));
    expect(rows).toHaveLength(2);
  }, 60_000);

  it("assigns a report to every mailbox its envelope names, by address, alias or as the sender", async () => {
    const kek = (globalThis as { __journalTestKek?: Buffer }).__journalTestKek as Buffer;
    const deps = {
      db,
      keyProvider: new EnvKeyProvider(kek),
      now: () => new Date("2026-01-06T09:00:00Z"),
      retentionPolicyFor: async () => DEFAULT_ARCHIVE_RETENTION_POLICY,
    };
    const [source] = await db
      .insert(sources)
      .values({ tenantId, kind: "m365", name: "Contoso M365", status: "active" })
      .returning();
    const [anna, bob] = await db
      .insert(users)
      .values([
        {
          tenantId,
          email: "anna@contoso.example",
          upn: "anna@contoso.onmicrosoft.com",
          mailAddresses: ["anna@contoso.example", "info@contoso.example"],
        },
        { tenantId, email: "bob@contoso.example", upn: "bob@contoso.example" },
      ])
      .returning();
    const [annaBox, bobBox] = await db
      .insert(protectedObjects)
      .values([
        {
          tenantId,
          sourceId: source?.id as string,
          userId: anna?.id,
          kind: "mailbox" as const,
          externalId: "oid-anna",
        },
        {
          tenantId,
          sourceId: source?.id as string,
          userId: bob?.id,
          kind: "mailbox" as const,
          externalId: "oid-bob",
        },
        // Anna's OneDrive is not a mailbox: never assigned.
        {
          tenantId,
          sourceId: source?.id as string,
          userId: anna?.id,
          kind: "onedrive" as const,
          externalId: "drive-anna",
        },
      ])
      .returning();

    const sent = await receiveJournalReport(
      tenantId,
      rawJournalReport("To the info alias", {
        sender: "Bob@Contoso.example",
        recipients: ["INFO@contoso.example", "someone@elsewhere.example"],
      }),
      deps,
    );
    const outside = await receiveJournalReport(
      tenantId,
      rawJournalReport("Nobody of ours", {
        sender: "a@elsewhere.example",
        recipients: ["b@elsewhere.example"],
      }),
      deps,
    );

    const assigned = async (itemId: string) =>
      (
        await db
          .select({ objectId: archiveItemMailboxes.protectedObjectId })
          .from(archiveItemMailboxes)
          .where(eq(archiveItemMailboxes.archiveItemId, itemId))
      )
        .map((row) => row.objectId)
        .sort();
    expect(await assigned(sent.id)).toEqual([annaBox?.id, bobBox?.id].sort());
    // Archived all the same, assigned to the tenant only.
    expect(await assigned(outside.id)).toEqual([]);
    const archived = await db
      .select({ id: archiveItems.id })
      .from(archiveItems)
      .where(eq(archiveItems.id, outside.id));
    expect(archived).toHaveLength(1);
  }, 60_000);

  it("archives a malformed report instead of dropping it, flagged as incomplete", async () => {
    const kek = (globalThis as { __journalTestKek?: Buffer }).__journalTestKek as Buffer;
    const deps = {
      db,
      keyProvider: new EnvKeyProvider(kek),
      now: () => new Date("2026-01-06T09:00:00Z"),
      retentionPolicyFor: async () => DEFAULT_ARCHIVE_RETENTION_POLICY,
    };

    const record = await receiveJournalReport(
      tenantId,
      Buffer.from("not a valid mime report"),
      deps,
    );
    expect(record.flags.length).toBeGreaterThan(0);

    const [row] = await db
      .select({ id: archiveItems.id })
      .from(archiveItems)
      .where(eq(archiveItems.id, record.id));
    expect(row).toBeDefined();
  }, 60_000);

  function hostileDeps(day: string) {
    const kek = (globalThis as { __journalTestKek?: Buffer }).__journalTestKek as Buffer;
    return {
      db,
      keyProvider: new EnvKeyProvider(kek),
      now: () => new Date(`2026-01-${day}T09:00:00Z`),
      retentionPolicyFor: async () => DEFAULT_ARCHIVE_RETENTION_POLICY,
    };
  }

  function reportWithEnvelope(envelopeHeaders: string[], envelopeBody: string): Buffer {
    const boundary = "restow-hostile-boundary";
    return Buffer.from(
      [
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        ...envelopeHeaders,
        "",
        envelopeBody,
        `--${boundary}`,
        "Content-Type: message/rfc822",
        "",
        "From: sender@contoso.example\r\nSubject: Confidential\r\n\r\nBody.",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
  }

  /** Counts timer ticks while `run` is pending: proof that this process's event loop kept going. */
  async function ticking<T>(run: () => Promise<T>): Promise<{ value: T; ticks: number }> {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      return { value: await run(), ticks };
    } finally {
      clearInterval(timer);
    }
  }

  it("archives a hostile report byte for byte, flagged, when its parse runs over the time limit", async () => {
    // The envelope text is quoted-printable made of soft line breaks, which mailparser up to 3.9.28
    // decoded in time that grew with the square of its length (later versions are linear, but 24 MB
    // still take seconds): seconds to minutes on the event loop before.
    const hostile = reportWithEnvelope(
      ["Content-Type: text/plain", "Content-Transfer-Encoding: quoted-printable"],
      "=\r\n=3D".repeat(4_000_000),
    );
    const { value: record, ticks } = await ticking(() =>
      receiveJournalReport(tenantId, hostile, {
        ...hostileDeps("07"),
        parseLimits: { timeoutMs: 1000 },
      }),
    );

    expect(record.flags).toEqual(["report-parse-timeout", "original-message-missing"]);
    // Stored exactly as received: the whole report, not a part of it.
    expect(record.size).toBe(hostile.length);
    expect(record.itemHash).toBe(createHash("sha256").update(hostile).digest("hex"));
    expect(record.envelope).toMatchObject({ sender: null, subject: null, recipients: [] });
    expect(ticks).toBeGreaterThan(10);

    const [row] = await db
      .select({ flags: archiveItems.flags, chainHash: archiveItems.chainHash })
      .from(archiveItems)
      .where(eq(archiveItems.id, record.id));
    expect(row?.flags).toEqual(["report-parse-timeout", "original-message-missing"]);
    expect(row?.chainHash).toBe(record.chainHash);
  }, 60_000);

  it("archives a 30 MB report built to inflate the parser's memory without stalling or ending this process", async () => {
    // 30 MB of `<` as the envelope text: with mailparser's defaults that took a gigabyte of heap,
    // and a large allocation past a heap limit aborts the process it happens in.
    const inflating = reportWithEnvelope(
      ["Content-Type: text/plain"],
      "<".repeat(30 * 1024 * 1024),
    );
    const { value: record, ticks } = await ticking(() =>
      receiveJournalReport(tenantId, inflating, hostileDeps("08")),
    );
    // Read in its own process within the limits: the original is extracted, nothing is lost.
    expect(record.flags).toContain("envelope-unparseable");
    expect(record.flags).not.toContain("report-parse-memory-limit");
    expect(ticks).toBeGreaterThan(0);
    expect(process.memoryUsage().heapUsed).toBeLessThan(1024 * 1024 * 1024);
  }, 120_000);
});
