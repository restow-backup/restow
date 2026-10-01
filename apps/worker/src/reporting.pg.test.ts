// Events against a real Postgres: every raised event reaches the bell; the
// tenant's matching event rules get their deliveries queued in the same
// transaction, throttled per rule and subject; other tenants' rules and
// paused rules stay silent; a failed backup raises `backup.failed` with the
// mailbox's name.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database
// named `restow_worker_reporting_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "./handlers/framework.js";
import { raiseEvents, raiseJobFinished } from "./reporting.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_reporting_test";

describe.skipIf(!adminUrl)("raising events against Postgres", () => {
  let db: ReturnType<typeof createDb>;
  let contoso: string;
  let fabrikam: string;
  let mailbox: string;
  let alertRule: string;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());

    const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
      db.$client.query<T>(text, values).then((result) => result.rows);
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const created = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso'), ($1, 'Fabrikam', 'fabrikam') RETURNING id",
      [provider?.id],
    );
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    const [source] = await q<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'imap', 'IMAP', 'active') RETURNING id",
      [contoso],
    );
    const [object] = await q<{ id: string }>(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, display_name, status)
       VALUES ($1, $2, 'imap', 'anna@contoso.example', 'Anna Berg', 'active') RETURNING id`,
      [contoso, source?.id],
    );
    mailbox = object?.id ?? "";
    const [rule] = await q<{ id: string }>(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, throttle_minutes, email_recipients)
       VALUES ($1, 'Failures', 'event', ARRAY['backup.failed','verify.red'], 60, ARRAY['it@contoso.example','ops@contoso.example'])
       RETURNING id`,
      [contoso],
    );
    alertRule = rule?.id ?? "";
    await q(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, email_recipients, enabled)
       VALUES ($1, 'Paused', 'event', ARRAY['backup.failed'], ARRAY['x@contoso.example'], false),
              ($2, 'Other tenant', 'event', ARRAY['backup.failed'], ARRAY['y@fabrikam.example'], true)`,
      [contoso, fabrikam],
    );
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  const deliveries = async () =>
    (
      await db.$client.query<{
        rule_id: string;
        recipient: string;
        event: string;
        subject_key: string;
      }>(
        "SELECT rule_id, recipient, event, subject_key FROM report_deliveries ORDER BY created_at, recipient",
      )
    ).rows;

  it("writes the bell and queues one mail per recipient of the matching rule", async () => {
    await withTenantTx(db, contoso, (tx) =>
      raiseJobFinished(tx, contoso, {
        id: "00000000-0000-4000-8000-000000000001",
        queue: "backup",
        status: "failed",
        protectedObjectId: mailbox,
        completedAt: new Date("2026-09-30T10:00:00Z"),
        errorMessage: "IMAP login failed",
      }),
    );
    const bell = await db.$client.query<{
      event: string;
      message: string;
      details: Record<string, unknown>;
    }>("SELECT event, message, details FROM notifications WHERE tenant_id = $1", [contoso]);
    expect(bell.rows).toHaveLength(1);
    expect(bell.rows[0]).toMatchObject({
      event: "backup.failed",
      details: { objectName: "Anna Berg", queue: "backup", errorMessage: "IMAP login failed" },
    });
    expect(await deliveries()).toEqual([
      {
        rule_id: alertRule,
        recipient: "it@contoso.example",
        event: "backup.failed",
        subject_key: `object:${mailbox}`,
      },
      {
        rule_id: alertRule,
        recipient: "ops@contoso.example",
        event: "backup.failed",
        subject_key: `object:${mailbox}`,
      },
    ]);
  });

  it("throttles repeats for the same mailbox, not for another subject or event", async () => {
    const event = (key: string) => ({
      tenantId: contoso,
      level: "error" as const,
      event: "verify.red",
      message: "red",
      details: { protectedObjectId: key },
    });
    await withTenantTx(db, contoso, (tx) =>
      raiseEvents(tx, [{ ...event(mailbox), event: "backup.failed" }], new Date()),
    );
    // Same rule, same mailbox, within the hour: held back.
    expect((await deliveries()).length).toBe(2);
    await withTenantTx(db, contoso, (tx) => raiseEvents(tx, [event("another-object")], new Date()));
    expect((await deliveries()).length).toBe(4);
    // Still written to the bell each time.
    const bell = await db.$client.query("SELECT 1 FROM notifications WHERE tenant_id = $1", [
      contoso,
    ]);
    expect(bell.rowCount).toBe(3);
  });

  it("raises nothing for a completed backup, and the restore event for a completed restore", async () => {
    await withTenantTx(db, contoso, (tx) =>
      raiseJobFinished(tx, contoso, {
        id: "00000000-0000-4000-8000-000000000002",
        queue: "backup",
        status: "completed",
        protectedObjectId: mailbox,
        completedAt: new Date(),
        errorMessage: null,
      }),
    );
    await withTenantTx(db, contoso, (tx) =>
      raiseJobFinished(tx, contoso, {
        id: "00000000-0000-4000-8000-000000000003",
        queue: "restore",
        status: "completed",
        protectedObjectId: mailbox,
        completedAt: new Date(),
        errorMessage: null,
      }),
    );
    const events = await db.$client.query<{ event: string }>(
      "SELECT event FROM notifications WHERE tenant_id = $1 ORDER BY created_at",
      [contoso],
    );
    expect(events.rows.map((row) => row.event)).toEqual([
      "backup.failed",
      "backup.failed",
      "verify.red",
      "restore.completed",
    ]);
    // No rule listens for restore.completed: no new delivery.
    expect((await deliveries()).length).toBe(4);
  });
});
