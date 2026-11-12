/**
 * Stage 1 of the bare metal check (docs/BAREMETAL.md 12.1, 21.2) against Postgres, a real restic
 * repository and the real planner binary: a whole machine snapshot of the debian12 test machine
 * (agent/internal/baremetal/testdata/capture/debian12-uefi-luks-lvm/root, with the agent's copy
 * of its layout, the default kernel's module list and the tools stage 1 looks for) is rated green,
 * and each kind of damage the checks exist for makes it red with its proof.
 *
 * The section's "against rest-server" is the repository's own loopback restic route here, the one
 * every worker job uses (@restow/core `withRepository` over `LocalStorageBackend`). restic cannot
 * rewrite paths, so the test backs up the fake root with `cd root && restic backup .`: the tree
 * holds `/etc`, `/boot`, ... at the top as on the machine, the snapshot's paths name the test
 * folder (L5 warns `paths_differ`, as it would for a snapshot that does not list every source).
 *
 * Needs RESTOW_TEST_DATABASE_URL (a superuser), restic (RESTIC_BINARY, else the PATH) and the
 * planner (RESTOW_PLANNER_BIN: `cd agent && go build -o <dir>/restow-agent ./cmd/restow-agent`).
 * Inside the database gate a missing planner fails the suite: it is never skipped (CI downloads
 * the `agent-linux-amd64` artifact for it).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  baremetalReadiness,
  canonicalLayoutJson,
  defaultEndpointConfig,
  EnvKeyProvider,
  endpointPrefix,
  generateDek,
  hashSecret,
  LINUX_MANIFEST_PATH,
  LocalStorageBackend,
  layoutFingerprint,
  layoutSha256,
  noopLogger,
  openRepository,
  parseLayoutManifest,
  type ResticSession,
  resticBinary,
  resticInit,
  type StorageTargets,
  sealSecret,
  summarizeLayout,
  type TenantKeyring,
} from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  createDb,
  type Database,
  deriveAuthLogin,
  EndpointRepositoryBusyError,
  endpointLayouts,
  endpointReports,
  endpointRuns,
  endpoints,
  type RoleLogin,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTenantKeyring, TenantCache } from "../handlers/framework.js";
import { dropTestDatabase } from "../testing/database.js";
import { BaremetalCheckIncompleteError, endpointBaremetalCheck } from "./baremetal-check.js";
import type { EndpointJobDeps } from "./common.js";

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_baremetal_test";
const TESTDATA = fileURLToPath(
  new URL("../../../../agent/internal/baremetal/testdata/", import.meta.url),
);
const FIXTURE_ROOT = join(TESTDATA, "capture/debian12-uefi-luks-lvm/root");

/** The file that keeps an otherwise empty folder of a fixture tree in git (baremetal.FixtureKeep). */
const FIXTURE_KEEP = ".restow-keep";

/**
 * Copies a capture fixture tree as the machine it records. The tree is stored so that it checks
 * out on every system (agent/internal/baremetal/host.go, `DirHost`): a name with a character
 * Windows refuses is written as %XX (`pci0000%3A00`), and an empty folder holds `.restow-keep`.
 * Neither is a file of the machine: the copy has the machine's names and the empty folders,
 * never the placeholder, so the snapshot holds what the machine would.
 */
async function copyFixtureTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === FIXTURE_KEEP) continue;
    const name = entry.name.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (entry.isDirectory()) {
      await copyFixtureTree(join(from, entry.name), join(to, name));
    } else {
      await cp(join(from, entry.name), join(to, name));
    }
  }
}

/** Every path below `root`, relative to it. */
async function treeOf(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map(String);
}

function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 && /^restic 0\.\d+/.test(result.stdout);
}

/** The debian12 layout as its agent writes it for a whole machine backup. */
async function debianLayout(): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(
    await readFile(join(TESTDATA, "manifests/debian12-uefi-luks-lvm.json"), "utf8"),
  ) as { backup: { sources: string[] } };
  manifest.backup.sources = ["/", "/boot", "/boot/efi", "/home"];
  return JSON.parse(canonicalLayoutJson(manifest));
}

const MODULES_ALIAS = [
  "# Aliases extracted from modules themselves.",
  "alias pci:v*d*sv*sd*bc01sc08i02* nvme",
  "alias pci:v*d*sv*sd*bc01sc06i01* ahci",
  "alias virtio:d00000002v* virtio_blk",
  "alias pci:v00008086d00001533sv*sd*bc*sc*i* igb",
  "",
].join("\n");

/** Run restic in `cwd` against an open session (the loopback listener answers in this process). */
function resticIn(session: ResticSession, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(session.binary ?? resticBinary(), args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        RESTIC_REPOSITORY: session.repositoryUrl,
        RESTIC_PASSWORD: session.repositoryPassword,
        RESTIC_REST_USERNAME: session.username,
        RESTIC_REST_PASSWORD: session.password,
        RESTIC_CACHE_DIR: session.cacheDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`restic ${args[0]} failed: ${stderr}`)),
    );
  });
}

describe.skipIf(!adminUrl || !resticAvailable())(
  "bare metal stage 1 against Postgres, restic and the planner",
  () => {
    const plannerBin = process.env.RESTOW_PLANNER_BIN?.trim() ?? "";
    let owner: Database;
    let appDb: Database;
    let providerDb: Database;
    let deps: EndpointJobDeps;
    let work: string;
    let storageDir: string;
    let tenantId: string;
    let dek: ReturnType<typeof generateDek>;
    const roleNames: string[] = [];

    beforeAll(async () => {
      const admin = createDb(adminUrl as string);
      await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
      await admin.$client.end();
      const url = new URL(adminUrl as string);
      url.pathname = `/${TEST_DB}`;
      const suffix = randomBytes(4).toString("hex");
      const tenantLogin: RoleLogin = {
        name: `restow_bm_app_${suffix}`,
        password: randomBytes(12).toString("hex"),
      };
      const installationLogin: RoleLogin = {
        name: `restow_bm_inst_${suffix}`,
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
      work = await mkdtemp(join(tmpdir(), "restow-worker-baremetal-"));
      storageDir = join(work, "storage");

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
      const kek = randomBytes(32);
      const provideKeys = new EnvKeyProvider(kek);
      dek = generateDek(1);
      await owner.$client.query(
        "INSERT INTO tenant_keys (tenant_id, key_version, encrypted_dek, kek_id) VALUES ($1, 1, $2, 'env:RESTOW_MASTER_KEY')",
        [tenantId, (await provideKeys.wrapDek(dek)).toString("base64")],
      );
      const keyrings = new TenantCache<TenantKeyring>((id) =>
        loadTenantKeyring({ db: appDb, tenantId: id, keyProvider: provideKeys }),
      );
      const storage = new TenantCache<StorageTargets>(async () => ({
        primary: new LocalStorageBackend(storageDir),
        copies: [],
      }));
      deps = {
        db: appDb,
        providerDb,
        runtime: {
          keyrings,
          storage,
          logger: noopLogger,
          now: () => new Date(),
          shutdownSignal: new AbortController().signal,
        },
      };
    }, 90_000);

    afterAll(async () => {
      await Promise.all([appDb?.$client.end(), providerDb?.$client.end(), owner?.$client.end()]);
      await dropTestDatabase(adminUrl as string, TEST_DB);
      const admin = createDb(adminUrl as string);
      for (const role of roleNames) {
        await admin.$client.query(`DROP ROLE IF EXISTS ${role}`);
      }
      await admin.$client.end();
      if (work) await rm(work, { recursive: true, force: true });
    });

    interface Machine {
      id: string;
      runId: string;
      snapshotId: string;
      layoutSha256: string;
      password: string;
      /** The machine's root as it was backed up. */
      root: string;
    }

    /**
     * A machine with a repository holding one whole machine snapshot of the debian12 root, its
     * layout and the run that recorded it, as `finishRun` stores them. `change` edits the root
     * before the backup.
     */
    async function machine(
      change: (root: string) => Promise<void> = async () => {},
    ): Promise<Machine> {
      const id = randomUUID();
      const password = randomBytes(24).toString("base64url");
      const secretId = randomUUID();
      await owner.$client.query(
        "INSERT INTO secrets (id, tenant_id, kind, ciphertext, key_version) VALUES ($1, $2, 'endpoint_repository', $3, 1)",
        [secretId, tenantId, sealSecret(dek, secretId, password)],
      );
      await owner.insert(endpoints).values({
        id,
        tenantId,
        hostname: `srv-${id.slice(0, 4)}`,
        os: "linux",
        arch: "amd64",
        profile: "server",
        status: "active",
        secretHash: hashSecret("rsea_x"),
        repositorySecretId: secretId,
        agentVersion: "0.5.0",
        config: {
          ...defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
          wholeMachine: true,
        },
        lastSeenAt: new Date(),
      });

      const layout = await debianLayout();
      const root = join(work, `root-${id}`);
      await copyFixtureTree(FIXTURE_ROOT, root);
      await mkdir(join(root, "lib/modules/6.1.0-27-amd64"), { recursive: true });
      await writeFile(join(root, "lib/modules/6.1.0-27-amd64/modules.alias"), MODULES_ALIAS);
      await writeFile(
        join(root, "lib/modules/6.1.0-27-amd64/modules.builtin"),
        "kernel/drivers/ata/libata.ko\n",
      );
      await mkdir(join(root, "usr/sbin"), { recursive: true });
      for (const tool of ["update-initramfs", "grub-install"]) {
        await writeFile(join(root, "usr/sbin", tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      }
      await mkdir(join(root, "home/alice"), { recursive: true });
      await writeFile(join(root, "home/alice/notes.txt"), "hello\n");
      await mkdir(join(root, "var/lib/restow-agent/baremetal"), { recursive: true });
      await writeFile(join(root, LINUX_MANIFEST_PATH.slice(1)), canonicalLayoutJson(layout));
      await change(root);

      const open = await openRepository({
        storage: new LocalStorageBackend(storageDir),
        prefix: endpointPrefix(id),
        repositoryPassword: password,
        repositoryKey: id,
        cacheBase: join(work, "cache"),
      });
      let snapshotId: string;
      try {
        await resticInit(open.session);
        const output = await resticIn(open.session, root, ["backup", "--json", "."]);
        const summary = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { message_type?: string; snapshot_id?: string })
          .find((line) => line.message_type === "summary");
        snapshotId = summary?.snapshot_id ?? "";
      } finally {
        await open.close();
      }
      expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);

      const parsed = parseLayoutManifest(layout);
      if (!parsed.ok || parsed.manifest.platform !== "linux") throw new Error("not a Linux layout");
      const linux = parsed.manifest;
      const [stored] = await owner
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
      const [run] = await owner
        .insert(endpointRuns)
        .values({
          tenantId,
          endpointId: id,
          kind: "backup",
          status: "succeeded",
          startedAt: new Date(),
          finishedAt: new Date(),
          snapshotId,
          layoutId: stored?.id,
          stats: {
            filesNew: 1,
            dataAdded: 1,
            totalFilesProcessed: 1,
            totalBytesProcessed: 1,
            consistency: { method: "lvm", state: "used" },
          },
        })
        .returning();
      await owner
        .update(endpoints)
        .set({ lastSnapshotId: snapshotId, lastSuccessAt: new Date() })
        .where(eq(endpoints.id, id));
      return {
        id,
        runId: run?.id ?? "",
        snapshotId,
        layoutSha256: layoutSha256(layout),
        password,
        root,
      };
    }

    const reportsOf = (id: string) =>
      owner
        .select()
        .from(endpointReports)
        .where(
          and(eq(endpointReports.endpointId, id), eq(endpointReports.kind, "baremetal_check")),
        );

    type Summary = {
      checks: { id: string; status: string; findings: { code: string; severity: string }[] }[];
      planner: Record<string, { ok: boolean | null; problems?: unknown[] }>;
      restoreSizes: Record<string, { bytes: number; files: number; inodes: number }>;
      folderSizes: Record<string, number>;
      minimumSizes: { disks: { disk: string; minBytes: number }[] } | null;
      bootChainFingerprint: string | null;
      layoutSha256: string;
      plannerVersion: string | null;
      incomplete: string | null;
    };
    const statusOf = (summary: Summary, id: string) =>
      summary.checks.find((check) => check.id === id)?.status;
    const codesOf = (summary: Summary, id: string) =>
      summary.checks
        .find((check) => check.id === id)
        ?.findings.map((f) => `${f.severity}:${f.code}`) ?? [];

    async function check(made: Machine, extra: Partial<{ force: boolean }> = {}) {
      await endpointBaremetalCheck(
        deps,
        { tenantId, endpointId: made.id, runId: made.runId, ...extra },
        { plannerBin },
      );
    }

    it("has the planner binary (RESTOW_PLANNER_BIN) and never skips without it", () => {
      expect(plannerBin, "set RESTOW_PLANNER_BIN to a built restow-agent").not.toBe("");
      expect(existsSync(plannerBin)).toBe(true);
    });

    it("rates a complete whole machine snapshot green, which the card shows as layout checked", async () => {
      const made = await machine();
      await check(made);
      const [report] = await reportsOf(made.id);
      const summary = report?.summary as unknown as Summary;
      expect(
        summary.checks
          .filter((c) => c.status === "failed")
          .map((c) => ({ id: c.id, findings: c.findings })),
      ).toEqual([]);
      expect(report).toMatchObject({
        readiness: "green",
        origin: "server",
        snapshotId: made.snapshotId,
        runId: made.runId,
      });
      expect(summary.incomplete).toBeNull();
      expect(summary.layoutSha256).toBe(made.layoutSha256);
      expect(summary.bootChainFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(summary.plannerVersion).not.toBeNull();
      // The planner ran against all three targets; the same and the minimal hardware plan cleanly.
      expect(summary.planner.same?.ok).toBe(true);
      expect(summary.planner.minimal?.ok).toBe(true);
      expect(summary.planner.otherController?.ok).not.toBeNull();
      expect(statusOf(summary, "L4")).toBe("ok");
      // restic cannot rewrite the test folder's path: L5 warns about the snapshot's paths only.
      expect(codesOf(summary, "L5")).toEqual(["warning:paths_differ"]);
      expect(statusOf(summary, "L6")).toBe("ok");
      // The restore sizes count what the snapshot holds per mount target.
      expect(summary.restoreSizes["/boot"]?.bytes).toBeGreaterThanOrEqual(5616 + 384);
      // Only alice's notes: the placeholder that keeps the fixture's empty /home in git is no
      // file of the machine and never reaches the snapshot.
      expect(summary.restoreSizes["/home"]).toMatchObject({ bytes: 6, files: 1 });
      // The same walk sizes the folders a boot probe may leave empty (12.3): each child of /home,
      // /srv and /var/lib with every byte below it.
      expect(summary.folderSizes["/home/alice"]).toBe(6);
      expect(summary.folderSizes["/var/lib/restow-agent"]).toBeGreaterThan(1000);
      expect(
        Object.keys(summary.folderSizes).every((p) => /^\/(home|srv|var\/lib)\/[^/]+$/.test(p)),
      ).toBe(true);
      const tree = await treeOf(made.root);
      expect(tree.filter((path) => path.endsWith(FIXTURE_KEEP) || path.includes("%"))).toEqual([]);
      expect(tree).toContain(join("sys/devices/pci0000:00/0000:00:1d.0", "modalias"));
      expect(summary.restoreSizes["/boot/efi"]?.files).toBeGreaterThanOrEqual(5);
      expect(summary.minimumSizes?.disks.map((disk) => disk.disk)).toEqual(["d0"]);
      expect(
        baremetalReadiness({
          enabled: true,
          os: "linux",
          arch: "amd64",
          virtualization: null,
          agentTooOld: false,
          latestLayout: { verdict: "supported" },
          latestReport: { readiness: report?.readiness ?? null },
        }).state,
      ).toBe("layout_checked");

      // Checked once per snapshot: a second job writes nothing, a forced one a second report.
      await check(made);
      expect(await reportsOf(made.id)).toHaveLength(1);
      await check(made, { force: true });
      expect(await reportsOf(made.id)).toHaveLength(2);
    }, 240_000);

    it("is red when the snapshot's layout differs from the stored one (L4)", async () => {
      const made = await machine(async (root) => {
        await writeFile(join(root, LINUX_MANIFEST_PATH.slice(1)), '{"other":true}');
      });
      await check(made);
      const [report] = await reportsOf(made.id);
      const summary = report?.summary as unknown as Summary;
      expect(report?.readiness).toBe("red");
      expect(codesOf(summary, "L4")).toEqual(["failed:manifest_mismatch"]);
    }, 240_000);

    it("is red when the boot partition is not in the snapshot (L6: no kernel, no loader)", async () => {
      const made = await machine(async (root) => {
        await rm(join(root, "boot"), { recursive: true, force: true });
      });
      await check(made);
      const [report] = await reportsOf(made.id);
      const summary = report?.summary as unknown as Summary;
      expect(report?.readiness).toBe("red");
      expect(codesOf(summary, "L6")).toEqual(
        expect.arrayContaining(["failed:kernel_missing", "failed:loader_missing"]),
      );
      expect(codesOf(summary, "L5")).toEqual(expect.arrayContaining(["failed:source_missing"]));
    }, 240_000);

    it("is red when a source is missing (L5)", async () => {
      const made = await machine(async (root) => {
        await rm(join(root, "home"), { recursive: true, force: true });
      });
      await check(made);
      const [report] = await reportsOf(made.id);
      const summary = report?.summary as unknown as Summary;
      expect(report?.readiness).toBe("red");
      expect(codesOf(summary, "L5")).toContain("failed:source_missing");
      expect(statusOf(summary, "L6")).toBe("ok");
    }, 240_000);

    it("ends the check of a snapshot retention forgot with a report without a rating", async () => {
      const made = await machine();
      // The newest run with a layout names a snapshot the repository no longer has.
      const goneId = "0123abcd".repeat(8);
      await owner
        .update(endpointRuns)
        .set({ snapshotId: goneId })
        .where(eq(endpointRuns.id, made.runId));
      await check(made);
      const reports = await reportsOf(made.id);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ readiness: null, snapshotId: goneId, runId: made.runId });
      expect(reports[0]?.summary).toMatchObject({ skipped: "snapshot_gone" });
      // Terminal: the next job finds the report and does nothing.
      await check(made);
      expect(await reportsOf(made.id)).toHaveLength(1);
    }, 240_000);

    it("retries instead of rating while the repository is busy or restic cannot read it", async () => {
      const made = await machine();
      const release = await acquireEndpointRepositoryLock(owner.$client, made.id, {
        mode: "exclusive",
      });
      try {
        await expect(
          endpointBaremetalCheck(
            { ...deps, maintenanceLockWaitMs: 300 },
            { tenantId, endpointId: made.id },
            { plannerBin },
          ),
        ).rejects.toBeInstanceOf(EndpointRepositoryBusyError);
      } finally {
        await release();
      }
      expect(await reportsOf(made.id)).toEqual([]);

      // A restic that fails the walk for a reason that proves nothing (the repository unreachable).
      const real = resticBinary();
      const fake = join(work, `restic-ls-${randomUUID()}.sh`);
      await writeFile(
        fake,
        `#!/bin/sh\nif [ "$1" = ls ]; then echo "Fatal: unable to open repository: connection refused" >&2; exit 1; fi\nexec ${JSON.stringify(real)} "$@"\n`,
        { mode: 0o755 },
      );
      const previous = process.env.RESTIC_BINARY;
      process.env.RESTIC_BINARY = fake;
      try {
        await expect(check(made)).rejects.toBeInstanceOf(BaremetalCheckIncompleteError);
      } finally {
        if (previous === undefined) delete process.env.RESTIC_BINARY;
        else process.env.RESTIC_BINARY = previous;
      }
      expect(await reportsOf(made.id)).toEqual([]);
    }, 240_000);
  },
);
