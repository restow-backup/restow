/**
 * Migration 0070 against Postgres: an IMAP account whose login is refused. The upgrade leaves
 * existing rows at 0 / NULL; `login_refused` cannot be set without an IMAP kind, the orphaned
 * status and a confirmation (the admin's "Yes"); the trigger keeps that confirmation, plans the
 * first probe, and drops the login columns on every other status change (reactivation, an admin
 * excluding the account, also while a question is open).
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server; uses its own scratch database,
 * since an edit to 0070 never re-runs on a database that already applied it.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const DATABASE = `restow_db_login_refused_${randomBytes(4).toString("hex")}`;
const BEFORE_0070 = "0069_object_status_reason";

function urlFor(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

/** A migrations folder holding only what shipped up to and including `tag`. */
function migrationsFolderUpTo(tag: string): string {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((item) => item.tag === tag);
  if (last < 0) {
    throw new Error(`${tag} is not in the migration journal`);
  }
  const entries = journal.entries.slice(0, last + 1);
  const folder = mkdtempSync(join(tmpdir(), "restow-0069-migrations-"));
  mkdirSync(join(folder, "meta"));
  for (const item of entries) {
    copyFileSync(join(migrationsFolder, `${item.tag}.sql`), join(folder, `${item.tag}.sql`));
  }
  writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
  return folder;
}

interface Row {
  status: string;
  status_reason: string | null;
  inactive_since: Date | null;
  inactive_notified_at: Date | null;
  status_confirmed_at: Date | null;
  status_confirmed_by: string | null;
  login_failed_runs: number;
  login_failed_since: Date | null;
  login_failed_at: Date | null;
  login_question_at: Date | null;
  login_question_dismissed_at: Date | null;
  login_probe_due_at: Date | null;
}

describe.skipIf(!adminUrl)("migration 0070: IMAP accounts whose login is refused", () => {
  let folder: string;
  let pool: pg.Pool;
  let imapSourceId: string;
  let m365SourceId: string;
  let tenantId: string;
  let counter = 0;

  const row = async (externalId: string): Promise<Row> =>
    (
      await pool.query<Row>(
        `SELECT status, status_reason, inactive_since, inactive_notified_at, status_confirmed_at,
                status_confirmed_by, login_failed_runs, login_failed_since, login_failed_at,
                login_question_at, login_question_dismissed_at, login_probe_due_at
           FROM protected_objects WHERE external_id = $1`,
        [externalId],
      )
    ).rows[0] as Row;

  /** An active IMAP account with a login streak and an open question. */
  async function failingAccount(question = true): Promise<string> {
    const externalId = `acct-${++counter}@example.test`;
    await pool.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, external_id,
                                      login_failed_runs, login_failed_since, login_failed_at,
                                      login_question_at)
       VALUES ($1, $2, 'imap', 'active', $3, 3, now() - interval '3 days',
               now() - interval '1 day', ${question ? "now() - interval '1 hour'" : "NULL"})`,
      [tenantId, imapSourceId, externalId],
    );
    return externalId;
  }

  const shutDown = (externalId: string) =>
    pool.query(
      `UPDATE protected_objects
          SET status = 'orphaned', status_reason = 'login_refused',
              status_confirmed_at = now(), status_confirmed_by = 'admin@example.test',
              login_question_at = NULL, login_question_dismissed_at = NULL
        WHERE external_id = $1`,
      [externalId],
    );

  const cleared = {
    login_failed_runs: 0,
    login_failed_since: null,
    login_failed_at: null,
    login_question_at: null,
    login_question_dismissed_at: null,
    login_probe_due_at: null,
  };

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl as string });
    try {
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    folder = migrationsFolderUpTo(BEFORE_0070);
    pool = new pg.Pool({ connectionString: urlFor(adminUrl as string, DATABASE) });
    await migrate(drizzle(pool), { migrationsFolder: folder });
    const provider = await pool.query<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('P') RETURNING id",
    );
    const tenant = await pool.query<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'T', 't-0070') RETURNING id",
      [provider.rows[0]?.id],
    );
    tenantId = tenant.rows[0]?.id as string;
    const imap = await pool.query<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'imap', 'Mail', 'active') RETURNING id",
      [tenantId],
    );
    imapSourceId = imap.rows[0]?.id as string;
    const m365 = await pool.query<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'm365', 'M365', 'active') RETURNING id",
      [tenantId],
    );
    m365SourceId = m365.rows[0]?.id as string;
    // 0.4.7 data: an IMAP account and a disabled mailbox.
    await pool.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, external_id)
       VALUES ($1, $2, 'imap', 'active', 'old@example.test')`,
      [tenantId, imapSourceId],
    );
    await pool.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, status_reason, external_id)
       VALUES ($1, $2, 'mailbox', 'orphaned', 'account_disabled', 'disabled@example.test')`,
      [tenantId, m365SourceId],
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (folder) {
      rmSync(folder, { recursive: true, force: true });
    }
    if (adminUrl) {
      await dropTestDatabase(adminUrl, DATABASE);
    }
  });

  it("leaves rows from before the upgrade at 0 / NULL", async () => {
    expect(await row("old@example.test")).toMatchObject({ status: "active", ...cleared });
    expect(await row("disabled@example.test")).toMatchObject({
      status: "orphaned",
      status_reason: "account_disabled",
      ...cleared,
    });
  });

  it("keeps the admin's confirmation on active -> orphaned(login_refused) and plans the probe", async () => {
    const id = await failingAccount();
    await shutDown(id);
    const shut = await row(id);
    expect(shut).toMatchObject({
      status: "orphaned",
      status_reason: "login_refused",
      status_confirmed_by: "admin@example.test",
      login_question_at: null,
      login_question_dismissed_at: null,
    });
    expect(shut.status_confirmed_at).toBeInstanceOf(Date);
    expect(shut.inactive_since).toBeInstanceOf(Date);
    expect(shut.inactive_notified_at).toBeInstanceOf(Date);
    // The first probe is due in a week; the streak columns stay for the history of the answer.
    const week = shut.login_probe_due_at as Date;
    expect(week.getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3_600_000);
    expect(week.getTime() - Date.now()).toBeLessThan(7.1 * 24 * 3_600_000);
    expect(shut.login_failed_runs).toBe(3);
  });

  it("takes the probe date the writer gave", async () => {
    const id = await failingAccount();
    await pool.query(
      `UPDATE protected_objects
          SET status = 'orphaned', status_reason = 'login_refused',
              status_confirmed_at = now(), status_confirmed_by = 'admin@example.test',
              login_probe_due_at = now() + interval '1 day'
        WHERE external_id = $1`,
      [id],
    );
    const due = (await row(id)).login_probe_due_at as Date;
    expect(due.getTime() - Date.now()).toBeLessThan(1.1 * 24 * 3_600_000);
  });

  it("refuses login_refused without a confirmation or on a mailbox, and drops it on an active row", async () => {
    const id = await failingAccount();
    await expect(
      pool.query(
        `UPDATE protected_objects SET status = 'orphaned', status_reason = 'login_refused'
          WHERE external_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "protected_objects_login_refused_ck" });
    await expect(
      pool.query(
        `INSERT INTO protected_objects (tenant_id, source_id, kind, status, status_reason,
                                        status_confirmed_at, status_confirmed_by, external_id)
         VALUES ($1, $2, 'mailbox', 'orphaned', 'login_refused', now(), 'a@b.example', 'mbx')`,
        [tenantId, m365SourceId],
      ),
    ).rejects.toMatchObject({ constraint: "protected_objects_login_refused_ck" });
    // On an active row the trigger drops the reason (and the confirmation) before the check.
    await pool.query(
      `UPDATE protected_objects SET status_reason = 'login_refused',
              status_confirmed_at = now(), status_confirmed_by = 'a@b.example'
        WHERE external_id = $1`,
      [id],
    );
    expect(await row(id)).toMatchObject({ status: "active", status_reason: null });
  });

  it("refuses login_refused without a probe date or with a confirmation the trigger wrote", async () => {
    // A row inserted as shut down skips the trigger's transition branch: no probe date is planned.
    await expect(
      pool.query(
        `INSERT INTO protected_objects (tenant_id, source_id, kind, status, status_reason,
                                        status_confirmed_at, status_confirmed_by, external_id)
         VALUES ($1, $2, 'imap', 'orphaned', 'login_refused', now(), 'a@b.example', 'no-probe')`,
        [tenantId, imapSourceId],
      ),
    ).rejects.toMatchObject({ constraint: "protected_objects_login_refused_ck" });
    // An excluded account that turns login_refused gets the trigger's 'excluded' confirmation,
    // which is no admin answer.
    const excluded = `acct-${++counter}-excluded@example.test`;
    await pool.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, external_id)
       VALUES ($1, $2, 'imap', 'excluded', $3)`,
      [tenantId, imapSourceId, excluded],
    );
    await expect(
      pool.query(
        `UPDATE protected_objects SET status = 'orphaned', status_reason = 'login_refused'
          WHERE external_id = $1`,
        [excluded],
      ),
    ).rejects.toMatchObject({ constraint: "protected_objects_login_refused_ck" });
    // The 'migration' confirmation of 0069 is no answer either.
    const id = await failingAccount();
    await expect(
      pool.query(
        `UPDATE protected_objects
            SET status = 'orphaned', status_reason = 'login_refused',
                status_confirmed_at = now(), status_confirmed_by = 'migration'
          WHERE external_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "protected_objects_login_refused_ck" });
  });

  it("refuses a dismissal without a question and a negative counter", async () => {
    const id = await failingAccount(false);
    await expect(
      pool.query(
        "UPDATE protected_objects SET login_question_dismissed_at = now() WHERE external_id = $1",
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "protected_objects_login_question_ck" });
    await expect(
      pool.query("UPDATE protected_objects SET login_failed_runs = -1 WHERE external_id = $1", [
        id,
      ]),
    ).rejects.toMatchObject({ constraint: "protected_objects_login_failed_runs_ck" });
  });

  it("clears reason, dates, confirmation and the login columns on login_refused -> active", async () => {
    const id = await failingAccount();
    await shutDown(id);
    await pool.query(
      "UPDATE protected_objects SET status = 'active', active_since = now() WHERE external_id = $1",
      [id],
    );
    expect(await row(id)).toMatchObject({
      status: "active",
      status_reason: null,
      inactive_since: null,
      inactive_notified_at: null,
      status_confirmed_at: null,
      status_confirmed_by: null,
      ...cleared,
    });
  });

  it("clears the login columns when an admin excludes a shut-down account", async () => {
    const id = await failingAccount();
    await shutDown(id);
    await pool.query("UPDATE protected_objects SET status = 'excluded' WHERE external_id = $1", [
      id,
    ]);
    expect(await row(id)).toMatchObject({
      status: "excluded",
      status_reason: null,
      status_confirmed_at: null,
      ...cleared,
    });
  });

  it("clears an open question when the account is excluded, so re-including starts clean", async () => {
    const id = await failingAccount();
    await pool.query("UPDATE protected_objects SET status = 'excluded' WHERE external_id = $1", [
      id,
    ]);
    expect(await row(id)).toMatchObject({ status: "excluded", ...cleared });
    await pool.query("UPDATE protected_objects SET status = 'active' WHERE external_id = $1", [id]);
    expect(await row(id)).toMatchObject({ status: "active", ...cleared });
  });

  it("keeps everything on a plain update of the dates (what the demo's shift-time does)", async () => {
    const id = await failingAccount();
    await shutDown(id);
    const before = await row(id);
    await pool.query(
      `UPDATE protected_objects
          SET inactive_since = inactive_since - interval '2 days',
              login_probe_due_at = login_probe_due_at - interval '2 days',
              login_failed_at = login_failed_at - interval '2 days'
        WHERE external_id = $1`,
      [id],
    );
    const after = await row(id);
    expect(after).toMatchObject({
      status: "orphaned",
      status_reason: "login_refused",
      status_confirmed_by: "admin@example.test",
      login_failed_runs: 3,
    });
    expect(
      (before.login_probe_due_at as Date).getTime() - (after.login_probe_due_at as Date).getTime(),
    ).toBe(2 * 24 * 3_600_000);
  });

  it("keeps a streak and a question while the account stays active", async () => {
    const id = await failingAccount();
    await pool.query("UPDATE protected_objects SET updated_at = now() WHERE external_id = $1", [
      id,
    ]);
    const after = await row(id);
    expect(after.login_failed_runs).toBe(3);
    expect(after.login_question_at).toBeInstanceOf(Date);
    await pool.query(
      "UPDATE protected_objects SET login_question_dismissed_at = now() WHERE external_id = $1",
      [id],
    );
    expect((await row(id)).login_question_dismissed_at).toBeInstanceOf(Date);
  });

  it("still sets account_disabled and its confirmation lifecycle for Microsoft 365 rows", async () => {
    await pool.query(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, status, external_id)
       VALUES ($1, $2, 'mailbox', 'active', 'm365-user')`,
      [tenantId, m365SourceId],
    );
    await pool.query(
      "UPDATE protected_objects SET status = 'orphaned', status_reason = 'account_disabled' WHERE external_id = 'm365-user'",
    );
    const orphaned = await row("m365-user");
    expect(orphaned).toMatchObject({
      status: "orphaned",
      status_reason: "account_disabled",
      status_confirmed_at: null,
      login_probe_due_at: null,
    });
    expect(orphaned.inactive_since).toBeInstanceOf(Date);
  });
});
