/**
 * The boot probe in the worker against Postgres (docs/BAREMETAL.md 12.3, 12.4, 12.6), M5:
 *
 *   - planning: a machine whose newest whole machine snapshot passed stage 1 gets one probe while a
 *     lab with KVM asks for work, none without one, a second only when it is due; a machine the
 *     probe cannot boot is recorded once (no systemd, too large);
 *   - the lab API: only with the token; a planned probe is leased once, also to two labs asking at
 *     the same time, never beyond the concurrency; the lease carries a one-time code bound to the
 *     instance (only its proof's hash is stored) and nothing that opens the repository; a result
 *     is taken once and only for a probe the lab leased, rated green, red or incomplete from the
 *     recovery's own report and the serial console, and closes a session that is still open;
 *   - the alarms: `baremetal.red` once per episode (with `job.failed` for every red report),
 *     `baremetal.recovered`, `baremetal.overdue` once; a probe that ran out of time raises nothing;
 *   - retention waits for a probe that reads the repository like for a person's recovery.
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser; the database `restow_worker_probe_test` is
 * recreated). No restic, no lab: the ISO's part of the probe is written into the recovery row as
 * the API would store it.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalLayoutJson,
  hashRecoveryCodeProof,
  layoutFingerprint,
  noopLogger,
  normalizeRecoveryCode,
  PROBE_VALID_MS,
  parseLayoutManifest,
  type RecoveryIsoSelection,
  recoveryCodeProof,
  restoreSizeTargets,
  summarizeLayout,
  type TenantKeyring,
  webhookSubscriptionUpdate,
} from "@restow/core";
import {
  auditLog,
  createDb,
  type Database,
  deriveAuthLogin,
  EndpointRecoveryActiveError,
  endpointLayouts,
  endpointRecoveries,
  endpointRecoveryLog,
  endpointReports,
  endpointRuns,
  endpoints,
  notifications,
  type RoleLogin,
  settings,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TenantCache } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import type { EndpointJobDeps } from "./common.js";

// The repository is never opened: retention is stopped before it reads anything.
vi.mock("./common.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./common.js")>();
  return {
    ...original,
    openEndpointRepository: async (
      deps: EndpointJobDeps,
      tenantId: string,
      endpointId: string,
    ) => ({
      endpoint: await original.loadEndpoint(deps, tenantId, endpointId),
      access: {} as never,
    }),
  };
});

const { alertBaremetalReports, planBootProbes } = await import("./boot-probe.js");
const { startLabApi } = await import("./lab-api.js");
const { expireRecoveries } = await import("./monitor.js");
const { endpointRetention } = await import("./retention.js");
type LabApiOptions = import("./lab-api.js").LabApiOptions;

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_probe_test";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const TOKEN = "t".repeat(40);
const ORIGIN = "https://restow.contoso.example";
const SPKI = "c".repeat(64);
const MANIFEST = fileURLToPath(
  new URL(
    "../../../../agent/internal/baremetal/testdata/manifests/debian12-uefi-luks-lvm.json",
    import.meta.url,
  ),
);

describe.skipIf(!adminUrl)("the boot probe in the worker", () => {
  let owner: Database;
  let appDb: Database;
  let providerDb: Database;
  let deps: EndpointJobDeps;
  let tenantId = "";
  let work = "";
  let server: Server;
  let base = "";
  let isoPath = "";
  let clock = new Date();
  const roleNames: string[] = [];
  const iso = { sha256: "", version: "0.5.0", fileName: "restow-recovery-0.5.0-amd64.iso" };
  const options: LabApiOptions = {
    token: TOKEN,
    concurrency: 1,
    maxRestoreBytes: 64 * GIB,
    publicUrl: ORIGIN,
    spkiSha256: SPKI,
    tlsUpstream: null,
    selectIso: async () =>
      ({
        base: { ok: true } as never,
        newest: null,
        offered: { ...iso, rebuild: null, tag: "v0.5.0", sumsName: "SHA256SUMS" },
        local: { path: isoPath, size: 9, origin: "store" },
      }) as RecoveryIsoSelection,
    measureSpki: async () => null,
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
      name: `restow_bp_app_${suffix}`,
      password: randomBytes(12).toString("hex"),
    };
    const installationLogin: RoleLogin = {
      name: `restow_bp_inst_${suffix}`,
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
    appDb = asRole(tenantLogin);
    providerDb = asRole(installationLogin);
    work = await mkdtemp(join(tmpdir(), "restow-worker-probe-"));
    isoPath = join(work, iso.fileName);
    await writeFile(isoPath, "ISO-BYTES");
    iso.sha256 = "e".repeat(64);
    const [provider] = (
      await owner.$client.query<{ id: string }>(
        "INSERT INTO providers (name) VALUES ('p') RETURNING id",
      )
    ).rows;
    const [tenant] = (
      await owner.$client.query<{ id: string }>(
        "INSERT INTO tenants (provider_id, name, slug) VALUES ($1, 'Contoso', 'contoso') RETURNING id",
        [provider?.id],
      )
    ).rows;
    tenantId = tenant?.id ?? "";
    deps = {
      db: appDb,
      providerDb,
      runtime: {
        keyrings: new TenantCache<TenantKeyring>(async () => {
          throw new Error("no keys needed");
        }),
        storage: { get: async () => ({ primary: {}, copies: [] }) } as never,
        logger: noopLogger,
        now: () => clock,
        shutdownSignal: new AbortController().signal,
      },
      maintenanceLockWaitMs: 2000,
    };
    server = await startLabApi(deps, options, { port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/lab`;
  }, 90_000);

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await Promise.all([appDb?.$client.end(), providerDb?.$client.end(), owner?.$client.end()]);
    await dropTestDatabase(adminUrl as string, TEST_DB);
    const admin = createDb(adminUrl as string);
    for (const role of roleNames) {
      await admin.$client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.$client.end();
    if (work) await rm(work, { recursive: true, force: true });
  });

  const lab = (body: unknown, path = "next", token = TOKEN) =>
    fetch(`${base}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const next = async () =>
    (await (await lab({ labVersion: "0.5.0", kvm: true })).json()) as {
      probe: Record<string, unknown> | null;
      reason?: string;
    };
  const labSeen = async (kvm = true) => {
    const recoveryLab = { seenAt: clock.toISOString(), version: "0.5.0", kvm };
    await owner
      .insert(settings)
      .values({ recoveryLab })
      .onConflictDoUpdate({ target: settings.singleton, set: { recoveryLab } });
  };
  const noLab = () =>
    owner
      .insert(settings)
      .values({ recoveryLab: null })
      .onConflictDoUpdate({ target: settings.singleton, set: { recoveryLab: null } });

  interface Machine {
    id: string;
    snapshotId: string;
    layoutFingerprint: string;
    bootChain: string;
  }

  /**
   * A machine with a whole machine snapshot whose stage 1 is green (or as `readiness` says), as the
   * worker stores them. `rootBytes` sizes `/` for the size limit; `init` changes the manifest.
   */
  async function machine(
    change: { rootBytes?: number; init?: string; readiness?: "green" | "red" } = {},
  ): Promise<Machine> {
    const id = randomUUID();
    await owner.insert(endpoints).values({
      id,
      tenantId,
      hostname: `srv-${id.slice(0, 6)}`,
      os: "linux",
      arch: "amd64",
      profile: "server",
      status: "active",
      secretHash: "h",
      agentVersion: "0.5.0",
      config: { wholeMachine: true } as never,
    });
    const raw = JSON.parse(await readFile(MANIFEST, "utf8")) as { os: { init: string } };
    if (change.init) raw.os.init = change.init;
    const parsed = parseLayoutManifest(JSON.parse(canonicalLayoutJson(raw)));
    if (!parsed.ok || parsed.manifest.platform !== "linux") throw new Error("not a Linux layout");
    const linux = parsed.manifest;
    const [layout] = await owner
      .insert(endpointLayouts)
      .values({
        tenantId,
        endpointId: id,
        sha256: parsed.sha256,
        format: linux.format,
        schemaVersion: linux.schemaVersion,
        platform: linux.platform,
        manifest: JSON.parse(parsed.canonical) as Record<string, unknown>,
        summary: summarizeLayout(linux) as unknown as Record<string, unknown>,
        verdict: linux.verdict,
        layoutFingerprint: layoutFingerprint(linux),
      })
      .returning();
    const snapshotId = randomBytes(32).toString("hex");
    const [run] = await owner
      .insert(endpointRuns)
      .values({
        tenantId,
        endpointId: id,
        kind: "backup",
        status: "succeeded",
        startedAt: clock,
        finishedAt: clock,
        snapshotId,
        layoutId: layout?.id,
      })
      .returning();
    const restoreSizes: Record<string, { bytes: number; files: number; inodes: number }> = {};
    for (const target of restoreSizeTargets(linux)) {
      restoreSizes[target] = { bytes: GIB, files: 100, inodes: 100 };
    }
    restoreSizes["/"] = { bytes: change.rootBytes ?? 4 * GIB, files: 1000, inodes: 1000 };
    const bootChain = randomBytes(32).toString("hex");
    await owner.insert(endpointReports).values({
      tenantId,
      endpointId: id,
      kind: "baremetal_check",
      origin: "server",
      snapshotId,
      runId: run?.id,
      readiness: change.readiness ?? "green",
      checkedAt: clock,
      // Announced already: these tests look at the probe's alarms.
      alertedAt: clock,
      summary: {
        layoutFingerprint: layout?.layoutFingerprint,
        bootChainFingerprint: bootChain,
        restoreSizes,
        folderSizes: {},
        checks: [],
      } as never,
    });
    return { id, snapshotId, layoutFingerprint: layout?.layoutFingerprint ?? "", bootChain };
  }

  const probesOf = (id: string) =>
    owner
      .select()
      .from(endpointRecoveries)
      .where(and(eq(endpointRecoveries.endpointId, id), eq(endpointRecoveries.kind, "probe")));
  const probeReportsOf = (id: string) =>
    owner
      .select()
      .from(endpointReports)
      .where(and(eq(endpointReports.endpointId, id), eq(endpointReports.kind, "boot_probe")));
  const eventsOf = (id: string, event: string) =>
    owner
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.event, event), sql`${notifications.details}->>'endpointId' = ${id}`),
      );

  /** The machines of earlier tests leave: their probes would be planned and leased first. */
  const clearProbes = async () => {
    await owner
      .update(endpointRecoveries)
      .set({ status: "expired" })
      .where(eq(endpointRecoveries.kind, "probe"));
    await owner.update(endpoints).set({ status: "revoked" });
  };

  /** The ISO's part of a probe, as the API stores it from the session. */
  async function recovered(
    probeId: string,
    status: "succeeded" | "failed",
    warnings: string[] = [],
  ) {
    await owner
      .update(endpointRecoveries)
      .set({
        status,
        usedAt: clock,
        finishedAt: clock,
        warnings: warnings.map((code) => ({ code, message: code })),
        verification:
          status === "succeeded"
            ? {
                format: "restow-verify-v1",
                result: "ok",
                snapshotId: "a".repeat(64),
                planSha256: "b".repeat(64),
                startedAt: clock.toISOString(),
                finishedAt: clock.toISOString(),
                restoreErrors: 0,
                checks: [{ id: "fstab", result: "ok", findings: [], evidence: {} }],
              }
            : null,
      })
      .where(eq(endpointRecoveries.id, probeId));
  }

  const result = (probeId: string, body: Record<string, unknown> = {}) =>
    lab(
      {
        outcome: "booted",
        bootSerial:
          "[  OK  ] Reached target multi-user.target\nRESTOW-PROBE-OK 0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f 6.1.0-27-amd64\n",
        kvm: true,
        firmware: "uefi-sb",
        controllers: ["sata"],
        ...body,
      },
      `probes/${probeId}/result`,
    );

  it("plans one probe for a machine with a green stage 1 while a lab with KVM asks, none without", async () => {
    clock = new Date();
    await clearProbes();
    const made = await machine();
    await noLab();
    await planBootProbes(deps, clock);
    expect(await probesOf(made.id)).toHaveLength(0);
    await labSeen(false);
    await planBootProbes(deps, clock);
    expect(await probesOf(made.id)).toHaveLength(0);

    await labSeen(true);
    const summary = await planBootProbes(deps, clock);
    expect(summary.planned).toBeGreaterThanOrEqual(1);
    const [planned] = await probesOf(made.id);
    expect(planned).toMatchObject({
      status: "issued",
      codeHash: null,
      requireApproval: false,
      snapshotId: made.snapshotId,
    });
    expect(planned?.expiresAt.getTime()).toBe(clock.getTime() + 3 * HOUR);
    const [audit] = await owner
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "endpoint.boot_probe.requested"), eq(auditLog.target, made.id)),
      );
    expect(audit?.details).toMatchObject({ recoveryId: planned?.id, due: "fingerprint_changed" });
    // Planned already: the next pass plans no second one.
    await planBootProbes(deps, clock);
    expect(await probesOf(made.id)).toHaveLength(1);
    // A machine whose stage 1 is red gets none.
    const red = await machine({ readiness: "red" });
    await planBootProbes(deps, clock);
    expect(await probesOf(red.id)).toHaveLength(0);
  });

  it("records once that a machine cannot be probed: no systemd, too large", async () => {
    clock = new Date();
    await clearProbes();
    await labSeen(true);
    const other = await machine({ init: "other" });
    const large = await machine({ rootBytes: 100 * GIB });
    await planBootProbes(deps, clock);
    await planBootProbes(deps, clock);
    for (const [made, reason] of [
      [other, "not_systemd"],
      [large, "too_large"],
    ] as const) {
      expect(await probesOf(made.id)).toHaveLength(0);
      const reports = await probeReportsOf(made.id);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ readiness: null, snapshotId: made.snapshotId });
      expect(reports[0]?.summary).toMatchObject({
        notPossible: reason,
        layoutFingerprint: made.layoutFingerprint,
        bootChainFingerprint: made.bootChain,
      });
    }
  });

  it("answers only with the token", async () => {
    const wrong = await lab({ labVersion: "0.5.0", kvm: true }, "next", "x".repeat(40));
    expect(wrong.status).toBe(401);
    const none = await fetch(`${base}/next`, { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
    const isoNone = await fetch(`${base}/iso/${iso.sha256}`);
    expect(isoNone.status).toBe(401);
    expect((await lab({ labVersion: "0.5.0", kvm: true, extra: 1 })).status).toBe(400);
  });

  it("stores the lab's state and leases nothing without KVM", async () => {
    clock = new Date();
    const response = await lab({ labVersion: "0.5.1", kvm: false });
    expect(await response.json()).toEqual({ probe: null, reason: "no_kvm" });
    const [row] = await owner.select({ lab: settings.recoveryLab }).from(settings).limit(1);
    expect(row?.lab).toEqual({ seenAt: clock.toISOString(), version: "0.5.1", kvm: false });
  });

  it("leases a planned probe once, also to two labs at the same time, with a code bound to the instance [CRYPT-006]", async () => {
    clock = new Date();
    await clearProbes();
    await labSeen(true);
    const made = await machine();
    await planBootProbes(deps, clock);
    const [first, second] = await Promise.all([next(), next()]);
    const leases = [first, second].filter((answer) => answer.probe !== null);
    expect(leases).toHaveLength(1);
    expect([first, second].map((answer) => answer.reason ?? null).sort()).toEqual(
      [null, "busy"].sort(),
    );
    const probe = leases[0]?.probe as Record<string, unknown>;
    // The lab gets the code, the ISO, the hardware and the answers; no credential of the repository.
    expect(Object.keys(probe).sort()).toEqual(
      [
        "answers",
        "hardware",
        "id",
        "iso",
        "origin",
        "passphrase",
        "restoreBytes",
        "snapshotId",
        "spkiCheck",
        "timeouts",
      ].sort(),
    );
    expect(probe.iso).toEqual({ ...iso, size: 9 });
    expect(probe.origin).toBe(ORIGIN);
    expect(JSON.stringify(probe)).not.toMatch(/repositoryPassword|restUsername|restPassword|rset_/);
    const answers = probe.answers as Record<string, unknown>;
    expect(answers).toMatchObject({
      format: "restow-answers-v1",
      instanceUrl: ORIGIN,
      snapshotId: made.snapshotId,
      afterSuccess: "poweroff",
      network: { mode: "dhcp", proxy: "http://10.0.2.100:3128" },
      passphrase: probe.passphrase,
    });
    expect(answers.diskMapping).toEqual({ d0: "serial.RESTOWPROBE0" });
    expect((probe.hardware as { disks: { controller: string }[] }).disks[0]?.controller).toBe(
      "sata",
    );
    // Only the hash of the code's proof is stored, bound to the origin, with the check value.
    const [row] = await probesOf(made.id);
    const code = normalizeRecoveryCode(String(answers.code)) as string;
    expect(row?.codeHash).toBe(hashRecoveryCodeProof(recoveryCodeProof(ORIGIN, code)));
    expect(row).toMatchObject({ instanceOrigin: ORIGIN, spkiSha256: SPKI, status: "issued" });
    expect(JSON.stringify(row)).not.toContain(code);
    // Leased: while it runs, no lab gets another one (one probe at a time).
    expect(await next()).toEqual({ probe: null, reason: "busy" });

    // The ISO of the lease, nothing else.
    const download = await fetch(`${base}/iso/${iso.sha256}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("ISO-BYTES");
    const other = await fetch(`${base}/iso/${"f".repeat(64)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(other.status).toBe(404);
  });

  it("leases two probes to two labs with a concurrency of two, never the same", async () => {
    clock = new Date();
    await clearProbes();
    await labSeen(true);
    const a = await machine();
    const b = await machine();
    await planBootProbes(deps, clock);
    options.concurrency = 2;
    try {
      const answers = await Promise.all([next(), next(), next()]);
      const ids = answers.map((answer) => answer.probe?.id).filter(Boolean);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      const leased = [...(await probesOf(a.id)), ...(await probesOf(b.id))];
      expect(leased.map((row) => row.id).sort()).toEqual([...ids].sort());
    } finally {
      options.concurrency = 1;
    }
  });

  it("rates a probe from the recovery and the console once, and only one the lab leased [VERIFY-009]", async () => {
    clock = new Date();
    await clearProbes();
    await labSeen(true);
    const made = await machine();
    await planBootProbes(deps, clock);
    const [planned] = await probesOf(made.id);
    // Planned, not leased: no lab can report on it.
    expect((await result(planned?.id ?? "")).status).toBe(404);
    expect((await result(randomUUID())).status).toBe(404);
    expect((await result("not-a-uuid")).status).toBe(404);
    const leased = await next();
    expect(leased.probe?.id).toBe(planned?.id);
    const id = planned?.id as string;

    const go = await lab({ phase: "restore" }, `probes/${id}/event`);
    expect(await go.json()).toEqual({ go: true });
    await recovered(id, "succeeded");
    const stored = await result(id);
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ readiness: "green" });
    const [report] = await probeReportsOf(made.id);
    expect(report).toMatchObject({ readiness: "green", snapshotId: made.snapshotId });
    expect(report?.summary).toMatchObject({
      probeId: id,
      layoutFingerprint: made.layoutFingerprint,
      bootChainFingerprint: made.bootChain,
      cause: { kind: "booted", kernel: "6.1.0-27-amd64" },
      firmware: "uefi-sb",
      controllers: ["sata"],
      kvm: true,
      emptyFilesystems: ["/home"],
    });
    expect(String((report?.summary as { serialTail?: string } | undefined)?.serialTail)).toContain(
      "RESTOW-PROBE-OK",
    );
    const logs = await owner
      .select()
      .from(endpointRecoveryLog)
      .where(eq(endpointRecoveryLog.recoveryId, id));
    expect(logs.map((row) => row.lines).join("\n")).toContain("[probe boot] RESTOW-PROBE-OK");
    // Once.
    expect((await result(id)).status).toBe(409);
    expect(await probeReportsOf(made.id)).toHaveLength(1);
  });

  it("rates red only with evidence, incomplete otherwise, and closes a session that is still open", async () => {
    for (const [setup, body, readiness, cause, status] of [
      [
        (id: string) => recovered(id, "succeeded"),
        { outcome: "boot_timeout", bootSerial: "You are in emergency mode. After logging in...\n" },
        "red",
        "boot_failed",
        "succeeded",
      ],
      [
        (id: string) => recovered(id, "failed", ["storage_driver_missing"]),
        { outcome: "restore_stopped", bootSerial: "" },
        "red",
        "recovery_failed",
        "failed",
      ],
      [
        (id: string) => recovered(id, "succeeded"),
        { outcome: "boot_timeout", bootSerial: "[  OK  ] Started a service\n" },
        "yellow",
        "incomplete",
        "succeeded",
      ],
      [
        async () => {},
        { outcome: "lab_error", bootSerial: "", error: { code: "qemu_failed", message: "x" } },
        "yellow",
        "incomplete",
        "failed",
      ],
    ] as const) {
      clock = new Date(clock.getTime() + MINUTE);
      await clearProbes();
      await labSeen(true);
      const made = await machine();
      await planBootProbes(deps, clock);
      const leased = await next();
      const id = String(leased.probe?.id);
      await setup(id);
      const response = await result(id, body as Record<string, unknown>);
      expect(response.status).toBe(200);
      const [report] = await probeReportsOf(made.id);
      expect(report?.readiness).toBe(readiness);
      expect((report?.summary as { cause?: { kind: string } } | undefined)?.cause?.kind).toBe(
        cause,
      );
      const [row] = await probesOf(made.id);
      // The recovery's own end stays; a code nobody redeemed is dead once the lab gave up.
      expect(row?.status).toBe(status);
    }
  });

  it("announces red once per episode with job.failed for each, recovered after it, and overdue once [ALERT-012]", async () => {
    clock = new Date();
    await clearProbes();
    const made = await machine();
    const [hook] = await owner
      .insert(webhooks)
      .values({
        tenantId,
        url: "https://rmm.example/hook",
        events: webhookSubscriptionUpdate([], ["job.failed"]),
      })
      .returning();
    try {
      const report = async (readiness: "red" | "green" | "yellow", ago: number, extra = {}) => {
        const [row] = await owner
          .insert(endpointReports)
          .values({
            tenantId,
            endpointId: made.id,
            kind: "boot_probe",
            origin: "server",
            snapshotId: made.snapshotId,
            readiness,
            checkedAt: new Date(clock.getTime() - ago),
            summary: {
              layoutFingerprint: made.layoutFingerprint,
              bootChainFingerprint: made.bootChain,
              cause: {
                kind: "boot_failed",
                pattern: "emergency_mode",
                line: "You are in emergency mode.",
              },
              ...extra,
            } as never,
          })
          .returning();
        return row?.id as string;
      };
      const red1 = await report("red", 3 * HOUR);
      const red2 = await report("red", 2 * HOUR);
      await report("yellow", 90 * MINUTE);
      await alertBaremetalReports(deps, clock);
      expect(await eventsOf(made.id, "baremetal.red")).toHaveLength(1);
      const [red] = await eventsOf(made.id, "baremetal.red");
      expect(red?.details).toMatchObject({ reportId: red1, kind: "boot_probe" });
      expect(red?.message).toContain("emergency mode");
      const sent = await owner
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.webhookId, hook?.id ?? ""));
      const jobs = sent
        .map(
          (d) =>
            (
              d.payload as {
                data: {
                  job: { id: string; queue: string; failure: { code: string } };
                  endpoint: { id: string };
                };
              }
            ).data,
        )
        .filter((data) => data.endpoint.id === made.id)
        .map((data) => data.job);
      expect(jobs.map((job) => job.id).sort()).toEqual([red1, red2].sort());
      expect(jobs[0]).toMatchObject({
        queue: "endpoint_boot_probe",
        failure: { code: "endpoint.boot_probe_failed" },
      });

      await report("green", HOUR);
      await alertBaremetalReports(deps, clock);
      expect(await eventsOf(made.id, "baremetal.recovered")).toHaveLength(1);
      // A second pass announces nothing again.
      await alertBaremetalReports(deps, clock);
      expect(await eventsOf(made.id, "baremetal.red")).toHaveLength(1);
      expect(await eventsOf(made.id, "baremetal.recovered")).toHaveLength(1);
      await report("red", 30 * MINUTE);
      await alertBaremetalReports(deps, clock);
      expect(await eventsOf(made.id, "baremetal.red")).toHaveLength(2);

      // Overdue: the green probe a machine is green with is older than 8 days, told once.
      const stale = await machine();
      const [green] = await owner
        .insert(endpointReports)
        .values({
          tenantId,
          endpointId: stale.id,
          kind: "boot_probe",
          origin: "server",
          snapshotId: stale.snapshotId,
          readiness: "green",
          checkedAt: new Date(clock.getTime() - PROBE_VALID_MS - DAY),
          alertedAt: clock,
          summary: {
            layoutFingerprint: stale.layoutFingerprint,
            bootChainFingerprint: stale.bootChain,
          } as never,
        })
        .returning();
      await noLab();
      await planBootProbes(deps, clock);
      await planBootProbes(deps, clock);
      const overdue = await eventsOf(stale.id, "baremetal.overdue");
      expect(overdue).toHaveLength(1);
      expect(overdue[0]?.details).toMatchObject({ reportId: green?.id });
    } finally {
      await owner.delete(webhooks).where(eq(webhooks.id, hook?.id ?? ""));
    }
  });

  it("lets a probe run out of time without an alarm, and keeps retention away while it reads [RETAIN-016]", async () => {
    clock = new Date();
    await clearProbes();
    const made = await machine();
    const [silent] = await owner
      .insert(endpointRecoveries)
      .values({
        tenantId,
        endpointId: made.id,
        kind: "probe",
        status: "active",
        codeHash: randomBytes(32).toString("hex"),
        requireApproval: false,
        issuedAt: new Date(clock.getTime() - 4 * HOUR),
        expiresAt: new Date(clock.getTime() - 31 * MINUTE),
        usedAt: new Date(clock.getTime() - 3 * HOUR),
      })
      .returning();
    await expireRecoveries(deps, clock);
    const [row] = await owner
      .select()
      .from(endpointRecoveries)
      .where(eq(endpointRecoveries.id, silent?.id ?? ""));
    expect(row?.status).toBe("failed");
    expect(await eventsOf(made.id, "endpoint.recovery.failed")).toHaveLength(0);

    await owner.insert(endpointRecoveries).values({
      tenantId,
      endpointId: made.id,
      kind: "probe",
      status: "active",
      codeHash: randomBytes(32).toString("hex"),
      requireApproval: false,
      issuedAt: clock,
      expiresAt: new Date(clock.getTime() + HOUR),
      usedAt: clock,
    });
    await expect(endpointRetention(deps, { tenantId, endpointId: made.id })).rejects.toBeInstanceOf(
      EndpointRecoveryActiveError,
    );
  });
});
