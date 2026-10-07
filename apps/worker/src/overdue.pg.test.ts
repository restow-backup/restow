// `backup.overdue` against a real Postgres, for VMs and containers of Proxmox VE and with a rule
// that sets its own deadline:
//
//   - a guest in an enabled PVE job is overdue by the PVE jobs' schedules (the bell and the rules
//     without a deadline of their own hear about it once per stretch); a guest the inventory
//     found that nobody put into a job is never overdue;
//   - a rule with `overdue_after_hours` alerts by its own deadline, about mailboxes and guests
//     alike, once per stretch, and never with the alert raised at the schedules' bound;
//   - another tenant's rules stay silent.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
// `restow_worker_overdue_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EndpointJobDeps } from "./endpoints/common.js";
import { alertOverdueBackups } from "./overdue.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_overdue_test";
const HOUR = 3_600_000;
const NOW = new Date("2026-10-07T12:00:00.000Z");
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms);

describe.skipIf(!adminUrl)("backup.overdue against Postgres", () => {
  let db: ReturnType<typeof createDb>;
  let deps: EndpointJobDeps;
  let contoso: string;
  let mailbox: string;
  const guests: Record<string, string> = {};
  let schedulesRule: string;
  let deadlineRule: string;

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    db.$client.query<T>(text, values).then((result) => result.rows);

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    deps = { db, providerDb: db, runtime: {} as never };

    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const created = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso'), ($1, 'Fabrikam', 'fabrikam') RETURNING id",
      [provider?.id],
    );
    contoso = created[0]?.id ?? "";
    const fabrikam = created[1]?.id ?? "";

    // An IMAP account backed up 30 hours ago; no mail job, so its bound is two days.
    const [source] = await q<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'imap', 'IMAP', 'active') RETURNING id",
      [contoso],
    );
    const [object] = await q<{ id: string }>(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, display_name, status, created_at)
       VALUES ($1, $2, 'imap', 'anna@contoso.example', 'Anna Berg', 'active', $3) RETURNING id`,
      [contoso, source?.id, ago(30 * 24 * HOUR)],
    );
    mailbox = object?.id ?? "";
    await q(
      `INSERT INTO snapshots (tenant_id, protected_object_id, sequence, manifest_path, item_count, byte_size, started_at, completed_at)
       VALUES ($1, $2, 1, 'm/1', 1, 1, $3, $3)`,
      [contoso, mailbox, ago(30 * HOUR)],
    );

    // Proxmox VE: a daily job (overdue after two days), three guests.
    const [cluster] = await q<{ id: string }>(
      "INSERT INTO pve_clusters (tenant_id, name, fingerprint, storage_id) VALUES ($1, 'lab', 'fp-contoso', 'restow') RETURNING id",
      [contoso],
    );
    const [job] = await q<{ id: string }>(
      `INSERT INTO pve_jobs (tenant_id, name, schedule, enabled, created_at)
       VALUES ($1, 'Daily', '{"kind":"daily","timeOfDay":"22:00","timeZone":"UTC"}', true, $2) RETURNING id`,
      [contoso, ago(30 * 24 * HOUR)],
    );
    const guest = async (vmid: number, name: string, jobId: string | null, last: Date | null) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO pve_guests (tenant_id, cluster_id, vmid, kind, name, job_id, last_success_at, created_at)
         VALUES ($1, $2, $3, 'vm', $4, $5, $6, $7) RETURNING id`,
        [contoso, cluster?.id, vmid, name, jobId, last, ago(30 * 24 * HOUR)],
      );
      guests[name] = row?.id ?? "";
    };
    await guest(101, "web", job?.id ?? null, ago(30 * HOUR));
    await guest(102, "db", job?.id ?? null, ago(72 * HOUR));
    // Found by the inventory, never in a job, never backed up: not meant to be backed up.
    await guest(103, "lab", null, null);
    // Its newest restore point (10 hours old) counts though the guest row names no success.
    await guest(104, "files", job?.id ?? null, null);
    await q(
      `INSERT INTO pve_snapshots (tenant_id, cluster_id, guest_id, sequence, kind, archive_name, storage_id, manifest_path, backup_at)
       VALUES ($1, $2, $3, 1, 'vm', 'vm/104/1', 'restow', 'p/1', $4)`,
      [contoso, cluster?.id, guests.files, ago(10 * HOUR)],
    );

    const [first] = await q<{ id: string }>(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, throttle_minutes, email_recipients)
       VALUES ($1, 'By the schedules', 'event', ARRAY['backup.overdue'], 0, ARRAY['ops@contoso.example'])
       RETURNING id`,
      [contoso],
    );
    schedulesRule = first?.id ?? "";
    const [second] = await q<{ id: string }>(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, throttle_minutes, email_recipients, overdue_after_hours)
       VALUES ($1, 'Within a day', 'event', ARRAY['backup.overdue','backup.failed'], 0, ARRAY['boss@contoso.example'], 24)
       RETURNING id`,
      [contoso],
    );
    deadlineRule = second?.id ?? "";
    await q(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, email_recipients, overdue_after_hours)
       VALUES ($1, 'Other tenant', 'event', ARRAY['backup.overdue'], ARRAY['y@fabrikam.example'], 24)`,
      [fabrikam],
    );
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  const deliveries = (ruleId: string) =>
    q<{ subject_key: string; recipient: string; payload: { details: Record<string, unknown> } }>(
      "SELECT subject_key, recipient, payload FROM report_deliveries WHERE rule_id = $1 ORDER BY created_at, subject_key",
      [ruleId],
    );
  const bell = () =>
    q<{ details: Record<string, unknown> }>(
      "SELECT details FROM notifications WHERE event = 'backup.overdue' ORDER BY created_at",
    );

  it("alerts by the schedules and by a rule's own deadline, each once per stretch", async () => {
    // Bell: db only (72 h > 48 h); web and the mailbox (30 h) are within their two days, files
    // (10 h, by its restore point) within either bound.
    expect(await alertOverdueBackups(deps, NOW)).toBe(4);
    const raised = await bell();
    expect(raised.map((row) => row.details.pveGuestId)).toEqual([guests.db]);
    expect(raised[0]?.details).toMatchObject({ objectName: "db", boundHours: 48, days: 2 });

    // The rule without a deadline of its own follows the bell.
    expect((await deliveries(schedulesRule)).map((row) => row.subject_key)).toEqual([
      `guest:${guests.db}`,
    ]);
    // The rule with 24 hours: every protected object past a day, guests and the mailbox alike,
    // and db once (not again with the alert at the schedules' bound).
    const own = await deliveries(deadlineRule);
    expect(own.map((row) => row.subject_key).sort()).toEqual(
      [`guest:${guests.db}`, `guest:${guests.web}`, `object:${mailbox}`].sort(),
    );
    expect(own.every((row) => row.recipient === "boss@contoso.example")).toBe(true);
    expect(own.every((row) => row.payload.details.boundHours === 24)).toBe(true);
    expect(own.every((row) => row.payload.details.days === 1)).toBe(true);
    // The guest nobody put into a job is never overdue; Fabrikam has nothing to report.
    expect(JSON.stringify(own)).not.toContain(guests.lab);
    expect(JSON.stringify(own)).not.toContain(guests.files);
    expect(
      await q("SELECT 1 FROM report_deliveries WHERE tenant_id <> $1", [contoso]),
    ).toHaveLength(0);

    // The next pass: nothing new in the same stretch.
    expect(await alertOverdueBackups(deps, new Date(NOW.getTime() + 5 * 60_000))).toBe(0);
  });

  it("starts a new stretch after a successful backup", async () => {
    const backedUp = new Date(NOW.getTime() + HOUR);
    await q("UPDATE pve_guests SET last_success_at = $1 WHERE id = $2", [backedUp, guests.web]);
    const later = new Date(NOW.getTime() + 26 * HOUR);
    // 25 hours since web's new backup: past the rule's day, within the schedules' two days.
    // Meanwhile files (36 hours) passed the rule's day, and the mailbox (56 hours) the schedules'
    // two days: three alerts.
    expect(await alertOverdueBackups(deps, later)).toBe(3);
    const own = await deliveries(deadlineRule);
    expect(own.filter((row) => row.subject_key === `guest:${guests.web}`)).toHaveLength(2);
    expect(own.filter((row) => row.subject_key === `guest:${guests.files}`)).toHaveLength(1);
    // The mailbox was announced to this rule already, in the same stretch.
    expect(own.filter((row) => row.subject_key === `object:${mailbox}`)).toHaveLength(1);
    const raised = await bell();
    expect(raised.map((row) => row.details.protectedObjectId ?? row.details.pveGuestId)).toEqual([
      guests.db,
      mailbox,
    ]);
    expect(raised[1]?.details.lastSuccessAt).toBe(ago(30 * HOUR).toISOString());
  });
});
