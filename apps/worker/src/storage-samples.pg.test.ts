// The daily size samples of the capacity page against a real Postgres:
//
//   - one pass writes a tenant's chunk store (the sum of its packs, also 0 bytes) and the restic
//     repository of every machine, file share and container that has a measured size;
//   - a tenant that has today's rows is not measured again (the endpoint monitor calls the sampler
//     every five minutes), a new UTC day measures it again and keeps the rows of the days before;
//   - tenants being deleted are left out, the work per pass is bounded and the rest follows;
//   - rows past the retention of 400 days are removed, newer ones stay.
//
// Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server (a database named
// `restow_worker_samples_test` is recreated there); skipped otherwise.

import { createDb } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EndpointJobDeps } from "./endpoints/common.js";
import { recordStorageSamples, sampleDay } from "./storage-samples.js";
import { dropTestDatabase } from "./testing/database.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_samples_test";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-30T09:30:00.000Z");

describe("sampleDay", () => {
  it("is the UTC day of the moment, whatever the local zone", () => {
    expect(sampleDay(new Date("2026-10-30T23:59:59.999Z"))).toBe("2026-10-30");
    expect(sampleDay(new Date("2026-10-31T00:00:00.000Z"))).toBe("2026-10-31");
  });
});

describe.skipIf(!adminUrl)("storage samples against Postgres", () => {
  let db: ReturnType<typeof createDb>;
  let deps: EndpointJobDeps;
  let contoso: string;
  let fabrikam: string;
  let leaving: string;
  const ids: Record<string, string> = {};

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    db.$client.query<T>(text, values).then((result) => result.rows);

  const samples = (tenantId: string, day?: string) =>
    q<{ source_kind: string; source_id: string | null; day: string; bytes: string }>(
      `SELECT source_kind, source_id, to_char(day, 'YYYY-MM-DD') AS day, bytes::text
         FROM storage_samples WHERE tenant_id = $1 ${day ? "AND day = $2" : ""}
        ORDER BY day, source_kind, source_id`,
      day ? [tenantId, day] : [tenantId],
    );

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    await runMigrations(url.toString());
    db = createDb(url.toString());
    const warnings: string[] = [];
    deps = {
      db,
      providerDb: db,
      runtime: { logger: { warn: (message: string) => warnings.push(message) } } as never,
    };

    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const created = await q<{ id: string }>(
      `INSERT INTO tenants (provider_id, name, slug, status, created_at) VALUES
         ($1, 'Contoso', 'contoso', 'active', now() - interval '3 days'),
         ($1, 'Fabrikam', 'fabrikam', 'suspended', now() - interval '2 days'),
         ($1, 'Leaving', 'leaving', 'deleting', now() - interval '1 day') RETURNING id`,
      [provider?.id],
    );
    contoso = created[0]?.id ?? "";
    fabrikam = created[1]?.id ?? "";
    leaving = created[2]?.id ?? "";

    // Contoso: two packs, two machines (one never measured), a share and a container.
    await q(
      `INSERT INTO packs (tenant_id, path, sha256, size) VALUES
         ($1, 'p/1', 'a', 1000), ($1, 'p/2', 'b', 2500)`,
      [contoso],
    );
    await q("INSERT INTO packs (tenant_id, path, sha256, size) VALUES ($1, 'p/9', 'z', 77)", [
      leaving,
    ]);
    const machines = await q<{ id: string; hostname: string }>(
      `INSERT INTO endpoints (tenant_id, hostname, os, arch, profile, secret_hash, config, repository_bytes) VALUES
         ($1, 'srv-1', 'linux', 'amd64', 'server', 'h1', '{}', 4000),
         ($1, 'srv-new', 'linux', 'amd64', 'server', 'h2', '{}', NULL) RETURNING id, hostname`,
      [contoso],
    );
    ids.machine = machines.find((row) => row.hostname === "srv-1")?.id ?? "";
    ids.unmeasured = machines.find((row) => row.hostname === "srv-new")?.id ?? "";
    const [share] = await q<{ id: string }>(
      `INSERT INTO file_shares (tenant_id, name, protocol, server, repository_bytes)
       VALUES ($1, 'Office', 'smb', 'nas.example', 900) RETURNING id`,
      [contoso],
    );
    ids.share = share?.id ?? "";
    const [cluster] = await q<{ id: string }>(
      "INSERT INTO pve_clusters (tenant_id, name, fingerprint, storage_id) VALUES ($1, 'lab', 'fp-samples', 'restow') RETURNING id",
      [contoso],
    );
    const [guest] = await q<{ id: string }>(
      `INSERT INTO pve_guests (tenant_id, cluster_id, vmid, kind, name, repository_bytes)
       VALUES ($1, $2, 101, 'vm', 'web', 0) RETURNING id`,
      [contoso, cluster?.id],
    );
    ids.guest = guest?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await dropTestDatabase(adminUrl as string, TEST_DB);
  });

  it("writes the chunk store and every measured repository of each tenant that is not being deleted", async () => {
    // A bound of one: the oldest tenant first, the next pass takes the rest.
    expect(await recordStorageSamples(deps, NOW, { limit: 1 })).toMatchObject({
      tenants: 1,
      rows: 4,
    });
    expect((await samples(fabrikam)).length).toBe(0);

    expect(await recordStorageSamples(deps, NOW)).toEqual({ tenants: 1, rows: 1, removed: 0 });

    const rows = await samples(contoso, "2026-10-30");
    expect(rows.map((row) => [row.source_kind, row.source_id, row.bytes])).toEqual([
      ["chunk_store", null, "3500"],
      ["endpoint", ids.machine, "4000"],
      ["file_share", ids.share, "900"],
      ["pve_guest", ids.guest, "0"],
    ]);
    // An empty tenant still has its chunk store row: the day is complete.
    expect((await samples(fabrikam)).map((row) => [row.source_kind, row.bytes])).toEqual([
      ["chunk_store", "0"],
    ]);
    expect((await samples(leaving)).length).toBe(0);
  });

  it("measures a tenant once a day: the passes of the same UTC day find nothing to do", async () => {
    const before = await q<{ n: string }>("SELECT count(*)::text AS n FROM storage_samples");
    const later = new Date("2026-10-30T23:55:00.000Z");
    expect(await recordStorageSamples(deps, later)).toEqual({ tenants: 0, rows: 0, removed: 0 });
    expect((await q<{ n: string }>("SELECT count(*)::text AS n FROM storage_samples"))[0]).toEqual(
      before[0],
    );
  });

  it("measures again on the next UTC day and keeps the days before", async () => {
    await q("UPDATE endpoints SET repository_bytes = 5000 WHERE id = $1", [ids.machine]);
    await q("INSERT INTO packs (tenant_id, path, sha256, size) VALUES ($1, 'p/3', 'c', 500)", [
      contoso,
    ]);
    const tomorrow = new Date("2026-10-31T00:05:00.000Z");
    expect((await recordStorageSamples(deps, tomorrow)).tenants).toBe(2);

    const byDay = (await samples(contoso)).filter((row) => row.source_kind !== "file_share");
    expect(byDay.map((row) => [row.day, row.source_kind, row.bytes])).toEqual([
      ["2026-10-30", "chunk_store", "3500"],
      ["2026-10-30", "endpoint", "4000"],
      ["2026-10-30", "pve_guest", "0"],
      ["2026-10-31", "chunk_store", "4000"],
      ["2026-10-31", "endpoint", "5000"],
      ["2026-10-31", "pve_guest", "0"],
    ]);
  });

  it("allows one row per source and day, the chunk store (no source) included", async () => {
    await expect(
      q(
        `INSERT INTO storage_samples (tenant_id, source_kind, source_id, day, bytes)
         VALUES ($1, 'chunk_store', NULL, '2026-10-31', 1)`,
        [contoso],
      ),
    ).rejects.toThrow(/storage_samples_source_day_uq/);
    // A chunk store row names no source, any other kind names one.
    await expect(
      q(
        `INSERT INTO storage_samples (tenant_id, source_kind, source_id, day, bytes)
         VALUES ($1, 'endpoint', NULL, '2026-10-29', 1)`,
        [contoso],
      ),
    ).rejects.toThrow(/storage_samples_source_ck/);
  });

  it("removes the samples past 400 days and keeps the newer ones", async () => {
    const day = (daysAgo: number) => sampleDay(new Date(NOW.getTime() - daysAgo * DAY));
    await q(
      `INSERT INTO storage_samples (tenant_id, source_kind, source_id, day, bytes) VALUES
         ($1, 'chunk_store', NULL, $2, 10), ($1, 'chunk_store', NULL, $3, 20)`,
      [fabrikam, day(401), day(400)],
    );
    const result = await recordStorageSamples(deps, NOW);
    expect(result.removed).toBe(1);
    const left = await q<{ day: string }>(
      "SELECT to_char(day, 'YYYY-MM-DD') AS day FROM storage_samples WHERE tenant_id = $1 ORDER BY day",
      [fabrikam],
    );
    expect(left.map((row) => row.day)).toContain(day(400));
    expect(left.map((row) => row.day)).not.toContain(day(401));
  });

  it("does not let one tenant that cannot be read keep the others from being measured", async () => {
    const failing = new Date("2026-11-02T10:00:00.000Z");
    // The first tenant's transaction fails, the second one's goes through.
    let calls = 0;
    const blocked = {
      ...deps,
      db: new Proxy(deps.db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return (fn: never) => {
              calls++;
              return calls === 1
                ? Promise.reject(new Error("boom"))
                : (target.transaction as (f: never) => Promise<unknown>)(fn);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    } as EndpointJobDeps;
    const summary = await recordStorageSamples(blocked, failing);
    expect(summary.tenants).toBe(1);
  });
});
