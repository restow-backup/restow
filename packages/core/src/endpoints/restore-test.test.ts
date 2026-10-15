import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorageBackend } from "../storage/local.js";
import {
  type RepositoryAccess,
  type ResticSession,
  endpointPrefix,
  resticBinary,
  resticInit,
  resticSnapshots,
  runRestic,
  withRepository,
} from "./restic-cli.js";
import {
  type AgentRestoreTestReport,
  type RestoreTestResult,
  compareSamples,
  isRestoreFinding,
  judgeAgentRestoreTest,
  restoreTestSamples,
} from "./restore-test.js";

function resticAvailable(): boolean {
  const result = spawnSync(resticBinary(), ["version"], { encoding: "utf8" });
  return result.status === 0 && /^restic 0\.\d+/.test(result.stdout);
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("comparing sample hashes", () => {
  it("counts every matching file", () => {
    const result = compareSamples(
      [
        { path: "/etc/hosts", sha256: HASH_A },
        { path: "/home/anna/a.txt", sha256: HASH_B },
      ],
      new Map([
        ["/etc/hosts", { sha256: HASH_A }],
        ["/home/anna/a.txt", { sha256: HASH_B.toUpperCase() }],
      ]),
    );
    expect(result).toMatchObject({ files: 2, matched: 2, mismatched: [], transient: false });
  });

  it("reports a different hash, an unreadable file and a file nobody read", () => {
    const result = compareSamples(
      [
        { path: "/a", sha256: HASH_A },
        { path: "/b", sha256: HASH_A },
        { path: "/c", sha256: HASH_A },
      ],
      new Map([
        ["/a", { sha256: HASH_B }],
        ["/b", { sha256: null, reason: "restic failed: not found" }],
      ]),
    );
    expect(result.matched).toBe(0);
    expect(result.mismatched).toEqual([
      { path: "/a", expected: HASH_A, actual: HASH_B },
      { path: "/b", expected: HASH_A, actual: null, reason: "restic failed: not found" },
      { path: "/c", expected: HASH_A, actual: null },
    ]);
  });
});

/**
 * The agent's own restore test (`verify_sample`): what it reports is judged
 * with the same findings as the server's test. The restic messages are the
 * ones restic 0.19.1 writes for `restore --json --verify --include` against a
 * REST repository (damaged, missing and absent objects, checked by hand).
 */
describe("judging the agent's restore test", () => {
  const expected = [
    { path: "/data/a.txt", sha256: HASH_A },
    { path: "/data/b.txt", sha256: HASH_B },
  ];
  const restored = (
    overrides: Record<string, Partial<AgentRestoreTestReport["files"][number]>> = {},
  ) => expected.map((file) => ({ path: file.path, sha256: file.sha256, ...overrides[file.path] }));
  const resticFailed = (
    fatal: string,
    errors: { item: string; message: string }[] = [],
    exitCode = 1,
  ): AgentRestoreTestReport => ({
    files: restored({ "/data/b.txt": { sha256: undefined, missing: true } }),
    restic: { exitCode, fatal, errors },
  });
  const judge = (
    report: AgentRestoreTestReport | undefined,
    status: "succeeded" | "failed" = "failed",
    extra: { errorCount?: number; snapshotMayBeGone?: boolean } = {},
  ) =>
    judgeAgentRestoreTest({
      expected,
      status,
      errorCount: extra.errorCount ?? (status === "failed" ? 1 : 0),
      report,
      snapshotMayBeGone: extra.snapshotMayBeGone,
    });
  const MISSING_PACK = "ReadFull(<data/6e73100d78>): <data/6e73100d78> does not exist";
  const LCHOWN = "lchown /var/lib/restow-agent/tmp/verify-1/data/b.txt: no such file or directory";

  it("is green when every file came back with its hash", () => {
    const verdict = judge({ files: restored() }, "succeeded");
    expect(verdict).toMatchObject({
      rating: "green",
      result: { files: 2, matched: 2, mismatched: [] },
    });
  });

  it("is green for an older agent that passed (it compared every hash itself)", () => {
    expect(judge(undefined, "succeeded")).toMatchObject({
      rating: "green",
      result: { files: 2, matched: 2 },
    });
  });

  it.each([
    ["a hash that differs", { files: restored({ "/data/b.txt": { sha256: HASH_A } }) }, HASH_A],
    [
      "a file the snapshot does not have (restic restored it without error)",
      { files: restored({ "/data/b.txt": { sha256: undefined, missing: true } }) },
      null,
    ],
    [
      "a pack the file needs is missing",
      resticFailed("Fatal: There were 2 errors", [
        { item: "/data/b.txt", message: MISSING_PACK },
        { item: "/data/b.txt", message: LCHOWN },
      ]),
      null,
    ],
    [
      "its data does not decrypt",
      resticFailed("Fatal: There were 1 errors", [
        {
          item: "/data/b.txt",
          message:
            "decrypting blob <data/b6a98d9c> from pack 6e73100d788bb827 failed: ciphertext verification failed",
        },
      ]),
      null,
    ],
    [
      "the snapshot's tree is not in the index",
      resticFailed("Fatal: There were 2 errors", [
        { item: "/", message: "id 1dc9dc1a53149ea7 not found in repository" },
        { item: "/", message: "id 1dc9dc1a53149ea7 not found in repository" },
      ]),
      null,
    ],
    [
      "the snapshot does not match its id",
      resticFailed(
        "Fatal: failed to find snapshot: failed to load snapshot 47ce07fd: LoadRaw(<snapshot/47ce07fd20>): invalid data returned",
      ),
      null,
    ],
    [
      "the snapshot of the newest backup is gone",
      resticFailed(
        "Fatal: failed to find snapshot: failed to load snapshot 47ce07fd: <snapshot/47ce07fd20> does not exist",
      ),
      null,
    ],
  ])("is red with proof: %s", (_name, report, actual) => {
    const verdict = judge(report);
    expect(verdict.rating).toBe("red");
    if (verdict.rating !== "red") return;
    expect(verdict.result).toMatchObject({ files: 2, matched: 1 });
    expect(verdict.result.mismatched).toEqual([
      expect.objectContaining({ path: "/data/b.txt", expected: HASH_B, actual }),
    ]);
  });

  it("names restic's finding as the reason of a file it could not restore", () => {
    const verdict = judge(
      resticFailed("Fatal: There were 2 errors", [
        { item: "/data/b.txt", message: MISSING_PACK },
        { item: "/data/b.txt", message: LCHOWN },
      ]),
    );
    expect(verdict.rating === "red" && verdict.result.mismatched[0]?.reason).toBe(MISSING_PACK);
  });

  it.each([
    ["an older agent that failed without saying why", undefined],
    ["a run that never got to restic (invalid task, no temporary folder, stopped)", null],
    [
      "a busy repository",
      resticFailed("Fatal: unable to create lock in backend: repository is already locked", [], 11),
    ],
    ["a wrong password", resticFailed("Fatal: wrong password or no key found", [], 12)],
    ["a repository that does not open", resticFailed("Fatal: repository does not exist", [], 10)],
    ["restic stopped by a signal", resticFailed("", [], -1)],
    ["restic crashing", resticFailed("", [], 2)],
    [
      "a Go runtime error that mentions damage, without restic's fatal prefix",
      resticFailed("ciphertext verification failed"),
    ],
    [
      "a network error",
      resticFailed(
        'Fatal: unable to open config file: Stat: Head "https://restow.example/agent/restic/x/config": dial tcp: connection refused',
      ),
    ],
    [
      "a full disk on the machine",
      resticFailed("Fatal: There were 1 errors", [
        {
          item: "/data/b.txt",
          message: "write /var/lib/restow-agent/tmp/x: no space left on device",
        },
      ]),
    ],
    [
      "a server error the request gave up on",
      resticFailed("Fatal: There were 1 errors", [
        {
          item: "/data/b.txt",
          message:
            "ReadFull(<data/6e73100d78>): unexpected HTTP response (500): 500 Internal Server Error",
        },
      ]),
    ],
    [
      "one damaged file and one the disk could not take",
      {
        files: expected.map((file) => ({ path: file.path, missing: true })),
        restic: {
          exitCode: 1,
          fatal: "Fatal: There were 2 errors",
          errors: [
            { item: "/data/a.txt", message: MISSING_PACK },
            { item: "/data/b.txt", message: "write: no space left on device" },
          ],
        },
      },
    ],
    [
      "more errors than the agent forwarded",
      resticFailed("Fatal: There were 3 errors", [{ item: "/data/b.txt", message: MISSING_PACK }]),
    ],
    [
      "a file the agent could not read on the machine, beside a hash that differs",
      {
        files: [
          { path: "/data/a.txt", sha256: HASH_B },
          { path: "/data/b.txt", error: "The restored file cannot be read: input/output error" },
        ],
      },
    ],
    [
      "a restored item that is no regular file",
      {
        files: restored({
          "/data/b.txt": { sha256: undefined, error: "The restored item is not a regular file." },
        }),
      },
    ],
    ["a file the agent did not report", { files: restored().slice(0, 1) }],
  ])("is incomplete, not red, after %s", (_name, report) => {
    const verdict = judge(report ?? undefined);
    expect(verdict).toMatchObject({ rating: "incomplete", reason: expect.any(String) });
  });

  it("does not count a missing snapshot that retention may have forgotten", () => {
    const report = resticFailed(
      "Fatal: failed to find snapshot: failed to load snapshot 47ce07fd: <snapshot/47ce07fd20> does not exist",
    );
    expect(judge(report, "failed", { snapshotMayBeGone: true }).rating).toBe("incomplete");
    // A damaged snapshot or damaged data stay proof for an older backup too.
    expect(
      judge(
        resticFailed("Fatal: There were 1 errors", [
          { item: "/data/b.txt", message: MISSING_PACK },
        ]),
        "failed",
        { snapshotMayBeGone: true },
      ).rating,
    ).toBe("red");
  });

  it("is incomplete when the agent reports a failure but every file matched", () => {
    expect(judge({ files: restored() }, "failed").rating).toBe("incomplete");
  });

  it("is incomplete when the task lists no files", () => {
    expect(
      judgeAgentRestoreTest({
        expected: [],
        status: "succeeded",
        errorCount: 0,
        report: { files: [] },
      }).rating,
    ).toBe("incomplete");
  });

  it("keeps a long restic reason short, with restic's cause at its end", () => {
    const long = `/${"deep/".repeat(80)}file`;
    const verdict = judge(
      resticFailed("Fatal: There were 1 errors", [
        { item: "/data/b.txt", message: `write ${long}: no space left on device` },
      ]),
    );
    expect(verdict.rating).toBe("incomplete");
    if (verdict.rating !== "incomplete") return;
    expect(verdict.reason.length).toBeLessThanOrEqual(300);
    expect(verdict.reason).toMatch(/no space left on device$/);
  });

  it("reads restic's count of item errors in either grammar", () => {
    const one = { item: "/data/b.txt", message: MISSING_PACK };
    expect(
      isRestoreFinding({ exitCode: 1, fatal: "Fatal: There were 1 errors", errors: [one] }),
    ).toBe(true);
    expect(
      isRestoreFinding({ exitCode: 1, fatal: "Fatal: There was 1 error", errors: [one] }),
    ).toBe(true);
    expect(isRestoreFinding({ exitCode: 1, fatal: "Fatal: There were 0 errors", errors: [] })).toBe(
      false,
    );
    expect(
      isRestoreFinding({ exitCode: 3, fatal: "Fatal: There were 1 errors", errors: [one] }),
    ).toBe(false);
  });
});

/**
 * What a failed `restic dump` of a sampled file counts as. A fake restic stands
 * in for each failure (the shape of its message and exit code is the one
 * restic 0.19 gives, see the real-restic block below); the samples it serves
 * have the content "alpha\n".
 */
describe("a sampled file restic could not read", () => {
  const ALPHA = createHash("sha256").update("alpha\n").digest("hex");
  let work: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restore-test-"));
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /**
   * A restic that prints "alpha\n" for every dump, except for a path ending in
   * `/bad`, where it runs `failure` (shell) instead.
   */
  async function fakeRestic(name: string, failure: string): Promise<ResticSession> {
    const binary = join(work, `restic-${name}.sh`);
    await writeFile(
      binary,
      `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  */bad) ${failure} ;;\n  *) printf 'alpha\\n' ;;\nesac\n`,
    );
    await chmod(binary, 0o755);
    return {
      repositoryUrl: join(work, "repo"),
      username: "",
      password: "",
      repositoryPassword: "x",
      cacheDir: join(work, "cache"),
      binary,
    };
  }

  const samples = [
    { path: "/data/a.txt", sha256: ALPHA },
    { path: "/data/bad", sha256: ALPHA },
    { path: "/data/c.txt", sha256: ALPHA },
  ];

  const fail = (exitCode: number, message: string) =>
    `echo ${JSON.stringify(message)} >&2; exit ${exitCode}`;

  it.each([
    [
      "an I/O error reading the repository",
      fail(1, "Fatal: cannot dump file: ReadFull(<data/0a1b2c3d>): read tcp: connection reset"),
    ],
    [
      "restic giving up on a request that timed out",
      fail(1, "Fatal: cannot dump file: Load(<data/0a1b2c3d>): context deadline exceeded"),
    ],
    ["restic crashing (Go runtime error)", fail(2, "fatal error: runtime: out of memory")],
    ["a repository it could not open", fail(10, "Fatal: repository does not exist")],
    ["a password that does not open the repository", fail(12, "Fatal: wrong password")],
    ["a repository locked by other work", fail(11, "Fatal: repository is already locked")],
    ["restic stopped by a signal", "kill -9 $$"],
    ["an error restic does not attribute to the backup", fail(1, "Fatal: something else")],
    [
      "an error without restic's fatal prefix (a stack trace)",
      fail(1, "ciphertext verification failed\\n\\tgithub.com/restic/restic/main.go:42"),
    ],
    [
      "a failure after a retried request that looked like damage",
      `echo "Load(<data/0a1b2c3d4e>) returned error, retrying after 1s: ciphertext verification failed" >&2; ${fail(1, "Fatal: cannot dump file: connection refused")}`,
    ],
  ])(
    "is no finding when the cause is %s: the test is incomplete, not red",
    async (name, failure) => {
      const session = await fakeRestic(name.replace(/\W+/g, "-"), failure);
      const result = await restoreTestSamples(session, "a".repeat(64), samples);
      expect(result.transient).toBe(true);
      expect(result.incomplete).toEqual(expect.any(String));
      expect(result.matched).toBe(2);
    },
  );

  it("is incomplete when a dump is cut short (a timeout or a shutdown), never a match", async () => {
    // Hangs while it has delivered part of the file; the caller's signal stops it.
    const session = await fakeRestic("hangs", "printf 'alp'; exec sleep 30");
    const result = await restoreTestSamples(session, "a".repeat(64), samples, {
      signal: AbortSignal.timeout(1000),
    });
    expect(result).toMatchObject({ transient: true, matched: 2 });
    expect(result.mismatched).toEqual([
      expect.objectContaining({ path: "/data/bad", actual: null }),
    ]);
  });

  it("is incomplete when restic cannot be started", async () => {
    const session: ResticSession = {
      repositoryUrl: join(work, "repo"),
      username: "",
      password: "",
      repositoryPassword: "x",
      cacheDir: join(work, "cache"),
      binary: join(work, "no-such-restic"),
    };
    const result = await restoreTestSamples(session, "a".repeat(64), samples);
    expect(result).toMatchObject({ transient: true, matched: 0 });
    expect(result.incomplete).toContain("ENOENT");
  });

  it.each([
    [
      "the file is not in the snapshot",
      'Fatal: cannot dump file: path "/data/bad" not found in snapshot',
    ],
    [
      "its data does not decrypt",
      "Fatal: cannot dump file: decrypting blob <data/98cc2c08> from pack d7bc81 failed: ciphertext verification failed",
    ],
    [
      "a pack it needs is missing",
      "Fatal: cannot dump file: ReadFull(<data/d7bc812289>): <data/d7bc812289> does not exist",
    ],
    [
      "a blob it needs is not in the index",
      'Fatal: loading tree for snapshot "4a3305ab" failed: id 895bd56e not found in repository',
    ],
    [
      "the snapshot does not match its id",
      "Fatal: failed to find snapshot: failed to load snapshot 4a3305ab: LoadRaw(<snapshot/4a3305abd0>): invalid data returned",
    ],
  ])(
    "is a finding when restic reports that %s: the test is complete and the file mismatched",
    async (name, message) => {
      const session = await fakeRestic(name.replace(/\W+/g, "-"), fail(1, message));
      const result = await restoreTestSamples(session, "a".repeat(64), samples);
      expect(result).toMatchObject({ transient: false, matched: 2 });
      expect(result.incomplete).toBeUndefined();
      expect(result.mismatched).toEqual([
        expect.objectContaining({ path: "/data/bad", actual: null, reason: expect.any(String) }),
      ]);
    },
  );

  it("is a finding when a file reads back with other content", async () => {
    const session = await fakeRestic("other-content", "printf 'bravo\\n'");
    const result = await restoreTestSamples(session, "a".repeat(64), samples);
    expect(result).toMatchObject({ transient: false, matched: 2 });
    expect(result.mismatched).toEqual([
      expect.objectContaining({
        path: "/data/bad",
        actual: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("keeps restic's cause in the reason when the path before it is long", async () => {
    const long = `/${"deep/".repeat(80)}file`;
    const session = await fakeRestic(
      "long-reason",
      fail(
        1,
        `Fatal: cannot dump file: cannot load subtree for "${long}": ciphertext verification failed`,
      ),
    );
    const result = await restoreTestSamples(session, "a".repeat(64), samples);
    const reason = result.mismatched[0]?.reason ?? "";
    expect(reason.length).toBeLessThanOrEqual(300);
    expect(reason).toMatch(/^restic dump failed \(exit code 1\): Fatal: cannot dump file/);
    expect(reason).toMatch(/ciphertext verification failed$/);
  });

  it("stays incomplete when one file proves nothing, whatever the others showed", async () => {
    // One file is damaged, the read of another failed for a reason that proves nothing:
    // the test is tried again rather than rated on what it could read.
    const binary = join(work, "restic-mixed.sh");
    await writeFile(
      binary,
      `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  */damaged) ${fail(1, "Fatal: cannot dump file: ciphertext verification failed")} ;;\n  */bad) ${fail(1, "Fatal: cannot dump file: connection refused")} ;;\n  *) printf 'alpha\\n' ;;\nesac\n`,
    );
    await chmod(binary, 0o755);
    const result = await restoreTestSamples(
      { ...(await fakeRestic("unused", "true")), binary },
      "a".repeat(64),
      [...samples, { path: "/data/damaged", sha256: ALPHA }],
    );
    expect(result).toMatchObject({ transient: true, matched: 2 });
    expect(result.incomplete).toContain("connection refused");
  });
});

describe("the order the samples are read in", () => {
  let work: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restore-order-"));
  });

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("reads the smallest file alone first, so a new cache folder is set up by one restic only", async () => {
    // A fresh cache folder set up by several restic processes at once makes some of them
    // give up ("unable to open cache: readVersion"); the first read must end before the others start.
    const log = join(work, "log");
    const binary = join(work, "restic-order.sh");
    await writeFile(
      binary,
      `#!/bin/sh\nfor last; do :; done\necho "start $last" >> ${JSON.stringify(log)}\nsleep 0.2\nprintf 'alpha\\n'\necho "end $last" >> ${JSON.stringify(log)}\n`,
    );
    await chmod(binary, 0o755);
    const ALPHA = createHash("sha256").update("alpha\n").digest("hex");
    const sizes: Record<string, number> = {
      "/big": 9000,
      "/small": 10,
      "/mid": 500,
      "/huge": 90000,
    };
    const result = await restoreTestSamples(
      {
        repositoryUrl: join(work, "repo"),
        username: "",
        password: "",
        repositoryPassword: "x",
        cacheDir: join(work, "cache"),
        binary,
      },
      "a".repeat(64),
      Object.entries(sizes).map(([path, size]) => ({ path, sha256: ALPHA, size })),
    );
    expect(result).toMatchObject({ files: 4, matched: 4, transient: false });
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["start /small", "end /small"]);
    // The others then run side by side.
    expect(lines.slice(2, 5).every((line) => line.startsWith("start "))).toBe(true);
  });
});

/**
 * The finding messages above, from the pinned restic itself, read the way the
 * server reads: through the maintenance listener over a storage backend.
 */
describe.skipIf(!resticAvailable())("a damaged or incomplete repository, read with restic", () => {
  const ENDPOINT = "00000000-0000-4000-8000-0000000000aa";
  let work: string;
  let access: RepositoryAccess;
  let snapshotId: string;
  let repo: string;
  const files: Record<string, Buffer> = {
    "a.txt": Buffer.from("alpha\n"),
    "big.bin": randomBytes(300_000),
  };
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  let samples: { path: string; sha256: string }[];

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "restow-restore-test-restic-"));
    repo = join(work, "storage", endpointPrefix(ENDPOINT));
    const source = join(work, "source");
    await mkdir(source, { recursive: true });
    for (const [name, bytes] of Object.entries(files)) {
      await writeFile(join(source, name), bytes);
    }
    access = {
      storage: new LocalStorageBackend(join(work, "storage")),
      prefix: endpointPrefix(ENDPOINT),
      repositoryPassword: "repository-password-for-tests",
      repositoryKey: ENDPOINT,
      cacheBase: join(work, "cache"),
    };
    snapshotId = await withRepository(access, async (session) => {
      await resticInit(session);
      await runRestic(session, ["backup", source]);
      return (await resticSnapshots(session))[0]?.id as string;
    });
    samples = Object.entries(files).map(([name, bytes]) => ({
      path: join(source, name),
      sha256: hash(bytes),
    }));
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /** Every file of a repository folder, e.g. `data`. */
  async function objects(folder: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else found.push(path);
      }
    };
    await walk(join(repo, folder));
    return found;
  }

  /** Change the repository with `damage`, test (with an empty cache), then put every object back. */
  async function testWith(
    damage: () => Promise<void>,
    extra: { path: string; sha256: string }[] = [],
  ) {
    const saved = new Map<string, Buffer>();
    for (const folder of ["data", "index", "snapshots"]) {
      for (const path of await objects(folder)) saved.set(path, await readFile(path));
    }
    try {
      await damage();
      return await withRepository(
        { ...access, cacheBase: await mkdtemp(join(work, "cache-")) },
        (session) => restoreTestSamples(session, snapshotId, [...samples, ...extra]),
      );
    } finally {
      for (const [path, bytes] of saved) await writeFile(path, bytes);
    }
  }

  /** Every file was read, and each one that was not as reported is a finding with restic's reason. */
  const allFindings = (result: RestoreTestResult) => {
    expect(result.transient).toBe(false);
    expect(result.incomplete).toBeUndefined();
    for (const file of result.mismatched) {
      expect(file.reason).toMatch(/^restic dump failed \(exit code 1\): /);
    }
  };

  it("matches a sound repository, and a file the snapshot does not have is a finding", async () => {
    const result = await testWith(async () => {}, [
      { path: "/no/such/file", sha256: "0".repeat(64) },
    ]);
    allFindings(result);
    expect(result).toMatchObject({ files: 3, matched: 2 });
    expect(result.mismatched[0]?.reason).toContain("not found in snapshot");
  }, 60_000);

  it("finds damaged data, missing data, a missing index and a damaged or missing snapshot", async () => {
    // Every 16th byte: no encrypted blob (32 bytes and more) stays whole, whichever a file needs.
    const flip = async (path: string) => {
      const bytes = await readFile(path);
      for (let index = 0; index < bytes.length; index += 16) {
        bytes[index] = (bytes[index] ?? 0) ^ 0xff;
      }
      await writeFile(path, bytes);
    };
    for (const [folder, damage] of [
      ["data", flip],
      ["data", (path: string) => rm(path)],
      ["index", (path: string) => rm(path)],
      ["snapshots", flip],
      ["snapshots", (path: string) => rm(path)],
    ] as const) {
      const result = await testWith(async () => {
        for (const path of await objects(folder)) await damage(path);
      });
      allFindings(result);
      expect(result, `${folder} ${damage === flip ? "damaged" : "missing"}`).toMatchObject({
        files: 2,
        matched: 0,
      });
    }
  }, 120_000);

  /**
   * The agent's restore test with the same damage: `restic restore` the way
   * the agent runs it (agent/internal/restic/restore.go), reported the way the
   * agent reports it (agent/internal/core/verify.go: restic's JSON errors and
   * final error from stderr, then every file looked at in the restored copy),
   * judged like the server judges the agent's report.
   */
  async function agentTestWith(damage: () => Promise<void>, include = samples) {
    const saved = new Map<string, Buffer>();
    for (const folder of ["data", "index", "snapshots"]) {
      for (const path of await objects(folder)) saved.set(path, await readFile(path));
    }
    try {
      await damage();
      const target = await mkdtemp(join(work, "restored-"));
      const { stderr, exitCode } = await withRepository(
        { ...access, cacheBase: await mkdtemp(join(work, "cache-")) },
        (session) =>
          runRestic(
            session,
            [
              "restore",
              "--json",
              "--target",
              target,
              "--overwrite",
              "never",
              "--verify",
              ...include.flatMap((sample) => ["--include", sample.path]),
              snapshotId,
            ],
            { acceptExitCodes: [1] },
          ),
      );
      const report: AgentRestoreTestReport = { files: [] };
      for (const sample of include) {
        try {
          report.files.push({
            path: sample.path,
            sha256: hash(await readFile(join(target, sample.path))),
          });
        } catch {
          report.files.push({ path: sample.path, missing: true });
        }
      }
      if (exitCode !== 0) {
        const lines = stderr.split("\n").flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
        report.restic = {
          exitCode,
          fatal: String(lines.find((line) => line.message_type === "exit_error")?.message ?? ""),
          errors: lines
            .filter((line) => line.message_type === "error")
            .map((line) => ({
              item: String(line.item ?? ""),
              message: String((line.error as { message?: string } | undefined)?.message ?? ""),
            })),
        };
      }
      const matched = report.files.every(
        (file, index) => file.sha256 !== undefined && file.sha256 === include[index]?.sha256,
      );
      return judgeAgentRestoreTest({
        expected: include,
        status: exitCode === 0 && matched ? "succeeded" : "failed",
        errorCount: exitCode === 0 && matched ? 0 : 1,
        report,
      });
    } finally {
      for (const [path, bytes] of saved) await writeFile(path, bytes);
    }
  }

  it("rates the agent's restore of a sound repository green, and a file not in the snapshot red", async () => {
    expect(await agentTestWith(async () => {})).toMatchObject({
      rating: "green",
      result: { files: 2, matched: 2 },
    });
    const absent = await agentTestWith(async () => {}, [
      ...samples,
      { path: "/no/such/file", sha256: "0".repeat(64) },
    ]);
    expect(absent).toMatchObject({ rating: "red", result: { files: 3, matched: 2 } });
  }, 60_000);

  it("rates the agent's restore red with damaged data, missing data, a missing index and a damaged or missing snapshot", async () => {
    const flip = async (path: string) => {
      const bytes = await readFile(path);
      for (let index = 0; index < bytes.length; index += 16) {
        bytes[index] = (bytes[index] ?? 0) ^ 0xff;
      }
      await writeFile(path, bytes);
    };
    for (const [folder, damage] of [
      ["data", flip],
      ["data", (path: string) => rm(path)],
      ["index", (path: string) => rm(path)],
      ["snapshots", flip],
      ["snapshots", (path: string) => rm(path)],
    ] as const) {
      const verdict = await agentTestWith(async () => {
        for (const path of await objects(folder)) await damage(path);
      });
      expect(verdict, `${folder} ${damage === flip ? "damaged" : "missing"}`).toMatchObject({
        rating: "red",
        result: { files: 2, matched: 0 },
      });
    }
    // Only the pack with the files' contents: restic restores the tree, fails on each file and
    // adds a follow-up error for it (it cannot set the owner of a file it could not write).
    for (const damage of [flip, (path: string) => rm(path)]) {
      const verdict = await agentTestWith(async () => {
        const packs = await objects("data");
        const sizes = await Promise.all(packs.map(async (path) => (await stat(path)).size));
        await damage(packs[sizes.indexOf(Math.max(...sizes))] as string);
      });
      expect(verdict, `contents ${damage === flip ? "damaged" : "missing"}`).toMatchObject({
        rating: "red",
        result: { files: 2, matched: 0 },
      });
    }
  }, 120_000);
});
