import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareDirectoryEntries,
  normaliseSnapshotPath,
  ResticError,
  type ResticNode,
  type ResticSession,
  resticBinary,
  resticCheck,
  resticDump,
  resticErrorDetail,
  resticForget,
  resticInit,
  resticListDirectory,
  resticPrune,
  resticSnapshots,
  resticStat,
  resticStatMany,
  runRestic,
} from "./restic-cli.js";
import { restoreTestSamples } from "./restore-test.js";
import { resolveSelection, SelectionError } from "./zip.js";

/**
 * Browsing a snapshot: the listing order, paging through a folder and looking
 * up many paths with one restic run. The pure parts run everywhere; the rest
 * runs the real restic binary (RESTIC_BINARY, else the PATH) against a plain
 * repository in a temporary folder, the same `restic ls` the server runs
 * against the maintenance listener.
 */

const node = (name: string, type: ResticNode["type"]) => ({ name, type });

describe("the order of a folder listing", () => {
  it("lists folders first, then names the way a file manager does", () => {
    const names = [
      node("b.txt", "file"),
      node("Zeta", "dir"),
      node("B2.txt", "file"),
      node("file10", "file"),
      node("alpha", "dir"),
      node("file2", "file"),
      node("a.txt", "file"),
      node("link", "symlink"),
    ];
    expect(names.sort(compareDirectoryEntries).map((entry) => entry.name)).toEqual([
      "alpha",
      "Zeta",
      "a.txt",
      "b.txt",
      "B2.txt",
      "file2",
      "file10",
      "link",
    ]);
  });

  it("is a strict total order: only identical names compare equal", () => {
    // Canonically equal Unicode must not tie, or a cursor could skip an entry.
    const composed = node("é.txt", "file");
    const decomposed = node("é.txt", "file");
    expect(compareDirectoryEntries(composed, decomposed)).not.toBe(0);
    expect(compareDirectoryEntries(composed, composed)).toBe(0);
    expect(compareDirectoryEntries(node("a", "dir"), node("a", "file"))).toBeLessThan(0);
    // Names a collator treats as equal still have a fixed order.
    for (const [first, second] of [
      ["a.txt", "A.txt"],
      ["file7", "file007"],
      ["resume", "r\u00e9sum\u00e9"],
    ] as const) {
      const order = compareDirectoryEntries(node(first, "file"), node(second, "file"));
      expect(order).not.toBe(0);
      expect(compareDirectoryEntries(node(second, "file"), node(first, "file"))).toBe(-order);
    }
  });
});

function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 && /^restic 0\.\d+/.test(result.stdout);
}

describe.skipIf(!resticAvailable())("browsing a snapshot with restic", () => {
  let work: string;
  let source: string;
  let session: ResticSession;
  let snapshotId: string;
  const FILES = 25;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restic-cli-"));
    source = join(work, "source");
    const big = join(source, "big");
    await mkdir(big, { recursive: true });
    await mkdir(join(source, "docs", "deep"), { recursive: true });
    await writeFile(join(source, "docs", "a.txt"), "a");
    await writeFile(join(source, "docs", "deep", "inner.txt"), "inner");
    for (let index = 0; index < FILES; index++) {
      await writeFile(join(big, `file-${String(index).padStart(2, "0")}.txt`), `content ${index}`);
    }
    for (const folder of ["Zeta", "alpha", "Mid", "beta"]) {
      await mkdir(join(big, folder));
    }
    await symlink("file-00.txt", join(big, "link"));
    session = {
      repositoryUrl: join(work, "repo"),
      username: "",
      password: "",
      repositoryPassword: "repository-password-for-tests",
      cacheDir: join(work, "cache"),
    };
    await resticInit(session);
    await runRestic(session, ["backup", "--host", "test-host", source]);
    snapshotId = (await resticSnapshots(session))[0]?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const folderOf = (name: string) => `${normaliseSnapshotPath(source)}/${name}`;

  it("pages through a folder without a gap or an overlap, folders first", async () => {
    const big = folderOf("big");
    const full = await resticListDirectory(session, snapshotId, big, { limit: 1000 });
    expect(full.hasMore).toBe(false);
    expect(full.entries.map((entry) => entry.name)).toEqual([
      "alpha",
      "beta",
      "Mid",
      "Zeta",
      ...Array.from({ length: FILES }, (_, index) => `file-${String(index).padStart(2, "0")}.txt`),
      "link",
    ]);

    const seen: string[] = [];
    let after: { folder: boolean; name: string } | null = null;
    let pages = 0;
    for (;;) {
      const page = await resticListDirectory(session, snapshotId, big, { limit: 10, after });
      pages += 1;
      expect(page.entries.length).toBeLessThanOrEqual(10);
      seen.push(...page.entries.map((entry) => entry.name));
      const last = page.entries.at(-1);
      if (!page.hasMore || !last) {
        break;
      }
      after = { folder: last.type === "dir", name: last.name };
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(full.entries.map((entry) => entry.name));
  }, 120_000);

  it("says there is nothing more when a page ends exactly at the end of the folder", async () => {
    const page = await resticListDirectory(session, snapshotId, folderOf("big"), { limit: 30 });
    expect(page.entries).toHaveLength(30);
    expect(page.hasMore).toBe(false);
    const past = await resticListDirectory(session, snapshotId, folderOf("big"), {
      limit: 10,
      after: { folder: false, name: "link" },
    });
    expect(past).toEqual({ entries: [], hasMore: false });
  }, 120_000);

  it("lists nothing for a folder the snapshot does not have", async () => {
    // restic prints no node for an unknown path and ends well: an empty listing, not an error.
    const page = await resticListDirectory(session, snapshotId, folderOf("missing"), { limit: 10 });
    expect(page).toEqual({ entries: [], hasMore: false });
  }, 120_000);

  it("looks up many paths with few restic runs, leaving out what is not there", async () => {
    // More than one batch of paths, mixed with paths the snapshot does not have.
    const wanted: string[] = [];
    for (let index = 0; index < 450; index++) {
      wanted.push(`${folderOf("big")}/file-${String(index % FILES).padStart(2, "0")}.txt`);
      wanted.push(`${folderOf("big")}/not-there-${index}.txt`);
    }
    wanted.push(folderOf("docs"), folderOf("big/link"));
    const found = await resticStatMany(session, snapshotId, wanted);
    expect(found.size).toBe(FILES + 2);
    expect(found.get(`${folderOf("big")}/file-07.txt`)?.type).toBe("file");
    expect(found.get(folderOf("docs"))?.type).toBe("dir");
    expect(found.get(folderOf("big/link"))?.type).toBe("symlink");
    expect(found.has(`${folderOf("big")}/not-there-1.txt`)).toBe(false);
  }, 180_000);

  it("stats one path, or none", async () => {
    expect((await resticStat(session, snapshotId, folderOf("docs/a.txt")))?.type).toBe("file");
    expect(await resticStat(session, snapshotId, folderOf("docs/none.txt"))).toBeNull();
  }, 120_000);

  it("resolves a selection in the order asked, once per path, and refuses a missing one", async () => {
    const selection = await resolveSelection(session, snapshotId, [
      folderOf("docs/deep"),
      folderOf("big/file-03.txt"),
      `${folderOf("docs/deep")}/`,
      "/",
    ]);
    expect(selection).toEqual([
      { path: folderOf("docs/deep"), type: "dir" },
      { path: folderOf("big/file-03.txt"), type: "file" },
      { path: "/", type: "dir" },
    ]);
    await expect(
      resolveSelection(session, snapshotId, [folderOf("docs/a.txt"), folderOf("docs/none.txt")]),
    ).rejects.toBeInstanceOf(SelectionError);
    // A link is neither a file nor a folder of the snapshot: it carries no content.
    await expect(
      resolveSelection(session, snapshotId, [folderOf("big/link")]),
    ).rejects.toBeInstanceOf(SelectionError);
  }, 120_000);
});

describe("forgetting snapshots by id", () => {
  const session: ResticSession = {
    repositoryUrl: "/nonexistent",
    username: "",
    password: "",
    repositoryPassword: "x",
    cacheDir: "/nonexistent",
  };

  it("takes only hex ids, so nothing can pass for an option or a policy", async () => {
    for (const bad of ["--keep-last=0", "latest", "ABCDEF12", "abc", `${"a".repeat(64)} x`]) {
      await expect(resticForget(session, [bad])).rejects.toBeInstanceOf(TypeError);
    }
    expect(await resticForget(session, [])).toBe(0);
  });

  it.skipIf(!resticAvailable())(
    "forgets exactly the snapshots named and prunes their data",
    async () => {
      const work = await mkdtemp(join(tmpdir(), "restow-restic-forget-"));
      try {
        const source = join(work, "source");
        await mkdir(source, { recursive: true });
        const local: ResticSession = {
          repositoryUrl: join(work, "repo"),
          username: "",
          password: "",
          repositoryPassword: "repository-password-for-tests",
          cacheDir: join(work, "cache"),
        };
        await resticInit(local);
        for (const content of ["one", "two", "three"]) {
          await writeFile(join(source, "file.txt"), content);
          await runRestic(local, ["backup", "--host", "test-host", source]);
        }
        const before = (await resticSnapshots(local, { noLock: true })).map(
          (snapshot) => snapshot.id,
        );
        expect(before).toHaveLength(3);
        const [, middle] = before;
        expect(await resticForget(local, [middle as string])).toBe(1);
        await resticPrune(local);
        const after = (await resticSnapshots(local)).map((snapshot) => snapshot.id);
        expect(after.sort()).toEqual(before.filter((id) => id !== middle).sort());
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
    120_000,
  );
});

describe("the sizes restic keeps in a snapshot", () => {
  let work: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restic-summary-"));
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  async function listedBy(json: string): Promise<ResticSession> {
    const fake = join(work, `restic-${Math.random().toString(36).slice(2)}.sh`);
    await writeFile(fake, `#!/bin/sh\ncat <<'EOF'\n${json}\nEOF\n`);
    await chmod(fake, 0o755);
    return {
      repositoryUrl: join(work, "repo"),
      username: "",
      password: "",
      repositoryPassword: "x",
      cacheDir: join(work, "cache"),
      binary: fake,
    };
  }

  it("reads what a backup added from the summary of restic 0.17+, and null before", async () => {
    const id = "a".repeat(64);
    const withSummary = await listedBy(
      JSON.stringify([
        {
          id,
          time: "2026-10-14T00:00:00Z",
          summary: { files_new: 3, total_bytes_processed: 9000, data_added: 1234 },
        },
      ]),
    );
    const [point] = await resticSnapshots(withSummary);
    expect(point).toMatchObject({ filesNew: 3, totalBytesProcessed: 9000, dataAdded: 1234 });
    const older = await listedBy(JSON.stringify([{ id, time: "2026-10-14T00:00:00Z" }]));
    expect((await resticSnapshots(older))[0]?.dataAdded).toBeNull();
  });
});

describe("a restic process stopped by a signal", () => {
  let work: string;
  let session: ResticSession;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restic-killed-"));
    // Writes part of its output, then dies the way an out-of-memory kill or a shutdown ends it.
    const fake = join(work, "restic-killed.sh");
    await writeFile(
      fake,
      '#!/bin/sh\nprintf \'{"name":"a.txt","type":"file","path":"/data/a.txt"}\\npartial\'\nkill -9 $$\n',
    );
    await chmod(fake, 0o755);
    session = {
      repositoryUrl: join(work, "repo"),
      username: "",
      password: "",
      repositoryPassword: "x",
      cacheDir: join(work, "cache"),
      binary: fake,
    };
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const killed = expect.objectContaining({
    failure: "killed",
    exitCode: null,
    message: expect.stringContaining("SIGKILL"),
  });

  it("is a failure for a run to completion, never an empty success", async () => {
    await expect(runRestic(session, ["snapshots", "--json"])).rejects.toEqual(killed);
    await expect(runRestic(session, ["snapshots"])).rejects.toBeInstanceOf(ResticError);
  });

  it("fails a dump, so a truncated file is never taken as the whole file", async () => {
    const dump = resticDump(session, "a".repeat(64), "/data/a.txt");
    const chunks: Buffer[] = [];
    for await (const chunk of dump.stream) {
      chunks.push(chunk as Buffer);
    }
    expect(Buffer.concat(chunks).toString()).toContain("partial");
    await expect(dump.done).rejects.toEqual(killed);
  });

  it("fails a folder listing and a lookup of paths it did not finish", async () => {
    await expect(resticListDirectory(session, "a".repeat(64), "/data")).rejects.toEqual(killed);
    await expect(
      resticStatMany(session, "a".repeat(64), ["/data/a.txt", "/data/b.txt"]),
    ).rejects.toEqual(killed);
  });

  it("makes a restore test try again instead of rating the backup red", async () => {
    const result = await restoreTestSamples(session, "a".repeat(64), [
      { path: "/data/a.txt", sha256: "0".repeat(64) },
    ]);
    expect(result.transient).toBe(true);
    expect(result.matched).toBe(0);
  });
});

describe("a check of a repository another run locked", () => {
  let work: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restic-locked-"));
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /** A restic that logs its arguments and answers like restic 0.19 for a locked repository. */
  async function lockedRestic(): Promise<{ session: ResticSession; argsFile: string }> {
    const fake = join(work, `restic-${Math.random().toString(36).slice(2)}.sh`);
    const argsFile = `${fake}.args`;
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > '${argsFile}'`,
        "cat >&2 <<'EOF'",
        "using parent snapshot 0123abcd",
        "repo already locked, waiting up to 5m0s for the lock",
        "unable to create lock in backend: repository is already locked by PID 4711 on host pve1 by root (UID 0, GID 0)",
        "lock was created at 2026-10-21 03:00:05 (12m4s ago)",
        "storage ID 1a2b3c4d",
        'the "unlock" command can be used to remove stale locks',
        "EOF",
        "exit 11",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    return {
      argsFile,
      session: {
        repositoryUrl: join(work, "repo"),
        username: "",
        password: "",
        repositoryPassword: "x",
        cacheDir: join(work, "cache"),
        binary: fake,
      },
    };
  }

  it("waits for the lock with --retry-lock when asked, and only a duration passes", async () => {
    const { session, argsFile } = await lockedRestic();
    await expect(resticCheck(session, "5%", { retryLock: "5m" })).rejects.toMatchObject({
      failure: "locked",
      exitCode: 11,
    });
    expect((await readFile(argsFile, "utf8")).trim().split("\n")).toEqual([
      "check",
      "--retry-lock=5m",
      "--read-data-subset=5%",
    ]);
    await expect(resticCheck(session, "5%")).rejects.toBeInstanceOf(ResticError);
    expect((await readFile(argsFile, "utf8")).trim().split("\n")).toEqual([
      "check",
      "--read-data-subset=5%",
    ]);
    for (const bad of ["5", "--no-lock", "5m --x", "1d"]) {
      await expect(resticCheck(session, "5%", { retryLock: bad })).rejects.toBeInstanceOf(
        TypeError,
      );
    }
  });

  it("keeps restic's report of who holds the lock, bounded", async () => {
    const { session } = await lockedRestic();
    const error = await resticCheck(session, "5%").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResticError);
    // The message alone keeps the last line only.
    expect((error as ResticError).message).not.toContain("PID 4711");
    const detail = resticErrorDetail(error);
    expect(detail).toContain("restic check failed (exit code 11)");
    expect(detail).toContain("already locked by PID 4711 on host pve1");
    expect(detail).toContain("lock was created at 2026-10-21 03:00:05");
    expect(detail).toContain("storage ID 1a2b3c4d");
    expect(detail).not.toContain("parent snapshot");
    // The last line is in the message already: once only.
    expect(detail.split("unlock").length - 1).toBe(1);
    expect(resticErrorDetail(error, 40)).toHaveLength(40);
    expect(resticErrorDetail(new Error("plain"))).toBe("plain");
  });
});
