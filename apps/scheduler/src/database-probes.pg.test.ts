// The sweep of database test credentials against a real Postgres: an expired test ends and lets
// go of its credentials, a finished test of unsaved settings keeps them 30 minutes and no longer,
// a running test that may still be answered keeps them, and every tenant is swept without a
// request of its own.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
// `restow_scheduler_database_probes_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseProbeSweeper } from "./database-probes.js";
import { ignoreTerminatedConnection } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_scheduler_database_probes_test";
const MINUTE = 60_000;

describe.skipIf(!adminUrl)("the sweep of database test credentials", () => {
  let db: ReturnType<typeof createDb>;
  const tenants: string[] = [];
  const now = new Date("2026-11-17T12:00:00Z");

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    db.$client.query<T>(text, values).then((result) => result.rows);

  async function probe(
    tenantId: string,
    status: string,
    expiresAt: Date,
    finishedAt: Date | null,
  ): Promise<{ probe: string; secret: string }> {
    const [secret] = await q<{ id: string }>(
      `INSERT INTO secrets (tenant_id, kind, ciphertext)
       VALUES ($1, 'database_probe_credentials', 'sealed-fixture') RETURNING id`,
      [tenantId],
    );
    const [row] = await q<{ id: string }>(
      `INSERT INTO database_probes (tenant_id, executor_kind, spec, credential_secret_id, status,
                                    created_at, finished_at, expires_at)
       VALUES ($1, 'server', '{}'::jsonb, $2, $3, $4, $5, $6) RETURNING id`,
      [tenantId, secret?.id, status, new Date(now.getTime() - 40 * MINUTE), finishedAt, expiresAt],
    );
    return { probe: row?.id as string, secret: secret?.id as string };
  }

  const secretExists = async (id: string) =>
    (await q("SELECT 1 FROM secrets WHERE id = $1", [id])).length === 1;

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await admin.$client.end();
    }
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    db.$client.on("error", ignoreTerminatedConnection);
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const rows = await q<{ id: string }>(
      `INSERT INTO tenants (provider_id, name, slug, status)
       VALUES ($1, 'Contoso', 'contoso', 'active'), ($1, 'Fabrikam', 'fabrikam', 'active')
       RETURNING id`,
      [provider?.id],
    );
    tenants.push(...rows.map((row) => row.id));
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    const admin = createDb(adminUrl as string);
    try {
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    } finally {
      await admin.$client.end();
    }
  });

  it("drops credentials that may no longer be used, in every tenant", async () => {
    const [contoso, fabrikam] = tenants as [string, string];
    const expired = await probe(contoso, "pending", new Date(now.getTime() - MINUTE), null);
    const oldDone = await probe(fabrikam, "done", now, new Date(now.getTime() - 31 * MINUTE));
    const freshDone = await probe(contoso, "done", now, new Date(now.getTime() - 5 * MINUTE));
    const running = await probe(fabrikam, "running", new Date(now.getTime() + MINUTE), null);

    const sweeper = new DatabaseProbeSweeper(db.$client, 0);
    expect(await sweeper.sweep(now)).toBe(2);

    expect(await secretExists(expired.secret)).toBe(false);
    expect(await secretExists(oldDone.secret)).toBe(false);
    expect(await secretExists(freshDone.secret)).toBe(true);
    expect(await secretExists(running.secret)).toBe(true);
    const states = await q<{ id: string; status: string; error_code: string | null }>(
      "SELECT id, status, error_code FROM database_probes WHERE id = ANY($1::uuid[])",
      [[expired.probe, oldDone.probe]],
    );
    expect(Object.fromEntries(states.map((row) => [row.id, row]))).toMatchObject({
      [expired.probe]: { status: "expired", error_code: "db_runner_offline" },
      [oldDone.probe]: { status: "done" },
    });
    // Nothing left to do on the next pass.
    expect(await sweeper.sweep(new Date(now.getTime() + 1))).toBe(0);
  });
});
