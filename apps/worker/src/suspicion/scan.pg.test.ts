/**
 * The ransomware judgement pass against Postgres (docs/RANSOMWARE.md): new restore points of
 * machines, file shares and mailboxes are judged once against the object's own history (runs
 * from before the detection count), a suspicious one raises `backup.suspicious` once per
 * episode with its findings, the ones after it in the same episode stay quiet, a clean one ends
 * the episode, an older agent's run is judged by what it has, and nothing is judged while the
 * installation switched the detection off.
 *
 * Every time is relative to the moment the test runs. Runs when RESTOW_TEST_DATABASE_URL points
 * at a Postgres server as a superuser; skipped otherwise.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { createLogger, defaultEndpointConfig, type LogRecord, noopLogger } from "@restow/core";
import { createDb, type Database, deriveAuthLogin, type RoleLogin } from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase } from "../testing/database.js";
import { candidatesQuery, type SuspicionDeps, suspicionPass } from "./scan.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_suspicion_test";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe.skipIf(!adminUrl)("judging restore points against Postgres", () => {
  let owner: Database;
  let deps: SuspicionDeps;
  let tenantId: string;
  let endpointId: string;
  let shareId: string;
  let mailboxId: string;
  const roleNames: string[] = [];
  const now = new Date();
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const q = <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    owner.$client.query<T>(text, values).then((r) => r.rows);

  /** A finished backup run of the machine: `changed` new and changed files. */
  async function endpointRun(at: Date, changed: number, extra: Record<string, unknown> = {}) {
    const stats = {
      filesNew: Math.round(changed / 2),
      filesChanged: changed - Math.round(changed / 2),
      filesUnmodified: 50_000,
      dataAdded: changed * 100_000,
      totalFilesProcessed: 50_000 + changed,
      totalBytesProcessed: 10 * 1024 ** 3,
      ...extra,
    };
    const [row] = await q<{ id: string }>(
      `INSERT INTO endpoint_runs (tenant_id, endpoint_id, kind, status, started_at, finished_at, snapshot_id, stats)
       VALUES ($1, $2, 'backup', 'succeeded', $3, $3, $4, $5) RETURNING id`,
      [tenantId, endpointId, at, randomBytes(32).toString("hex"), JSON.stringify(stats)],
    );
    return row?.id as string;
  }

  const judgement = async (runId: string) =>
    (
      await q<{
        verdict: string;
        findings: { code: string }[];
        signals: Record<string, string>;
        alerted_at: Date | null;
        restore_point_id: string;
        object_kind: string;
      }>("SELECT * FROM restore_point_suspicions WHERE run_id = $1", [runId])
    )[0];

  const alerts = async () =>
    q<{ details: Record<string, unknown>; message: string }>(
      "SELECT details, message FROM notifications WHERE event = 'backup.suspicious' ORDER BY created_at",
    );

  const notes = {
    v: 1,
    added: 1200,
    modified: 0,
    removed: 0,
    renamed: 0,
    extensions: [{ value: "txt", count: 40 }],
    names: [{ value: "HOW_TO_DECRYPT_FILES.txt", count: 40 }],
    entropy: [],
  };

  beforeAll(async () => {
    const admin = createDb(adminUrl as string);
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
    await admin.$client.end();
    const url = new URL(adminUrl as string);
    url.pathname = `/${TEST_DB}`;
    const suffix = randomBytes(4).toString("hex");
    const tenantLogin: RoleLogin = {
      name: `restow_ws_app_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    const installationLogin: RoleLogin = {
      name: `restow_ws_inst_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    roleNames.push(
      tenantLogin.name,
      installationLogin.name,
      deriveAuthLogin(tenantLogin, installationLogin).name,
    );
    await runMigrations(url.toString(), {
      roles: { tenant: tenantLogin, installation: installationLogin },
    });
    owner = createDb(url.toString());
    const asRole = (login: RoleLogin) => {
      const copy = new URL(url);
      copy.username = login.name;
      copy.password = login.password;
      return createDb(copy.toString());
    };
    deps = {
      db: asRole(tenantLogin),
      providerDb: asRole(installationLogin),
      runtime: {
        logger: noopLogger,
        now: () => now,
        shutdownSignal: new AbortController().signal,
      },
    };
    const [provider] = await q<{ id: string }>(
      "INSERT INTO providers (name) VALUES ('p') RETURNING id",
    );
    const [tenant] = await q<{ id: string }>(
      "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id",
      [provider?.id],
    );
    tenantId = tenant?.id as string;
    endpointId = randomUUID();
    await q(
      `INSERT INTO endpoints (id, tenant_id, hostname, display_name, os, arch, profile, status, secret_hash, config)
       VALUES ($1, $2, 'fs01', 'Fileserver', 'linux', 'amd64', 'server', 'active', 'x', $3)`,
      [
        endpointId,
        tenantId,
        JSON.stringify(defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" })),
      ],
    );
    await q(
      `INSERT INTO report_rules (tenant_id, name, trigger, events, throttle_minutes, email_recipients)
       VALUES ($1, 'Ransomware', 'event', ARRAY['backup.suspicious'], 60, ARRAY['it@contoso.example'])`,
      [tenantId],
    );
    await q(
      `INSERT INTO tenant_notification_recipients (tenant_id, email, events)
       VALUES ($1, 'it@contoso.example', ARRAY['backup.suspicious'])`,
      [tenantId],
    );
  }, 60_000);

  afterAll(async () => {
    await Promise.all([
      deps?.db.$client.end(),
      deps?.providerDb.$client.end(),
      owner?.$client.end(),
    ]);
    await dropTestDatabase(adminUrl as string, TEST_DB);
    const admin = createDb(adminUrl as string);
    try {
      for (const role of roleNames) {
        await admin.$client.query(`DROP ROLE IF EXISTS ${role}`);
      }
    } finally {
      await admin.$client.end();
    }
  });

  it("judges nothing while the installation switched the detection off", async () => {
    await q(`INSERT INTO settings (ransomware_detection) VALUES ('{"enabled": false}')`);
    const run = await endpointRun(ago(70 * HOUR), 300);
    expect(await suspicionPass(deps)).toEqual({
      judged: 0,
      suspicious: 0,
      alerts: 0,
      reminders: 0,
    });
    expect(await judgement(run)).toBeUndefined();
    await q(`UPDATE settings SET ransomware_detection = '{}'`);
  });

  it("judges a machine's restore points against its history, one alert per episode", async () => {
    // Ten ordinary days before the window: the baseline, never judged themselves.
    for (let day = 13; day >= 4; day--) {
      await endpointRun(ago(day * DAY), 280 + (day % 4) * 10);
    }
    const ordinary = await endpointRun(ago(60 * HOUR), 300);
    const attack = await endpointRun(ago(48 * HOUR), 45_000, { activity: notes });
    const still = await endpointRun(ago(36 * HOUR), 30_000);
    const clean = await endpointRun(ago(24 * HOUR), 310);
    const again = await endpointRun(ago(12 * HOUR), 40_000);

    const summary = await suspicionPass(deps);
    // The run of the first test is judged now as well: six.
    expect(summary).toEqual({ judged: 6, suspicious: 3, alerts: 2, reminders: 0 });

    expect(await judgement(ordinary)).toMatchObject({
      verdict: "none",
      object_kind: "endpoint",
      signals: { changeRate: "clear", names: "unavailable", entropy: "unavailable" },
    });
    const first = await judgement(attack);
    expect(first?.verdict).toBe("suspicious");
    expect(first?.findings.map((f) => f.code)).toEqual([
      "change_rate_items",
      "change_rate_bytes",
      "ransom_notes",
    ]);
    expect(first?.alerted_at).not.toBeNull();
    // The same episode: marked, not announced again.
    expect(await judgement(still)).toMatchObject({ verdict: "suspicious", alerted_at: null });
    // The suspicious ones stay out of the baseline: an ordinary day is still ordinary.
    expect((await judgement(clean))?.verdict).toBe("none");
    // A clean restore point ended the episode: the next finding is news.
    expect((await judgement(again))?.alerted_at).not.toBeNull();

    const raised = await alerts();
    expect(raised).toHaveLength(2);
    expect(raised[0]?.details).toMatchObject({
      endpointId,
      objectKind: "endpoint",
      objectName: "Fileserver",
      runId: attack,
      restorePointId: first?.restore_point_id,
    });
    expect(raised[0]?.message).toContain("40 files named like a ransom note");
    // The alert says that retention of the machine is paused now.
    expect(raised[0]?.message).toContain("Retention of this object is paused");
    expect(raised[0]?.details).toMatchObject({ retentionHeld: true });
    const queued = await q<{ subject_key: string; recipient: string }>(
      "SELECT subject_key, recipient FROM report_deliveries WHERE event = 'backup.suspicious'",
    );
    expect(queued[0]).toEqual({
      subject_key: `endpoint:${endpointId}`,
      recipient: "it@contoso.example",
    });

    // Judged once: a second pass finds nothing new.
    expect(await suspicionPass(deps)).toEqual({
      judged: 0,
      suspicious: 0,
      alerts: 0,
      reminders: 0,
    });
  });

  it("does not judge runs older than the window or runs that made no restore point", async () => {
    const old = await endpointRun(ago(5 * DAY), 90_000);
    const [failed] = await q<{ id: string }>(
      `INSERT INTO endpoint_runs (tenant_id, endpoint_id, kind, status, started_at, finished_at)
       VALUES ($1, $2, 'backup', 'failed', $3, $3) RETURNING id`,
      [tenantId, endpointId, ago(HOUR)],
    );
    await suspicionPass(deps);
    expect(await judgement(old)).toBeUndefined();
    expect(await judgement(failed?.id as string)).toBeUndefined();
  });

  it("judges file shares and mailboxes by their own numbers", async () => {
    const [share] = await q<{ id: string }>(
      `INSERT INTO file_shares (tenant_id, name, protocol, server, share_name)
       VALUES ($1, 'Projects', 'smb', 'files.example.test', 'projects') RETURNING id`,
      [tenantId],
    );
    shareId = share?.id as string;
    const shareRun = async (at: Date, stats: Record<string, unknown>) => {
      const snapshot = randomUUID();
      const [row] = await q<{ id: string }>(
        `INSERT INTO file_share_runs (tenant_id, file_share_id, lock_share_id, kind, status, started_at, finished_at, snapshot_id, stats)
         VALUES ($1, $2, $2, 'backup', 'succeeded', $3, $3, $4, $5) RETURNING id`,
        [tenantId, shareId, at, snapshot, JSON.stringify(stats)],
      );
      return { run: row?.id as string, snapshot };
    };
    const renamed = await shareRun(ago(2 * HOUR), {
      files: 20_000,
      filesNew: 5000,
      filesChanged: 0,
      dataAdded: 1024,
      activity: {
        v: 1,
        added: 5000,
        removed: 5000,
        renamed: 5000,
        extensions: [{ value: "akira", count: 5000 }],
        names: [],
        entropy: [],
      },
    });

    const [source] = await q<{ id: string }>(
      "INSERT INTO sources (tenant_id, kind, name, status) VALUES ($1, 'imap', 'IMAP', 'active') RETURNING id",
      [tenantId],
    );
    const [mailbox] = await q<{ id: string }>(
      `INSERT INTO protected_objects (tenant_id, source_id, kind, external_id, display_name, status)
       VALUES ($1, $2, 'imap', 'anna@contoso.example', 'Anna Berg', 'active') RETURNING id`,
      [tenantId, source?.id],
    );
    mailboxId = mailbox?.id as string;
    const snapshotId = randomUUID();
    const [job] = await q<{ id: string }>(
      `INSERT INTO jobs (tenant_id, queue, status, protected_object_id, payload, completed_at)
       VALUES ($1, 'backup', 'completed', $2, $3, $4) RETURNING id`,
      [
        tenantId,
        mailboxId,
        JSON.stringify({
          result: { snapshotId, objectsWritten: 12, objectsTotal: 900, bytes: 4096 },
        }),
        ago(HOUR),
      ],
    );

    await suspicionPass(deps);
    const share_ = await judgement(renamed.run);
    expect(share_).toMatchObject({
      verdict: "suspicious",
      object_kind: "file_share",
      restore_point_id: renamed.snapshot,
    });
    expect(share_?.findings.map((f) => f.code)).toEqual(["mass_renames", "known_extensions"]);
    const mail = await judgement(job?.id as string);
    expect(mail).toMatchObject({
      verdict: "none",
      object_kind: "m365",
      restore_point_id: snapshotId,
      // A mailbox without history yet: the amount is still being learned.
      signals: { changeRate: "learning", names: "unavailable" },
    });
    const raised = await alerts();
    expect(raised.at(-1)?.details).toMatchObject({ fileShareId: shareId, objectName: "Projects" });
  });
  it("judges the compression and deduplication of a VM's new data against its own history", async () => {
    const [cluster] = await q<{ id: string }>(
      `INSERT INTO pve_clusters (tenant_id, name, fingerprint, storage_id)
       VALUES ($1, 'lab', $2, 'restow') RETURNING id`,
      [tenantId, "c".repeat(64)],
    );
    const guest = async (vmid: number) =>
      (
        await q<{ id: string }>(
          `INSERT INTO pve_guests (tenant_id, cluster_id, vmid, kind, name, node)
           VALUES ($1, $2, $3, 'vm', $4, 'pve1') RETURNING id`,
          [tenantId, cluster?.id, vmid, `vm-${vmid}`],
        )
      )[0]?.id as string;
    const GiB = 1024 ** 3;
    const vmRun = async (
      guestId: string,
      at: Date,
      shape: { newShare: number; compressed: number },
    ) => {
      const sampled = 64 * 1024 ** 2;
      const [row] = await q<{ id: string }>(
        `INSERT INTO pve_runs (tenant_id, cluster_id, guest_id, kind, status, started_at, finished_at, snapshot_id, stats)
         VALUES ($1, $2, $3, 'backup', 'succeeded', $4, $4, $5, $6) RETURNING id`,
        [
          tenantId,
          cluster?.id,
          guestId,
          at,
          randomUUID(),
          JSON.stringify({
            // The same amount of changed blocks every day: the change rate stays quiet.
            uploadedBytes: 3 * GiB,
            chunkBytesIn: 3 * GiB,
            chunkBytesNew: Math.round(3 * GiB * shape.newShare),
            chunkBytesSampled: sampled,
            chunkBytesSampledCompressed: Math.round(sampled * shape.compressed),
          }),
        ],
      );
      return row?.id as string;
    };
    const ordinary = await guest(201);
    const bitlocker = await guest(202);
    for (let day = 13; day >= 4; day--) {
      const wobble = (day % 3) * 0.02;
      await vmRun(ordinary, ago(day * DAY), { newShare: 0.35 + wobble, compressed: 0.45 + wobble });
      // An encrypted disk: its new data never compresses and never deduplicates.
      await vmRun(bitlocker, ago(day * DAY), { newShare: 0.97 + wobble / 4, compressed: 0.995 });
    }
    // The same day for both: every changed block is new and random.
    const attacked = await vmRun(ordinary, ago(3 * HOUR), { newShare: 0.99, compressed: 0.999 });
    const asAlways = await vmRun(bitlocker, ago(3 * HOUR), { newShare: 0.99, compressed: 0.999 });

    await suspicionPass(deps);
    const hit = await judgement(attacked);
    expect(hit).toMatchObject({
      verdict: "suspicious",
      object_kind: "pve_guest",
      signals: { changeRate: "clear", compressibility: "fired" },
    });
    expect(hit?.findings.map((f) => f.code)).toEqual(["incompressible_data", "dedup_collapse"]);
    expect(await judgement(asAlways)).toMatchObject({
      verdict: "none",
      signals: { compressibility: "clear" },
    });
    const raised = await alerts();
    expect(raised.at(-1)?.details).toMatchObject({ pveGuestId: ordinary, objectName: "vm-201" });
    expect(raised.at(-1)?.message).toContain("do not compress");
  });

  it("starts a container's history anew with a new backup chain", async () => {
    const [cluster] = await q<{ id: string }>(
      `INSERT INTO pve_clusters (tenant_id, name, fingerprint, storage_id)
       VALUES ($1, 'chain', $2, 'restow') RETURNING id`,
      [tenantId, "d".repeat(64)],
    );
    const [ct] = await q<{ id: string }>(
      `INSERT INTO pve_guests (tenant_id, cluster_id, vmid, kind, name, node)
       VALUES ($1, $2, 102, 'ct', 'achilles', 'pve1') RETURNING id`,
      [tenantId, cluster?.id],
    );
    const ctRun = async (at: Date, filesNew: number) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO pve_runs (tenant_id, cluster_id, guest_id, kind, status, started_at, finished_at, snapshot_id, stats)
         VALUES ($1, $2, $3, 'backup', 'succeeded', $4, $4, $5, $6) RETURNING id`,
        [
          tenantId,
          cluster?.id,
          ct?.id,
          at,
          randomUUID(),
          JSON.stringify({
            resticFilesNew: filesNew,
            resticFilesChanged: 0,
            resticFilesTotal: 60_000,
            resticBytesAdded: filesNew * 25_000,
          }),
        ],
      );
      return row?.id as string;
    };
    for (let day = 13; day >= 4; day--) {
      await ctRun(ago(day * DAY), 200 + (day % 3) * 20);
    }
    // The repository was gone: a new chain began, and its first backup adds every file again.
    const chainAt = ago(4 * HOUR);
    await q(`UPDATE pve_guests SET repository_chains = $2 WHERE id = $1`, [
      ct?.id,
      JSON.stringify([
        {
          at: chainAt.toISOString(),
          reason: "missing",
          target: null,
          actor: null,
          unavailablePoints: 5,
        },
      ]),
    ]);
    const first = await ctRun(ago(3 * HOUR), 60_000);

    await suspicionPass(deps);
    expect(await judgement(first)).toMatchObject({
      verdict: "none",
      signals: { changeRate: "learning" },
    });
  });

  it("announces an unresolved retention hold again after the reminder days, and a release ends the episode", async () => {
    const reminders = () =>
      q<{ details: Record<string, unknown>; level: string }>(
        `SELECT details, level FROM notifications WHERE event = 'backup.suspicious_hold'
         AND details->>'objectId' = $1 ORDER BY created_at`,
        [endpointId],
      );
    // The machine's hold began with the judgements of the second test, just now: not yet due.
    await suspicionPass(deps);
    expect(await reminders()).toHaveLength(0);

    // Fifteen days later (the judgements dated back), the hold is announced once.
    await q(
      `UPDATE restore_point_suspicions SET created_at = $2
       WHERE object_id = $1 AND verdict = 'suspicious'`,
      [endpointId, ago(15 * DAY)],
    );
    expect((await suspicionPass(deps)).reminders).toBeGreaterThanOrEqual(1);
    const [first] = await reminders();
    expect(first).toMatchObject({ level: "warning" });
    expect(first?.details).toMatchObject({
      endpointId,
      objectKind: "endpoint",
      objectName: "Fileserver",
      heldDays: 15,
      restorePoints: 3,
    });
    expect((await suspicionPass(deps)).reminders).toBe(0);
    // And again once the reminder itself is that old.
    await q(
      "UPDATE restore_point_suspicions SET hold_reminded_at = $2 WHERE object_id = $1 AND hold_reminded_at IS NOT NULL",
      [endpointId, ago(15 * DAY)],
    );
    await suspicionPass(deps);
    expect(await reminders()).toHaveLength(2);

    // The judgements of an object that was deleted remind nobody.
    await q(
      `INSERT INTO restore_point_suspicions (tenant_id, object_kind, object_id, run_id, restore_point_id,
         restore_point_at, verdict, metrics, signatures_version, created_at)
       VALUES ($1, 'file_share', $2, $3, 'gone', $4, 'suspicious', '{}'::jsonb, 'v', $4)`,
      [tenantId, randomUUID(), randomUUID(), ago(20 * DAY)],
    );
    const quiet = await q<{ count: string }>(
      "SELECT count(*) FROM notifications WHERE event = 'backup.suspicious_hold'",
    );
    await suspicionPass(deps);
    expect(
      await q<{ count: string }>(
        "SELECT count(*) FROM notifications WHERE event = 'backup.suspicious_hold'",
      ),
    ).toEqual(quiet);

    // An administrator releases the hold: no reminder any more, and the next finding is news
    // although the restore point before it is still marked suspicious.
    await q(
      `UPDATE restore_point_suspicions SET hold_released_at = $2, hold_released_by = 'admin'
       WHERE object_id = $1 AND verdict = 'suspicious'`,
      [endpointId, now],
    );
    await q("UPDATE restore_point_suspicions SET hold_reminded_at = NULL WHERE object_id = $1", [
      endpointId,
    ]);
    const before = (await alerts()).length;
    const next = await endpointRun(ago(HOUR / 2), 50_000);
    const summary = await suspicionPass(deps);
    expect(summary.reminders).toBe(0);
    expect(await judgement(next)).toMatchObject({ verdict: "suspicious" });
    expect((await judgement(next))?.alerted_at).not.toBeNull();
    expect((await alerts()).length).toBe(before + 1);
  });

  /** A clock that moves only when told, for the time a pass may take. */
  const stoppedClock = () => 0;

  it("reads batch after batch while the pass has time, and the first batch of each kind always", async () => {
    const runs = [];
    for (let minute = 50; minute >= 40; minute--) {
      runs.push(await endpointRun(ago(minute * 60 * 1000), 300));
    }
    // No time left: one batch of two, then the next kind.
    expect(await suspicionPass(deps, { batch: 2, budgetMs: 0, clock: stoppedClock })).toEqual({
      judged: 2,
      suspicious: 0,
      alerts: 0,
      reminders: 0,
    });
    expect(await judgement(runs[0] as string)).toBeDefined();
    expect(await judgement(runs[2] as string)).toBeUndefined();
    // Time enough: the other nine in batches of two, oldest first.
    expect(await suspicionPass(deps, { batch: 2, budgetMs: 60_000, clock: stoppedClock })).toEqual({
      judged: 9,
      suspicious: 0,
      alerts: 0,
      reminders: 0,
    });
    for (const run of runs) {
      expect(await judgement(run)).toBeDefined();
    }
  });

  it("does not read a run it could not judge again in the same pass", async () => {
    // Two runs with the same time: the cursor goes by time and run.
    const at = ago(30 * 60 * 1000);
    const [broken, fine] = [await endpointRun(at, 300), await endpointRun(at, 300)].sort();
    // The judgement of one of them cannot be stored.
    await q(
      `ALTER TABLE restore_point_suspicions ADD CONSTRAINT test_refuses_ck CHECK (run_id <> '${broken}') NOT VALID`,
    );
    let reads = 0;
    const counting = {
      ...deps,
      providerDb: new Proxy(deps.providerDb, {
        get(target, key, receiver) {
          if (key === "execute") {
            return (query: Parameters<typeof target.execute>[0]) => {
              reads++;
              return target.execute(query);
            };
          }
          return Reflect.get(target, key, receiver);
        },
      }),
    };
    try {
      // Without the cursor the stopped clock would read the broken run for ever.
      expect(
        await suspicionPass(counting, { batch: 1, budgetMs: 60_000, clock: stoppedClock }),
      ).toEqual({ judged: 1, suspicious: 0, alerts: 0, reminders: 0 });
    } finally {
      await q("ALTER TABLE restore_point_suspicions DROP CONSTRAINT test_refuses_ck");
    }
    expect(await judgement(broken as string)).toBeUndefined();
    expect(await judgement(fine as string)).toBeDefined();
    // The retention holds due for a reminder; machines: the broken run, the fine one, the empty
    // batch and the count of the aged-out; every other kind: an empty batch and the count.
    expect(reads).toBe(1 + 4 + 3 * 2);
    // The next pass tries it again.
    await suspicionPass(deps);
    expect(await judgement(broken as string)).toBeDefined();
  });

  it("warns when restore points leave the window unjudged", async () => {
    const lost = await endpointRun(ago(72 * HOUR + 60 * 1000), 300);
    const warnings: LogRecord[] = [];
    const logger = createLogger({ sink: (record) => warnings.push(record), level: "warn" });
    await suspicionPass({ ...deps, runtime: { ...deps.runtime, logger } });
    expect(await judgement(lost)).toBeUndefined();
    expect(warnings).toEqual([
      expect.objectContaining({
        message: "restore points left the ransomware window unjudged",
        kind: "endpoint",
        count: 1,
        windowHours: 72,
      }),
    ]);
  });

  it("reads the waiting runs of every kind through its partial index", async () => {
    for (const [kind, index] of [
      ["endpoint", "endpoint_runs_suspicion_idx"],
      ["file_share", "file_share_runs_suspicion_idx"],
      ["pve_guest", "pve_runs_suspicion_idx"],
      ["m365", "jobs_suspicion_idx"],
    ] as const) {
      for (const after of [null, { at: now.toISOString(), runId: randomUUID() }]) {
        const plan = await owner.transaction(async (tx) => {
          // The tables are tiny here: make the planner show which index it can use.
          await tx.execute(sql`SET LOCAL enable_seqscan = off`);
          const query = candidatesQuery(kind, ago(72 * HOUR), after, 200);
          return (await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${query}`)).rows
            .map((row) => row["QUERY PLAN"])
            .join("\n");
        });
        expect(plan, `${kind} ${after ? "after a batch" : "first batch"}`).toContain(index);
      }
    }
  });
});
