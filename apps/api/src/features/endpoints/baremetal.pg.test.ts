/**
 * Postgres-backed test of bare metal M1 on the server (docs/BAREMETAL.md 4.3, 14.2, 14.3): the
 * layout manifest an agent sends with the finish of a whole machine backup is checked, stored once
 * per machine and content and linked from the run; a refused one leaves the run as reported with
 * the hint `layout_rejected`; the machine's card reads the newest layout; tenants never see each
 * other's layouts. The manifests are the agent's own test data
 * (agent/internal/baremetal/testdata/manifests).
 *
 * M2: a whole machine finish queues the stage 1 check (one job per machine), the card reads the
 * newest check report of the newest layout's snapshot and rates the machine with it, and the
 * machine's detail does not list those reports among its others.
 *
 * It does not need restic: the machines are inserted, not enrolled. Runs when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENDPOINT_QUEUES, generateAgentSecret, MAX_LAYOUT_BYTES } from "@restow/core";
import {
  type EndpointConfig,
  endpointLayouts,
  endpointRecoveries,
  endpointReports,
  endpointRuns,
  endpoints,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import PgBoss from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  basic,
  type EndpointFixture,
  startFixture,
  testDatabaseAdminUrl,
} from "./testing/fixture.js";

const DATABASE = "restow_api_baremetal_test";

const MANIFESTS = fileURLToPath(
  new URL("../../../../../agent/internal/baremetal/testdata/manifests/", import.meta.url),
);
const manifestText = (name: string) => readFileSync(`${MANIFESTS}${name}.json`, "utf8");
const manifest = (name: string) => JSON.parse(manifestText(name)) as Record<string, unknown>;
const sha256Of = (name: string) => readFileSync(`${MANIFESTS}${name}.sha256`, "utf8").trim();
const fingerprintOf = (name: string) =>
  readFileSync(`${MANIFESTS}${name}.fingerprint`, "utf8").trim();

const DEBIAN = "example-debian12-uefi-luks-lvm";

const CONFIG: EndpointConfig = {
  profile: "server",
  schedule: { kind: "daily", timeOfDay: "02:00", timeZone: "Europe/Berlin" },
  paths: ["/etc"],
  excludes: [],
  hooks: {},
  bandwidthKbps: null,
  onlyOnAcPower: false,
  useVss: false,
};

describe.skipIf(!testDatabaseAdminUrl)("layouts of whole machine backups", () => {
  let fixture: EndpointFixture;
  let app: Hono;
  let baremetal: typeof import("./baremetal.js");
  let shared: typeof import("../../db.js");
  let tenantContext: typeof import("../../lib/tenant-context.js");
  let ipCounter = 10;

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    // pg-boss owns its schema as the installation role; the API only enqueues into it.
    const boss = new PgBoss({ connectionString: fixture.roles.providerUrl });
    await boss.start();
    await fixture.roles.grantQueue();
    await boss.createQueue(ENDPOINT_QUEUES.baremetalCheck, {
      name: ENDPOINT_QUEUES.baremetalCheck,
      policy: "stately",
    });
    await boss.stop({ graceful: false, wait: true });
    const { agentRoutes } = await import("./agent-routes.js");
    const { errorHandler } = await import("../../problem.js");
    baremetal = await import("./baremetal.js");
    shared = await import("../../db.js");
    tenantContext = await import("../../lib/tenant-context.js");
    app = new Hono();
    app.onError(errorHandler);
    app.route("/agent/v1", agentRoutes);
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function machine(
    values: {
      tenantId?: string;
      os?: "linux" | "windows";
      arch?: "amd64" | "arm64";
      config?: Partial<EndpointConfig>;
    } = {},
  ) {
    const secret = generateAgentSecret();
    const id = randomUUID();
    const tenantId = values.tenantId ?? fixture.tenantId;
    await fixture.db.insert(endpoints).values({
      id,
      tenantId,
      hostname: `host-${id.slice(0, 8)}`,
      os: values.os ?? "linux",
      arch: values.arch ?? "amd64",
      profile: "server",
      secretHash: secret.hash,
      agentVersion: "0.5.0",
      config: { ...CONFIG, ...values.config },
      configVersion: 2,
    });
    return { id, secret: secret.value, tenantId };
  }

  async function agentPost(who: { id: string; secret: string }, path: string, body: unknown) {
    return app.request(`/agent/v1${path}`, {
      method: "POST",
      headers: {
        ...basic(who.id, who.secret),
        "content-type": "application/json",
        "x-forwarded-for": `203.0.113.${ipCounter++ % 250}`,
      },
      body: JSON.stringify(body),
    });
  }

  /** A backup run finished with `extra` (a layout, a status); answers the stored run. */
  async function backup(who: { id: string; secret: string }, extra: Record<string, unknown>) {
    const start = await agentPost(who, "/runs", {
      kind: "backup",
      startedAt: new Date().toISOString(),
    });
    expect(start.status, await start.clone().text()).toBe(201);
    const { runId } = (await start.json()) as { runId: string };
    const finish = await agentPost(who, `/runs/${runId}/finish`, {
      status: "succeeded",
      finishedAt: new Date().toISOString(),
      snapshotId: randomUUID().replace(/-/g, "").repeat(2),
      stats: { filesNew: 1, dataAdded: 1, totalFilesProcessed: 1, totalBytesProcessed: 1 },
      errors: [],
      logTail: "",
      ...extra,
    });
    expect(finish.status, await finish.clone().text()).toBe(200);
    const [run] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
    if (!run) throw new Error("run not stored");
    return run;
  }

  const layoutsOf = (endpointId: string) =>
    fixture.db.select().from(endpointLayouts).where(eq(endpointLayouts.endpointId, endpointId));

  it("stores a valid layout once per content and links every run to it", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const first = await backup(who, { layout: manifest(DEBIAN) });
    expect(first.status).toBe("succeeded");
    expect(first.errors).toEqual([]);
    expect(first.layoutId).not.toBeNull();
    const [stored] = await layoutsOf(who.id);
    expect(stored).toMatchObject({
      id: first.layoutId,
      sha256: sha256Of(DEBIAN),
      layoutFingerprint: fingerprintOf(DEBIAN),
      format: "restow-layout-v1",
      schemaVersion: 1,
      platform: "linux",
      verdict: "supported",
      tenantId: fixture.tenantId,
    });
    expect(stored?.summary).toMatchObject({ platform: "linux", firmware: { mode: "uefi" } });

    // The same content again: one row, both runs point at it.
    const second = await backup(who, { layout: manifest(DEBIAN) });
    expect(second.layoutId).toBe(first.layoutId);
    expect(await layoutsOf(who.id)).toHaveLength(1);
    // Another content is another row.
    const third = await backup(who, { layout: manifest("example-bios-mdadm-btrfs") });
    expect(third.layoutId).not.toBe(first.layoutId);
    expect(await layoutsOf(who.id)).toHaveLength(2);
  });

  it("refuses an invalid layout with a hint and keeps the run as reported", async () => {
    const who = await machine();
    const cases: [string, unknown][] = [
      ["missing field", (({ disks: _d, ...rest }) => rest)(manifest(DEBIAN))],
      ["control character", { ...manifest(DEBIAN), hostname: "srv\u0001" }],
      ["too large", { ...manifest(DEBIAN), padding: "x".repeat(MAX_LAYOUT_BYTES) }],
      ["macOS", manifest("darwin-minimal")],
      ["cycle", manifest("invalid-blockref-cycle")],
    ];
    for (const [label, layout] of cases) {
      const run = await backup(who, { layout, status: "succeeded" });
      expect(run.status, label).toBe("succeeded");
      expect(run.layoutId, label).toBeNull();
      expect(run.failure, label).toBeNull();
      expect(
        run.errors.map((error) => error.code),
        label,
      ).toEqual(["layout_rejected"]);
    }
    // A partial run keeps its own explanation; the hint never replaces it.
    const partial = await backup(who, {
      status: "partial",
      layout: { broken: true },
      errors: [{ code: "snapshot_failed", path: "/home", message: "lvcreate failed" }],
    });
    expect(partial.status).toBe("partial");
    expect(partial.errors.map((error) => error.code)).toEqual([
      "snapshot_failed",
      "layout_rejected",
    ]);
    expect(partial.failure?.code).toBe("endpoint.snapshot_failed");
    expect(await layoutsOf(who.id)).toHaveLength(0);
  });

  it("keeps no layout of a failed run or of a run without a snapshot", async () => {
    const who = await machine();
    const failed = await backup(who, {
      status: "failed",
      snapshotId: undefined,
      layout: manifest(DEBIAN),
      errors: [{ code: "restic_exit_1", message: "repository unreachable" }],
    });
    expect(failed.layoutId).toBeNull();
    expect(await layoutsOf(who.id)).toHaveLength(0);
  });

  it("shows the newest layout on the card, and nothing to another tenant", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const before = await baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id);
    expect(before).toMatchObject({ enabled: true, state: "no_layout", latest: null });
    const run = await backup(who, { layout: manifest(DEBIAN) });
    const card = await baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id);
    expect(card).toMatchObject({
      enabled: true,
      state: "unverified",
      notPossible: null,
      latest: {
        layoutId: run.layoutId,
        runId: run.id,
        snapshotId: run.snapshotId,
        sha256: sha256Of(DEBIAN),
        fingerprint: fingerprintOf(DEBIAN),
        verdict: "supported",
        unsupported: [],
      },
      snapshotHint: null,
    });
    const layout = await baremetal.getLayout(
      shared.db,
      fixture.tenantId,
      who.id,
      run.layoutId as string,
    );
    expect(layout.sha256).toBe(sha256Of(DEBIAN));
    expect(layout.manifest).toMatchObject({ hostname: manifest(DEBIAN).hostname });

    await expect(
      baremetal.getBaremetalState(shared.db, fixture.otherTenantId, who.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      baremetal.getLayout(shared.db, fixture.otherTenantId, who.id, run.layoutId as string),
    ).rejects.toMatchObject({ status: 404 });
    const seen = await tenantContext.withTenantTx(shared.db, fixture.otherTenantId, (tx) =>
      tx.select().from(endpointLayouts),
    );
    expect(seen).toEqual([]);
  });

  it("says why a machine cannot be backed up as a whole", async () => {
    const windows = await machine({ os: "windows" });
    expect(
      await baremetal.getBaremetalState(shared.db, fixture.tenantId, windows.id),
    ).toMatchObject({ state: "not_possible", notPossible: "windows" });
    const plain = await machine();
    expect(await baremetal.getBaremetalState(shared.db, fixture.tenantId, plain.id)).toMatchObject({
      enabled: false,
      state: "not_enabled",
    });
    const old = await machine({ config: { wholeMachine: true } });
    await fixture.db
      .update(endpoints)
      .set({ agentVersion: "0.4.12" })
      .where(eq(endpoints.id, old.id));
    expect(await baremetal.getBaremetalState(shared.db, fixture.tenantId, old.id)).toMatchObject({
      state: "not_possible",
      notPossible: "agent_too_old",
    });
  });

  it("explains a volume group without room for snapshots", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const layout = manifest(DEBIAN) as {
      backup: { fsSnapshots: Record<string, string>; liveReasons: Record<string, string> };
    };
    layout.backup.fsSnapshots["/"] = "live";
    layout.backup.fsSnapshots["/home"] = "live";
    layout.backup.liveReasons["/"] = "vg_no_space";
    layout.backup.liveReasons["/home"] = "vg_no_space";
    await backup(who, { layout });
    const card = await baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id);
    expect(card.snapshotHint).toEqual({
      vg: "vg0",
      sizeBytes: 510526783488,
      freeBytes: 48318382080,
      suggestedFreeBytes: Math.ceil(510526783488 / 10),
      mounts: ["/", "/home"],
    });
  });

  it("finds the key files of a snapshot's layout and of the machine's newest", async () => {
    const who = await machine();
    const layout = manifest(DEBIAN) as { luks: { keyFile: string | null }[] };
    const first = layout.luks[0];
    if (!first) throw new Error("no LUKS volume in the example");
    first.keyFile = "/etc/luks-keys/root.key";
    const run = await backup(who, { layout });
    const files = await baremetal.loadKeyFiles(
      shared.db,
      fixture.tenantId,
      who.id,
      run.snapshotId as string,
    );
    expect(files).toEqual(["/etc/luks-keys/root.key"]);
    // An older snapshot without a layout still has the newest layout's key files locked.
    expect(
      await baremetal.loadKeyFiles(shared.db, fixture.tenantId, who.id, "f".repeat(64)),
    ).toEqual(["/etc/luks-keys/root.key"]);
    expect(
      await baremetal.loadKeyFiles(
        shared.db,
        fixture.tenantId,
        (await machine()).id,
        "f".repeat(64),
      ),
    ).toEqual([]);
  });
  it("lets an admin set the file system snapshot of a Linux machine, and of no other", async () => {
    const service = await import("./service.js");
    const actor = { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" };
    const linux = await machine();
    const set = await service.updateEndpoint(
      shared.db,
      fixture.tenantId,
      linux.id,
      { config: { fsSnapshot: "auto" } },
      actor,
    );
    expect(set.changed).toEqual(["config.fsSnapshot"]);
    const [stored] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, linux.id));
    expect(stored?.config.fsSnapshot).toBe("auto");
    expect(stored?.configVersion).toBe(3);
    const detail = await service.getEndpoint(
      shared.db,
      fixture.tenantId,
      linux.id,
      "https://restow.test.example",
    );
    expect(detail.config).toMatchObject({ fsSnapshot: "auto", wholeMachine: false });
    // null returns to the default: the key goes.
    await service.updateEndpoint(
      shared.db,
      fixture.tenantId,
      linux.id,
      { config: { fsSnapshot: null } },
      actor,
    );
    const [reset] = await fixture.db.select().from(endpoints).where(eq(endpoints.id, linux.id));
    expect(reset?.config).not.toHaveProperty("fsSnapshot");
    expect(
      (
        await service.getEndpoint(
          shared.db,
          fixture.tenantId,
          linux.id,
          "https://restow.test.example",
        )
      ).config.fsSnapshot,
    ).toBeNull();

    const windows = await machine({ os: "windows" });
    await expect(
      service.updateEndpoint(
        shared.db,
        fixture.tenantId,
        windows.id,
        { config: { fsSnapshot: "auto" } },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 422,
      extensions: { errors: [{ path: "config.fsSnapshot", code: "linux_only" }] },
    });
  });
  /** A stage 1 report of the worker for a run's snapshot. */
  async function checkReport(
    who: { id: string },
    run: { id: string; snapshotId: string | null },
    readiness: "green" | "red" | "yellow",
    summary: Record<string, unknown> = {},
  ) {
    const [row] = await fixture.db
      .insert(endpointReports)
      .values({
        tenantId: fixture.tenantId,
        endpointId: who.id,
        kind: "baremetal_check",
        origin: "server",
        snapshotId: run.snapshotId,
        runId: run.id,
        readiness,
        summary: {
          checks: [{ id: "L1", status: "ok", findings: [], evidence: {} }],
          restoreSizes: { "/": { bytes: 9, files: 1, inodes: 2 } },
          minimumSizes: { disks: [], filesystems: [] },
          planner: { same: { ok: true, problems: [], warnings: [] } },
          bootChainFingerprint: "c".repeat(64),
          incomplete: null,
          ...summary,
        },
      })
      .returning();
    return row;
  }

  const jobsOf = (endpointId: string) =>
    fixture.db.execute<{ data: Record<string, unknown>; singleton_key: string }>(
      sql`SELECT data, singleton_key FROM pgboss.job
           WHERE name = ${ENDPOINT_QUEUES.baremetalCheck} AND data->>'endpointId' = ${endpointId}`,
    );

  it("queues the layout check once when a whole machine backup finishes", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const run = await backup(who, { layout: manifest(DEBIAN) });
    const { rows } = await jobsOf(who.id);
    expect(rows).toEqual([
      {
        data: { tenantId: fixture.tenantId, endpointId: who.id, runId: run.id },
        singleton_key: `${ENDPOINT_QUEUES.baremetalCheck}:${who.id}`,
      },
    ]);
    // A second backup while the first check still waits: no second job (one per machine).
    await backup(who, { layout: manifest(DEBIAN) });
    expect((await jobsOf(who.id)).rows).toHaveLength(1);
    // A backup without a layout queues nothing.
    const plain = await machine();
    await backup(plain, {});
    expect((await jobsOf(plain.id)).rows).toHaveLength(0);
  });

  it("rates the machine with the check of the newest layout's snapshot", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const run = await backup(who, { layout: manifest(DEBIAN) });
    const card = () => baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id);
    expect(await card()).toMatchObject({ state: "unverified", stateDetail: null, check: null });

    const green = await checkReport(who, run, "green");
    expect(await card()).toMatchObject({
      state: "layout_checked",
      stateDetail: null,
      check: {
        reportId: green?.id,
        snapshotId: run.snapshotId,
        readiness: "green",
        incomplete: null,
        checks: [{ id: "L1", status: "ok" }],
        restoreSizes: { "/": { bytes: 9, files: 1, inodes: 2 } },
        bootChainFingerprint: "c".repeat(64),
      },
    });

    // A newer check of the same snapshot replaces it.
    await checkReport(who, run, "red", {
      checks: [
        { id: "L6", status: "failed", findings: [{ code: "kernel_missing" }], evidence: {} },
      ],
    });
    expect(await card()).toMatchObject({ state: "red", check: { readiness: "red" } });
    await checkReport(who, run, "yellow", { incomplete: "planner_timeout" });
    expect(await card()).toMatchObject({
      state: "unverified",
      stateDetail: "incomplete",
      check: { readiness: "yellow", incomplete: "planner_timeout" },
    });

    // A newer backup without a check: the old report rates nothing any more.
    await backup(who, { layout: manifest("example-bios-mdadm-btrfs") });
    expect(await card()).toMatchObject({ state: "unverified", stateDetail: null, check: null });
  });

  it("lists the snapshots for the wizard with the hardware per layout and the running session", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const first = await backup(who, { layout: manifest(DEBIAN) });
    await checkReport(who, first, "green", {
      minimumSizes: { disks: [{ disk: "d0", minBytes: 123456789 }], filesystems: [] },
      planner: {
        same: { ok: true, problems: [], warnings: [] },
        otherController: {
          ok: true,
          problems: [],
          warnings: [],
          storage: [{ module: "ahci", found: true, builtin: false }],
        },
      },
    });
    const second = await backup(who, { layout: manifest("example-bios-mdadm-btrfs") });
    const card = await baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id);
    expect(card.snapshots).toEqual([
      expect.objectContaining({
        snapshotId: second.snapshotId,
        layoutId: second.layoutId,
        sameLayoutAsNewest: true,
        check: "none",
      }),
      expect.objectContaining({
        snapshotId: first.snapshotId,
        layoutId: first.layoutId,
        sameLayoutAsNewest: false,
        check: "passed",
        verdict: "supported",
      }),
    ]);
    // The guide of the newest layout, and one per listed layout.
    expect(card.hardware).toMatchObject({ firmwareMode: "bios", biosNeedsCsm: true });
    expect(Object.keys(card.hardwareByLayout).sort()).toEqual(
      [first.layoutId, second.layoutId].sort(),
    );
    expect(card.hardwareByLayout[first.layoutId as string]).toMatchObject({
      firmwareMode: "uefi",
      secureBoot: true,
      requiredCAs: [expect.stringContaining("Microsoft Corporation UEFI CA 2011")],
      disks: [expect.objectContaining({ id: "d0", minBytes: 123456789 })],
      keymap: { layout: "de", variant: "nodeadkeys", inInitramfs: true },
      storageDriversOtherController: [{ module: "ahci", ok: true }],
    });
    expect(card.activeRecovery).toBeNull();

    // A running session shows on the card (and in the list, recovery.pg.test.ts).
    const [session] = await fixture.db
      .insert(endpointRecoveries)
      .values({
        tenantId: fixture.tenantId,
        endpointId: who.id,
        kind: "code",
        status: "active",
        codeHash: randomUUID().replace(/-/g, "").repeat(2),
        requireApproval: true,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        progress: { phase: "restoring" } as never,
        updatedAt: new Date(),
      })
      .returning();
    expect(
      (await baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id)).activeRecovery,
    ).toEqual({ id: session?.id, status: "active", phase: "restoring" });
    await fixture.db
      .update(endpointRecoveries)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(endpointRecoveries.id, session?.id as string));
    expect(
      (await baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id)).activeRecovery,
    ).toBeNull();
  });

  it("is not possible for an unsupported layout, also with a red check, and for arm64", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const layout = manifest(DEBIAN) as Record<string, unknown>;
    layout.verdict = "unsupported";
    layout.unsupported = [
      { code: "fs_type_unsupported", ref: "f2", message: "zfs", severity: "unsupported" },
    ];
    const run = await backup(who, { layout });
    await checkReport(who, run, "red");
    expect(await baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id)).toMatchObject({
      state: "not_possible",
      notPossible: "unsupported",
      check: { readiness: "red" },
    });
    const arm = await machine({ arch: "arm64", config: { wholeMachine: true } });
    expect(await baremetal.getBaremetalState(shared.db, fixture.tenantId, arm.id)).toMatchObject({
      state: "not_possible",
      notPossible: "arm64_later",
    });
  });

  it("keeps the layout checks out of the machine's report list", async () => {
    const service = await import("./service.js");
    const who = await machine({ config: { wholeMachine: true } });
    const run = await backup(who, { layout: manifest(DEBIAN) });
    await checkReport(who, run, "green");
    await fixture.db.insert(endpointReports).values({
      tenantId: fixture.tenantId,
      endpointId: who.id,
      kind: "retention",
      origin: "server",
      summary: { removedSnapshots: 0 },
    });
    const detail = await service.getEndpoint(
      shared.db,
      fixture.tenantId,
      who.id,
      "https://restow.test.example",
    );
    expect(detail.reports.map((report) => report.kind)).toEqual(["retention"]);
  });

  /** A boot probe report of the worker (docs/BAREMETAL.md 12.3). */
  async function probeReport(
    who: { id: string },
    readiness: "green" | "red" | "yellow" | null,
    summary: Record<string, unknown>,
    checkedAt = new Date(),
  ) {
    const [row] = await fixture.db
      .insert(endpointReports)
      .values({
        tenantId: fixture.tenantId,
        endpointId: who.id,
        kind: "boot_probe",
        origin: "server",
        readiness,
        checkedAt,
        summary: summary as never,
      })
      .returning();
    return row;
  }

  const LAB = (now: Date, kvm = true) => ({
    seenAt: new Date(now.getTime() - 60_000).toISOString(),
    version: "0.5.0",
    kvm,
  });

  it("is green only with a passed boot probe of the same fingerprints, at most 8 days old [READY-014] [READY-015]", async () => {
    const who = await machine({ config: { wholeMachine: true } });
    const run = await backup(who, { layout: manifest(DEBIAN) });
    await checkReport(who, run, "green");
    const now = new Date();
    const card = (at = now, lab: ReturnType<typeof LAB> | null = LAB(now)) =>
      baremetal.getBaremetalState(shared.db, fixture.tenantId, who.id, at, lab);
    const fingerprints = {
      layoutFingerprint: fingerprintOf(DEBIAN),
      bootChainFingerprint: "c".repeat(64),
    };
    // Stage 1 alone is "layout checked", and the card says why no probe proved the boot.
    expect(await card(now, null)).toMatchObject({
      state: "layout_checked",
      probe: { reason: "no_lab", lab: { present: false, kvm: false }, latest: null },
    });
    expect(await card(now, LAB(now, false))).toMatchObject({
      state: "layout_checked",
      probe: { reason: "no_kvm" },
    });
    expect(await card()).toMatchObject({ state: "layout_checked", probe: { reason: "planned" } });

    const green = await probeReport(
      who,
      "green",
      {
        ...fingerprints,
        cause: { kind: "booted", line: "RESTOW-PROBE-OK x 6.1.0-27-amd64" },
        firmware: "uefi-sb",
        controllers: ["sata"],
        kvm: true,
        emptyFilesystems: ["/home"],
        emptyDirs: [],
        restoreBytes: 9,
        serialTail: "RESTOW-PROBE-OK x 6.1.0-27-amd64",
      },
      new Date(now.getTime() - 60_000),
    );
    expect(await card()).toMatchObject({
      state: "green",
      probe: {
        reason: null,
        latest: {
          reportId: green?.id,
          readiness: "green",
          firmware: "uefi-sb",
          controllers: ["sata"],
          emptyFilesystems: ["/home"],
          serialTail: "RESTOW-PROBE-OK x 6.1.0-27-amd64",
        },
      },
    });
    // Green also without the lab, for 8 days; then overdue.
    expect((await card(now, null)).state).toBe("green");
    // The readiness overview's "Bare Metal" column rates the same; a machine not backed up as a
    // whole has none.
    const plain = await machine();
    const { loadEndpointOverview } = await import("./overview.js");
    const overview = await tenantContext.withTenantTx(shared.db, fixture.tenantId, (tx) =>
      loadEndpointOverview(tx, fixture.tenantId, now),
    );
    const rowOf = (id: string) => overview.rows.find((row) => row.id === id);
    expect(rowOf(who.id)?.baremetal).toBe("green");
    if (rowOf(plain.id)) expect(rowOf(plain.id)?.baremetal).toBeNull();
    expect((await card(new Date(now.getTime() + 8 * 24 * 3600_000 + 120_000), null)).state).toBe(
      "overdue",
    );
    // A changed boot chain is another system: the probe of the old one proves nothing for it.
    await checkReport(who, run, "green", { bootChainFingerprint: "d".repeat(64) });
    expect(await card()).toMatchObject({ state: "layout_checked", probe: { reason: "planned" } });
    // A probe that proved nothing (yellow) leaves it there; a red one with evidence makes it red.
    await probeReport(who, "yellow", { ...fingerprints, bootChainFingerprint: "d".repeat(64) });
    expect(await card()).toMatchObject({
      state: "layout_checked",
      probe: { reason: "incomplete" },
    });
    await probeReport(who, "red", {
      ...fingerprints,
      bootChainFingerprint: "d".repeat(64),
      cause: { kind: "boot_failed", pattern: "emergency_mode", line: "You are in emergency mode." },
    });
    expect(await card()).toMatchObject({ state: "red", probe: { latest: { readiness: "red" } } });
    // Neither kind of report is listed among the machine's others.
    const service = await import("./service.js");
    const detail = await service.getEndpoint(
      shared.db,
      fixture.tenantId,
      who.id,
      "https://restow.test.example",
    );
    expect(detail.reports.map((report) => report.kind)).toEqual([]);
  });

  it("plans a probe on request once, only with a green stage 1 and a lab with KVM", async () => {
    const { config } = await import("../../config.js");
    const { requestBootProbe } = baremetal;
    const actor = { label: "admin@contoso.example", userId: fixture.adminId, ip: "192.0.2.1" };
    const now = new Date();
    const who = await machine({ config: { wholeMachine: true } });
    const run = await backup(who, { layout: manifest(DEBIAN) });
    const reasonOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        return (error as { status: number; extensions?: { reason?: string } }).extensions?.reason;
      }
      return "planned";
    };
    const previewBefore = config.baremetalPreview;
    config.baremetalPreview = true;
    try {
      const ask = (lab: ReturnType<typeof LAB> | null) =>
        requestBootProbe(shared.db, fixture.tenantId, who.id, actor, now, lab);
      expect(await reasonOf(ask(null))).toBe("no_lab");
      expect(await reasonOf(ask(LAB(now, false)))).toBe("no_kvm");
      expect(await reasonOf(ask(LAB(now)))).toBe("not_checked");
      await checkReport(who, run, "green");
      const first = await ask(LAB(now));
      expect(first.state).toBe("planned");
      // Asked twice, or while it runs: the open probe answers.
      expect(await ask(LAB(now))).toEqual(first);
      const rows = await fixture.db
        .select()
        .from(endpointRecoveries)
        .where(eq(endpointRecoveries.endpointId, who.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "probe",
        status: "issued",
        codeHash: null,
        requireApproval: false,
        snapshotId: run.snapshotId,
        createdBy: fixture.adminId,
      });
      const audits = await fixture.db.execute<{ action: string }>(
        sql`SELECT action FROM audit_log WHERE details->>'recoveryId' = ${first.id}`,
      );
      expect(audits.rows.map((row) => row.action)).toEqual(["endpoint.boot_probe.requested"]);
      const card = await baremetal.getBaremetalState(
        shared.db,
        fixture.tenantId,
        who.id,
        now,
        LAB(now),
      );
      expect(card).toMatchObject({ state: "layout_checked", probe: { pending: "planned" } });
      // A probe is no recovery of the machine: neither listed nor its running session.
      const codes = await import("./recovery-codes.js");
      expect((await codes.listRecoveries(shared.db, fixture.tenantId, who.id)).items).toEqual([]);
      expect(card.activeRecovery).toBeNull();
      config.baremetalPreview = false;
      expect(await reasonOf(ask(LAB(now)))).toBe("preview_off");
    } finally {
      config.baremetalPreview = previewBefore;
    }
  });
});
