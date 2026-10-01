/**
 * Postgres-backed tests of the audit viewer: entries written through the real
 * `audit()` helper, read back with every filter and page, and verified end to
 * end with daily anchors — then tampered with the way only someone with
 * database superuser rights could (the append-only trigger switched off), to
 * prove the verification finds each kind of manipulation.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (the
 * database `restow_api_audit_test` is recreated there and dropped after).
 * Without it the suite is skipped; docs/TESTING.md lists it under integration.
 */
import { randomUUID } from "node:crypto";
import {
  type AuditLogEntry,
  type Database,
  auditAnchor,
  auditLog,
  createDb,
  providers,
  tenants,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  dropDatabase,
  recreateDatabase,
  testDatabaseAdminUrl,
} from "../../../../apps/api/src/features/snapshots/testing/explorer-fixture.js";
import {
  type AuditEvent,
  type AuditPayload,
  audit,
  computeChainHash,
} from "../../../../apps/api/src/lib/audit.js";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import { utcDay } from "./chain.js";
import { listAuditQuerySchema } from "./schemas.js";
import {
  getAuditEntry,
  listAuditActions,
  listAuditEntries,
  verifyAuditChains,
  walkChain,
} from "./service.js";

const DATABASE = "restow_api_audit_test";

const DAY_1 = "2026-09-20";
const DAY_2 = "2026-09-21";
const DAY_3 = "2026-09-22";

const query = (input: Record<string, unknown> = {}) => listAuditQuerySchema.parse(input);

describe.skipIf(!testDatabaseAdminUrl)("audit log against Postgres", () => {
  let db: Database;
  let contoso: string;
  let fabrikam: string;
  let tailspin: string;
  const written = new Map<string, AuditLogEntry[]>();

  /** Append through the real helper at a fixed instant. */
  async function appendAt(time: string, event: AuditEvent): Promise<AuditLogEntry> {
    vi.setSystemTime(new Date(time));
    const entry = await audit(db, event);
    const key = event.tenantId ?? "installation";
    written.set(key, [...(written.get(key) ?? []), entry]);
    return entry;
  }

  /** Seal a day the way the daily anchor writer does. */
  async function anchorDay(tenantId: string | null, day: string): Promise<void> {
    const ofDay = (written.get(tenantId ?? "installation") ?? []).filter(
      (entry) => utcDay(entry.createdAt) === day,
    );
    const last = ofDay[ofDay.length - 1];
    if (!last) {
      throw new Error(`nothing to anchor on ${day}`);
    }
    await db
      .insert(auditAnchor)
      .values({ tenantId, anchorDate: day, lastHash: last.chainHash, count: ofDay.length });
  }

  /** Run a statement with the append-only trigger switched off, as a superuser could. */
  async function behindTheTrigger(statement: ReturnType<typeof sql>): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`);
      await tx.execute(statement);
      await tx.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only`);
    });
  }

  beforeAll(async () => {
    const url = await recreateDatabase(testDatabaseAdminUrl as string, DATABASE);
    db = createDb(url);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const created = await db
      .insert(tenants)
      .values(
        ["Contoso", "Fabrikam", "Tailspin"].map((name) => ({
          providerId: provider?.id as string,
          name,
          slug: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}`,
        })),
      )
      .returning();
    [contoso, fabrikam, tailspin] = created.map((tenant) => tenant.id) as [string, string, string];

    vi.useFakeTimers({ toFake: ["Date"] });
    await appendAt(`${DAY_1}T07:00:00.000Z`, {
      action: "setup.completed",
      actor: "admin@provider.example",
      actorUserId: "user-admin",
      ip: "192.0.2.1",
    });
    await appendAt(`${DAY_1}T08:00:00.000Z`, {
      tenantId: contoso,
      action: "tenant.created",
      actor: "admin@provider.example",
      target: contoso,
      targetType: "tenant",
    });
    await appendAt(`${DAY_1}T09:00:00.000Z`, {
      tenantId: contoso,
      action: "restore.requested",
      actor: "anna@contoso.example",
      actorUserId: "user-anna",
      target: "anna@contoso.example",
      targetType: "mailbox",
      ip: "198.51.100.20",
      details: { items: 3 },
    });
    await appendAt(`${DAY_2}T10:00:00.000Z`, {
      tenantId: contoso,
      action: "restore.downloaded",
      actor: "anna@contoso.example",
      actorUserId: "user-anna",
      target: "anna@contoso.example",
      targetType: "mailbox",
    });
    await appendAt(`${DAY_2}T11:00:00.000Z`, {
      tenantId: contoso,
      action: "tenant.member.role_changed",
      actor: "admin@provider.example",
      target: "bob@contoso.example",
      details: { from: "tenant_user", to: "tenant_admin" },
    });
    await appendAt(`${DAY_3}T12:00:00.000Z`, {
      tenantId: contoso,
      action: "backup.requested",
      actor: "system",
      target: "all",
    });
    await appendAt(`${DAY_1}T13:00:00.000Z`, {
      tenantId: fabrikam,
      action: "tenant.created",
      actor: "admin@provider.example",
    });
    await appendAt(`${DAY_2}T14:00:00.000Z`, {
      tenantId: fabrikam,
      action: "source.created",
      actor: "admin@fabrikam.example",
      target: "Fabrikam M365",
    });
    vi.useRealTimers();

    await anchorDay(null, DAY_1);
    await anchorDay(contoso, DAY_1);
    await anchorDay(contoso, DAY_2);
    await anchorDay(fabrikam, DAY_1);
    await anchorDay(fabrikam, DAY_2);
  }, 60_000);

  afterAll(async () => {
    vi.useRealTimers();
    await db?.$client.end();
    await dropDatabase(testDatabaseAdminUrl as string, DATABASE);
  });

  it("verifies every chain with its anchors", async () => {
    const report = await verifyAuditChains(db, { kind: "all" });
    expect(report.status).toBe("intact");
    expect(
      report.chains.map((chain) => [chain.tenantName, chain.status, chain.verifiedEntries]),
    ).toEqual([
      [null, "intact", 1],
      ["Contoso", "intact", 5],
      ["Fabrikam", "intact", 2],
      ["Tailspin", "empty", 0],
    ]);
    const contosoReport = report.chains[1];
    expect(contosoReport?.anchors).toEqual({
      total: 2,
      verified: 2,
      latest: {
        date: DAY_2,
        lastHash: written.get(contoso)?.[3]?.chainHash,
        count: 2,
      },
    });
    expect(contosoReport?.head).toEqual({
      hash: written.get(contoso)?.[4]?.chainHash,
      createdAt: `${DAY_3}T12:00:00.000Z`,
    });
  });

  it("lists entries newest first across tenants, with names and intact hashes", async () => {
    const page = await listAuditEntries(db, { kind: "all" }, query());
    expect(page.next).toBeNull();
    expect(page.items.map((entry) => entry.action)).toEqual([
      "backup.requested",
      "source.created",
      "tenant.member.role_changed",
      "restore.downloaded",
      "tenant.created",
      "restore.requested",
      "tenant.created",
      "setup.completed",
    ]);
    expect(page.items.every((entry) => entry.hashValid)).toBe(true);
    expect(page.items[1]).toMatchObject({ tenantId: fabrikam, tenantName: "Fabrikam" });
    expect(page.items[7]).toMatchObject({ tenantId: null, tenantName: null, ip: "192.0.2.1" });
  });

  it("names targets it can resolve, in the installation view and pinned to a tenant", async () => {
    const created = (items: { action: string; target: string | null }[]) =>
      items.find((entry) => entry.action === "tenant.created" && entry.target === contoso);
    const all = await listAuditEntries(db, { kind: "all" }, query());
    expect(created(all.items)).toMatchObject({ targetLabel: "Contoso" });
    // A target that is not an id of a nameable type keeps no label.
    expect(all.items.find((entry) => entry.action === "restore.requested")).toMatchObject({
      target: "anna@contoso.example",
      targetLabel: null,
    });
    const pinned = await listAuditEntries(db, { kind: "tenant", tenantId: contoso }, query());
    expect(created(pinned.items)).toMatchObject({ targetLabel: "Contoso" });
  });

  it("filters by chain, action prefix, actor, target and time window", async () => {
    const actions = async (selection: Parameters<typeof listAuditEntries>[1], input = {}) =>
      (await listAuditEntries(db, selection, query(input))).items.map((entry) => entry.action);

    expect(await actions({ kind: "installation" })).toEqual(["setup.completed"]);
    expect(await actions({ kind: "tenant", tenantId: fabrikam })).toEqual([
      "source.created",
      "tenant.created",
    ]);
    expect(await actions({ kind: "all" }, { action: "restore" })).toEqual([
      "restore.downloaded",
      "restore.requested",
    ]);
    expect(await actions({ kind: "all" }, { action: "tenant.member" })).toEqual([
      "tenant.member.role_changed",
    ]);
    expect(await actions({ kind: "all" }, { action: "tenant.member.role_changed" })).toEqual([
      "tenant.member.role_changed",
    ]);
    expect(await actions({ kind: "all" }, { actor: "ANNA@" })).toEqual([
      "restore.downloaded",
      "restore.requested",
    ]);
    expect(await actions({ kind: "all" }, { actor: "user-admin" })).toEqual(["setup.completed"]);
    expect(await actions({ kind: "tenant", tenantId: contoso }, { target: "bob@" })).toEqual([
      "tenant.member.role_changed",
    ]);
    expect(
      await actions(
        { kind: "all" },
        { from: `${DAY_2}T00:00:00.000Z`, to: `${DAY_2}T10:30:00.000Z` },
      ),
    ).toEqual(["restore.downloaded"]);
  });

  it("pages with a cursor without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAuditEntries(db, { kind: "all" }, query({ limit: 3, cursor }));
      seen.push(...page.items.map((entry) => entry.id));
      cursor = page.next ?? undefined;
    } while (cursor);
    const all = await listAuditEntries(db, { kind: "all" }, query());
    expect(seen).toEqual(all.items.map((entry) => entry.id));

    await expect(
      listAuditEntries(db, { kind: "all" }, query({ cursor: "garbage" })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("lists the recorded actions of the selected chains", async () => {
    expect(await listAuditActions(db, { kind: "tenant", tenantId: contoso })).toEqual([
      { action: "backup.requested", count: 1 },
      { action: "restore.downloaded", count: 1 },
      { action: "restore.requested", count: 1 },
      { action: "tenant.created", count: 1 },
      { action: "tenant.member.role_changed", count: 1 },
    ]);
    expect(await listAuditActions(db, { kind: "all" })).toContainEqual({
      action: "tenant.created",
      count: 2,
    });
  });

  it("shows a tenant admin their own entries only", async () => {
    const fabrikamEntry = written.get(fabrikam)?.[0] as AuditLogEntry;
    const contosoEntry = written.get(contoso)?.[0] as AuditLogEntry;
    const scope = { kind: "tenant", tenantId: contoso } as const;
    await expect(getAuditEntry(db, scope, contosoEntry.id)).resolves.toMatchObject({
      id: contosoEntry.id,
      tenantName: "Contoso",
    });
    await expect(getAuditEntry(db, scope, fabrikamEntry.id)).rejects.toBeInstanceOf(ProblemError);
    await expect(getAuditEntry(db, { kind: "provider" }, fabrikamEntry.id)).resolves.toMatchObject({
      id: fabrikamEntry.id,
    });
  });

  it("walks runs of equal timestamps across batch boundaries in link order", async () => {
    // Six entries in two identical milliseconds; ids sort against insertion order.
    const at = [
      `${DAY_1}T10:00:00.000Z`,
      `${DAY_1}T10:00:00.000Z`,
      `${DAY_1}T10:00:00.000Z`,
      `${DAY_1}T10:00:00.000Z`,
      `${DAY_1}T11:00:00.000Z`,
      `${DAY_1}T11:00:00.000Z`,
    ];
    let prevHash: string | null = null;
    for (const [index, time] of at.entries()) {
      const payload: AuditPayload = {
        tenantId: tailspin,
        actor: "system",
        actorUserId: null,
        action: "job.retried",
        target: `job-${index}`,
        targetType: "job",
        onBehalfOf: null,
        ip: null,
        details: null,
      };
      const createdAt = new Date(time);
      const chainHash = computeChainHash(prevHash, payload, createdAt);
      await db.insert(auditLog).values({
        id: `${String(9 - index).repeat(8)}-0000-4000-8000-000000000000`,
        ...payload,
        prevHash,
        chainHash,
        createdAt,
      });
      prevHash = chainHash;
    }
    for (const batchSize of [1, 2, 3, 1000]) {
      const result = await db.transaction((tx) => walkChain(tx, tailspin, batchSize));
      expect(result).toMatchObject({ status: "intact", verifiedEntries: 6 });
    }
  });

  it("finds a rewritten row, a cut-off tail and keeps untouched chains intact", async () => {
    const victim = written.get(contoso)?.[1] as AuditLogEntry;
    await behindTheTrigger(
      sql`UPDATE audit_log SET actor = 'someone-else@contoso.example' WHERE id = ${victim.id}`,
    );
    const lastFabrikam = written.get(fabrikam)?.[1] as AuditLogEntry;
    await behindTheTrigger(sql`DELETE FROM audit_log WHERE id = ${lastFabrikam.id}`);

    const report = await verifyAuditChains(db, { kind: "all" });
    expect(report.status).toBe("broken");
    const [installation, contosoReport, fabrikamReport] = report.chains;
    expect(installation?.status).toBe("intact");

    expect(contosoReport).toMatchObject({ status: "broken", verifiedEntries: 1 });
    expect(contosoReport?.firstBreak).toMatchObject({
      reason: "hash_mismatch",
      position: 2,
      entryId: victim.id,
      createdAt: `${DAY_1}T09:00:00.000Z`,
      storedHash: victim.chainHash,
    });

    expect(fabrikamReport).toMatchObject({ status: "broken", verifiedEntries: 1 });
    expect(fabrikamReport?.firstBreak).toEqual({
      reason: "anchor_mismatch",
      position: 1,
      anchorDate: DAY_2,
      anchoredHash: lastFabrikam.chainHash,
      anchoredCount: 1,
      chainHash: null,
      chainCount: 0,
    });

    const tampered = await getAuditEntry(db, { kind: "provider" }, victim.id);
    expect(tampered).toMatchObject({ actor: "someone-else@contoso.example", hashValid: false });

    const single = await verifyAuditChains(db, { kind: "tenant", tenantId: contoso });
    expect(single.chains).toHaveLength(1);
    expect(single.status).toBe("broken");

    const [stored] = await db.select().from(auditLog).where(eq(auditLog.id, victim.id));
    expect(stored?.actor).toBe("someone-else@contoso.example");
  });

  it("keeps the log append-only for everyone else", async () => {
    const entry = written.get("installation")?.[0] as AuditLogEntry;
    // Drizzle wraps the driver error; the trigger's message is on `cause`.
    await expect(
      db.execute(sql`UPDATE audit_log SET actor = 'x' WHERE id = ${entry.id}`),
    ).rejects.toHaveProperty("cause.message", expect.stringMatching(/append-only/));
  });

  it("answers 404 for a tenant that does not exist", async () => {
    await expect(
      verifyAuditChains(db, { kind: "tenant", tenantId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
