/**
 * Postgres-backed test of bare metal M1 on the server (docs/BAREMETAL.md 4.3, 14.2, 14.3): the
 * layout manifest an agent sends with the finish of a whole machine backup is checked, stored once
 * per machine and content and linked from the run; a refused one leaves the run as reported with
 * the hint `layout_rejected`; the machine's card reads the newest layout; tenants never see each
 * other's layouts. The manifests are the agent's own test data
 * (agent/internal/baremetal/testdata/manifests).
 *
 * It does not need restic: the machines are inserted, not enrolled. Runs when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateAgentSecret, MAX_LAYOUT_BYTES } from "@restow/core";
import { type EndpointConfig, endpointLayouts, endpointRuns, endpoints } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
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
    values: { tenantId?: string; os?: "linux" | "windows"; config?: Partial<EndpointConfig> } = {},
  ) {
    const secret = generateAgentSecret();
    const id = randomUUID();
    const tenantId = values.tenantId ?? fixture.tenantId;
    await fixture.db.insert(endpoints).values({
      id,
      tenantId,
      hostname: `host-${id.slice(0, 8)}`,
      os: values.os ?? "linux",
      arch: "amd64",
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
});
