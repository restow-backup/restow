import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Restic,
  ResticFailure,
  backupArgs,
  escapeIncludePath,
  excludeFileLine,
  formatResticTime,
  nodeOf,
  parseJsonLine,
  resticEnv,
  summaryOf,
} from "./restic.js";

const OPTIONS = {
  bin: "restic",
  repository: "rest:http://127.0.0.1:1/agent/restic/x/",
  password: "repo-password",
  restUser: "endpoint-id",
  restPass: "agent-secret",
  cacheDir: "/tmp/cache",
  tmpDir: "/tmp/tmp",
};

describe("restic command lines and environment", () => {
  it("formats --time in UTC, the zone the process runs in", () => {
    expect(formatResticTime(new Date("2026-09-01T20:07:11.999Z"))).toBe("2026-09-01 20:07:11");
  });

  it("builds the agent's backup command plus --time, with no secret on it", () => {
    const args = backupArgs({
      filesFrom: "/tmp/p.raw",
      excludeFile: "/tmp/e.txt",
      host: "fileserver-01",
      tags: ["restow-agent"],
      time: new Date("2026-09-01T20:07:11Z"),
    });
    expect(args).toEqual([
      "backup",
      "--json",
      "--files-from-raw",
      "/tmp/p.raw",
      "--exclude-caches",
      "--retry-lock",
      "15m",
      "--host",
      "fileserver-01",
      "--tag",
      "restow-agent",
      "--time",
      "2026-09-01 20:07:11",
      "--exclude-file",
      "/tmp/e.txt",
    ]);
    expect(args.join(" ")).not.toContain("secret");
  });

  it("hands the credentials over in the environment and nothing else of the seed's", () => {
    const env = resticEnv(OPTIONS, {
      PATH: "/usr/bin",
      DATABASE_PROVIDER_URL: "postgres://secret",
      RESTOW_MASTER_KEY: "key",
    });
    expect(env.RESTIC_REPOSITORY).toBe(OPTIONS.repository);
    expect(env.RESTIC_PASSWORD).toBe("repo-password");
    expect(env.RESTIC_REST_USERNAME).toBe("endpoint-id");
    expect(env.RESTIC_REST_PASSWORD).toBe("agent-secret");
    expect(env.TZ).toBe("UTC");
    expect(Object.keys(env)).not.toContain("DATABASE_PROVIDER_URL");
    expect(Object.keys(env)).not.toContain("RESTOW_MASTER_KEY");
  });

  it("writes exclude patterns the way restic reads an exclude file", () => {
    expect(excludeFileLine("  **/node_modules ")).toBe("**/node_modules");
    expect(excludeFileLine("/home/$USER/tmp")).toBe("/home/$$USER/tmp");
    expect(excludeFileLine("")).toBeNull();
    expect(excludeFileLine("# a comment")).toBeNull();
    expect(excludeFileLine("two\nlines")).toBeNull();
  });

  it("escapes the characters of restic's glob matcher in an include path", () => {
    expect(escapeIncludePath("/srv/share/plain.txt")).toBe("/srv/share/plain.txt");
    expect(escapeIncludePath("/srv/share/a[1]*?.txt")).toBe("/srv/share/a\\[1]\\*\\?.txt");
  });

  it("reads restic's JSON lines and ignores everything else", () => {
    expect(parseJsonLine('{"message_type":"status"}')).toEqual({ message_type: "status" });
    expect(parseJsonLine("Fatal: wrong password")).toBeNull();
    expect(parseJsonLine("{broken")).toBeNull();
    expect(parseJsonLine("[1]")).toBeNull();
    expect(
      summaryOf({
        message_type: "summary",
        files_new: 3,
        files_changed: 1,
        files_unmodified: 40,
        data_added: 1234,
        total_files_processed: 44,
        total_bytes_processed: 99_000,
        snapshot_id: "abcd1234",
      }),
    ).toEqual({
      filesNew: 3,
      filesChanged: 1,
      filesUnmodified: 40,
      dataAdded: 1234,
      totalFilesProcessed: 44,
      totalBytesProcessed: 99_000,
      snapshotId: "abcd1234",
    });
    expect(nodeOf({ message_type: "snapshot" })).toBeNull();
    expect(
      nodeOf({
        message_type: "node",
        name: "a.txt",
        type: "file",
        path: "/srv/a.txt",
        size: 5,
        mtime: "2026-09-01T10:00:00Z",
      }),
    ).toEqual({
      name: "a.txt",
      type: "file",
      path: "/srv/a.txt",
      size: 5,
      mtime: new Date("2026-09-01T10:00:00Z"),
    });
  });
});

// A real restic against a repository in a folder: the same program the seed image carries.
const BINARY = [
  process.env.RESTIC_BINARY,
  new URL("../../../../agent/dist/darwin-arm64/restic", import.meta.url).pathname,
  new URL("../../../../agent/dist/linux-amd64/restic", import.meta.url).pathname,
  new URL("../../../../agent/dist/linux-arm64/restic", import.meta.url).pathname,
].find((path): path is string => {
  if (!path || !existsSync(path)) return false;
  try {
    execFileSync(path, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});

describe.skipIf(!BINARY)("Restic against a real restic binary", { timeout: 60_000 }, () => {
  // One repository for the whole block: creating one costs restic a few seconds of key derivation.
  let base = "";
  let repo = "";
  let restic: Restic;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "restow-restic-"));
    repo = join(base, "repo");
    restic = new Restic({
      bin: BINARY as string,
      repository: repo,
      password: "test-password",
      restUser: "",
      restPass: "",
      cacheDir: join(base, "cache"),
      tmpDir: join(base, "tmp"),
    });
    execFileSync(BINARY as string, ["init", "--repo", repo], {
      env: {
        PATH: process.env.PATH ?? "",
        RESTIC_PASSWORD: "test-password",
        RESTIC_CACHE_DIR: join(base, "cache"),
        TZ: "UTC",
      },
      stdio: "ignore",
    });
  }, 60_000);

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** A fresh folder with a few files in it. */
  function sampleData(name: string): string {
    const data = join(base, name);
    mkdirSync(join(data, "docs"), { recursive: true });
    writeFileSync(join(data, "docs", "a.txt"), "alpha");
    writeFileSync(join(data, "docs", "b[1].txt"), "bravo");
    writeFileSync(join(data, "skip.tmp"), "temporary");
    const mtime = new Date("2026-08-01T10:00:00Z");
    utimesSync(join(data, "docs", "a.txt"), mtime, mtime);
    return data;
  }

  it("reports its version and checks access", async () => {
    expect(await restic.version()).toMatch(/^0\.\d+\.\d+/);
    await restic.checkAccess();
  });

  it("fails clearly with a wrong password", async () => {
    const wrong = new Restic({
      bin: BINARY as string,
      repository: repo,
      password: "wrong",
      restUser: "",
      restPass: "",
      cacheDir: join(base, "cache2"),
      tmpDir: join(base, "tmp2"),
    });
    await expect(wrong.checkAccess()).rejects.toBeInstanceOf(ResticFailure);
  });

  it("backs up with --time and --host, lists the snapshot and restores chosen files", async () => {
    const data = sampleData("data");
    const at = new Date("2026-09-01T20:07:11Z");
    const result = await restic.backup({
      paths: [data],
      excludes: ["*.tmp"],
      host: "fileserver-01",
      tags: ["restow-agent"],
      time: at,
    });
    expect(result.snapshotId).toMatch(/^[0-9a-f]{8,64}$/);
    expect(result.partial).toBe(false);
    expect(result.summary.filesNew).toBe(2);

    const snapshots = JSON.parse(
      execFileSync(BINARY as string, ["snapshots", "--json", "--repo", repo], {
        env: {
          PATH: process.env.PATH ?? "",
          RESTIC_PASSWORD: "test-password",
          RESTIC_CACHE_DIR: join(base, "cache"),
          TZ: "UTC",
        },
      }).toString(),
    ) as Array<{ id: string; time: string; hostname: string; tags: string[] }>;
    const made = snapshots.find((snapshot) => snapshot.id === result.snapshotId);
    expect(made?.hostname).toBe("fileserver-01");
    expect(made?.tags).toEqual(["restow-agent"]);
    expect(new Date(made?.time as string).toISOString().slice(0, 19)).toBe("2026-09-01T20:07:11");

    const nodes = await restic.ls(result.snapshotId);
    const files = nodes.filter((node) => node.type === "file");
    expect(files.map((node) => node.path).sort()).toEqual([
      join(data, "docs", "a.txt"),
      join(data, "docs", "b[1].txt"),
    ]);
    expect(files.find((node) => node.name === "a.txt")?.mtime?.toISOString()).toBe(
      "2026-08-01T10:00:00.000Z",
    );

    const target = join(base, "restored");
    await restic.restore({
      snapshotId: result.snapshotId,
      target,
      includes: [join(data, "docs", "b[1].txt")],
    });
    expect(statSync(join(target, data, "docs", "b[1].txt")).size).toBe(5);
    expect(existsSync(join(target, data, "docs", "a.txt"))).toBe(false);
  });

  it("makes a second snapshot that sees what changed", async () => {
    const data = sampleData("data-two");
    const first = await restic.backup({
      paths: [data],
      excludes: [],
      host: "h",
      tags: [],
      time: new Date("2026-09-01T20:00:00Z"),
    });
    writeFileSync(join(data, "docs", "new.txt"), "new file");
    writeFileSync(join(data, "docs", "a.txt"), "alpha changed");
    const second = await restic.backup({
      paths: [data],
      excludes: [],
      host: "h",
      tags: [],
      time: new Date("2026-09-02T20:00:00Z"),
    });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.summary.filesNew).toBe(1);
    expect(second.summary.filesChanged).toBe(1);
  });
});
