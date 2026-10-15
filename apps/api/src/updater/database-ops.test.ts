import { beforeEach, describe, expect, it } from "vitest";
import {
  CliDatabaseOps,
  DATABASE_HELPER_LABEL,
  dataLocationOfService,
  keyValues,
  parseManifest,
  parsePostgresInspect,
  TRIAL_CONTAINER,
} from "./database-ops.js";
import type { CommandResult, CommandRunner, CommandSpec } from "./ops.js";
import { Redactor } from "./redact.js";

class ScriptedRunner implements CommandRunner {
  readonly kind = "cli" as const;
  readonly specs: CommandSpec[] = [];
  private readonly answers: ((spec: CommandSpec) => Partial<CommandResult> | undefined)[] = [];

  answer(fn: (spec: CommandSpec) => Partial<CommandResult> | undefined): void {
    this.answers.push(fn);
  }

  async ping(): Promise<void> {}

  async readiness() {
    return { ready: true, detail: null };
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.specs.push(spec);
    for (const fn of [...this.answers].reverse()) {
      const answer = fn(spec);
      if (answer) {
        return {
          exitCode: 0,
          stdout: "",
          errorTail: "",
          timedOut: false,
          truncated: false,
          ...answer,
        };
      }
    }
    return { exitCode: 0, stdout: "", errorTail: "", timedOut: false, truncated: false };
  }
}

const IMAGE = `sha256:${"b".repeat(64)}`;
const NAME = "restow-postgres-20261015-101500";
let runner: ScriptedRunner;
let ops: CliDatabaseOps;

beforeEach(() => {
  runner = new ScriptedRunner();
  ops = new CliDatabaseOps({
    runner,
    redactor: new Redactor(),
    projectName: "restow",
    composeFile: null,
    postgres: async () => ({ user: "restow", db: "restow" }),
    clock: { now: () => new Date(), sleep: async () => undefined },
  });
  // Every named volume exists.
  runner.answer((spec) =>
    spec.argv[1] === "volume" && spec.argv[2] === "inspect"
      ? { stdout: `${spec.argv.at(-1)}\n` }
      : undefined,
  );
});

/** The `docker run` of a helper: its arguments up to the image, and what follows. */
function helperRun(spec: CommandSpec): { options: string[]; command: string[] } {
  const argv = [...spec.argv];
  const imageAt = argv.indexOf(IMAGE);
  return { options: argv.slice(0, imageAt), command: argv.slice(imageAt + 1) };
}

describe("helper containers", () => {
  it("run the postgres image without a network, labelled, never pulling, with the script constant", async () => {
    runner.answer((spec) =>
      spec.argv[1] === "run"
        ? {
            stdout:
              "exists=1\nsame_fs=0\nfs_magic=ef53\nfs_name=ext2/ext3\nowner=70:70\ntablespaces=0\nname_taken=0\nwritable=1\ntotal_kb=104857600\navail_kb=99614720\n",
          }
        : undefined,
    );
    const probe = await ops.probeTarget(
      IMAGE,
      { kind: "volume", source: "restow_pgdata" },
      "/mnt/volume-1/restow-db",
      NAME,
    );
    expect(probe).toEqual({
      exists: true,
      writable: true,
      sameFilesystem: false,
      filesystemMagic: "ef53",
      filesystem: "ext2/ext3",
      freeBytes: 99614720 * 1024,
      totalBytes: 104857600 * 1024,
      tablespaces: 0,
      owner: { uid: 70, gid: 70 },
      nameTaken: false,
    });
    const run = runner.specs.find((spec) => spec.argv[1] === "run") as CommandSpec;
    const { options, command } = helperRun(run);
    expect(options).toEqual([
      "docker",
      "run",
      "--rm",
      "--label",
      `${DATABASE_HELPER_LABEL}=1`,
      "--network",
      "none",
      "--pull",
      "never",
      "--security-opt",
      "no-new-privileges:true",
      "--mount",
      "type=volume,source=restow_pgdata,target=/from,readonly",
      "--mount",
      "type=bind,source=/mnt/volume-1/restow-db,target=/target",
      "--entrypoint",
      "sh",
    ]);
    // sh -c <constant script> sh <values>: the values never become script.
    expect(command[0]).toBe("-c");
    expect(command[1]).not.toContain("/mnt/volume-1");
    expect(command.slice(2)).toEqual(["sh", NAME]);
  });

  it("make sure a named volume exists before mounting it (docker run would create it)", async () => {
    runner.answer((spec) =>
      spec.argv[1] === "volume" ? { exitCode: 1, errorTail: "no such volume" } : undefined,
    );
    await expect(
      ops.clusterState(IMAGE, { kind: "volume", source: "restow_pgdata" }),
    ).rejects.toThrow("does not exist");
    expect(runner.specs.some((spec) => spec.argv[1] === "run")).toBe(false);
  });

  it("report a missing directory as not existing", async () => {
    runner.answer((spec) =>
      spec.argv[1] === "run"
        ? {
            exitCode: 125,
            errorTail:
              'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /mnt/x',
          }
        : undefined,
    );
    const probe = await ops.probeTarget(
      IMAGE,
      { kind: "volume", source: "restow_pgdata" },
      "/mnt/x",
      NAME,
    );
    expect(probe.exists).toBe(false);
  });

  it.each([["/mnt/a,b"], ["/mnt/a:b"], ["relative"], ["/mnt/../etc"], ["/mnt/$x"]])(
    "refuse the path %s before running anything",
    async (dir) => {
      await expect(
        ops.copy(IMAGE, { kind: "volume", source: "restow_pgdata" }, dir, NAME),
      ).rejects.toThrow();
      expect(runner.specs.filter((spec) => spec.argv[1] === "run")).toEqual([]);
    },
  );

  it("refuse a directory name the updater does not create", async () => {
    await expect(ops.removeCopy(IMAGE, "/mnt/volume-1", "important-data")).rejects.toThrow();
    expect(runner.specs).toEqual([]);
  });

  it("refuse an image that is not an image id", async () => {
    await expect(
      ops.clusterState("postgres:16-alpine", { kind: "bind", source: "/mnt/x" }),
    ).rejects.toThrow("image id");
  });

  it("read the cluster state", async () => {
    runner.answer((spec) => (spec.argv[1] === "run" ? { stdout: "shut down\n" } : undefined));
    expect(await ops.clusterState(IMAGE, { kind: "bind", source: "/mnt/x/y" })).toBe("shut down");
  });

  it("compare reads both manifests", async () => {
    const line = (side: string, entries: number) =>
      `${side} entries=${entries} bytes=1024 meta=${"a".repeat(64)} content=${"b".repeat(64)}`;
    runner.answer((spec) =>
      spec.argv[1] === "run"
        ? { stdout: `${line("source", 10)}\n${line("copy", 10)}\n` }
        : undefined,
    );
    const result = await ops.compare(
      IMAGE,
      { kind: "volume", source: "restow_pgdata" },
      "/mnt/volume-1",
      NAME,
    );
    expect(result.source).toEqual(result.copy);
    const run = runner.specs.find((spec) => spec.argv[1] === "run") as CommandSpec;
    // Both sides are mounted read-only for the comparison.
    expect(run.argv).toContain("type=volume,source=restow_pgdata,target=/a,readonly");
    expect(run.argv).toContain("type=bind,source=/mnt/volume-1,target=/b,readonly");
  });
});

describe("the trial", () => {
  it("starts PostgreSQL as the data's owner without a network, queries and stops it", async () => {
    runner.answer((spec) => {
      const argv = spec.argv;
      if (argv[1] === "exec" && argv[3] === "pg_isready") return { exitCode: 0 };
      if (argv[1] === "exec" && argv[3] === "psql") return { stdout: "12\n" };
      if (argv[1] === "inspect" && argv.includes("{{.State.ExitCode}}")) return { stdout: "0\n" };
      return undefined;
    });
    const count = await ops.trial(
      IMAGE,
      "/mnt/volume-1/x/restow-postgres-1",
      { uid: 70, gid: 70 },
      60_000,
    );
    expect(count).toBe(12);
    const run = runner.specs.find((spec) => spec.argv[1] === "run") as CommandSpec;
    expect(run.argv).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      TRIAL_CONTAINER,
      "--label",
      `${DATABASE_HELPER_LABEL}=1`,
      "--network",
      "none",
      "--pull",
      "never",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      "70:70",
      "--mount",
      "type=bind,source=/mnt/volume-1/x/restow-postgres-1,target=/var/lib/postgresql/data",
      "--env",
      "LC_ALL=C",
      "--entrypoint",
      "postgres",
      IMAGE,
      "-D",
      "/var/lib/postgresql/data",
      "-c",
      "listen_addresses=",
    ]);
    const verbs = runner.specs.map((spec) => spec.argv.slice(1, 3).join(" "));
    expect(verbs).toContain(`stop -t`);
    // The container is removed at the end, whatever happened.
    expect(runner.specs.at(-1)?.argv).toEqual(["docker", "rm", "-f", TRIAL_CONTAINER]);
  });

  it("fails when PostgreSQL stops on the copy, and removes the container", async () => {
    runner.answer((spec) => {
      const argv = spec.argv;
      if (argv[1] === "exec") return { exitCode: 2 };
      if (argv[1] === "inspect") return { stdout: "false\n" };
      if (argv[1] === "logs") return { stdout: "FATAL: data directory has wrong ownership" };
      return undefined;
    });
    await expect(
      ops.trial(IMAGE, "/mnt/volume-1/x/restow-postgres-1", { uid: 70, gid: 70 }, 60_000),
    ).rejects.toThrow("PostgreSQL stopped on the copy");
    expect(runner.specs.at(-1)?.argv).toEqual(["docker", "rm", "-f", TRIAL_CONTAINER]);
  });

  it("fails when PostgreSQL does not stop cleanly", async () => {
    runner.answer((spec) => {
      const argv = spec.argv;
      if (argv[1] === "exec" && argv[3] === "pg_isready") return { exitCode: 0 };
      if (argv[1] === "exec" && argv[3] === "psql") return { stdout: "12\n" };
      if (argv[1] === "inspect" && argv.includes("{{.State.ExitCode}}")) return { stdout: "137\n" };
      return undefined;
    });
    await expect(
      ops.trial(IMAGE, "/mnt/volume-1/x/restow-postgres-1", { uid: 70, gid: 70 }, 60_000),
    ).rejects.toThrow("exit code 137");
  });
});

describe("compose", () => {
  it("reads the data location from the configuration with the variables given", async () => {
    runner.answer((spec) =>
      spec.argv.includes("config")
        ? {
            stdout: JSON.stringify({
              services: {
                postgres: {
                  volumes: [
                    {
                      type: "bind",
                      source: "/mnt/x/restow-postgres-1",
                      target: "/var/lib/postgresql/data",
                    },
                  ],
                },
              },
            }),
          }
        : undefined,
    );
    const env = {
      RESTOW_POSTGRES_DATA_TYPE: "bind",
      RESTOW_POSTGRES_DATA: "/mnt/x/restow-postgres-1",
    };
    expect(await ops.configDataLocation(env)).toEqual({
      kind: "bind",
      source: "/mnt/x/restow-postgres-1",
    });
    expect(runner.specs[0]?.env).toEqual(env);
    expect(runner.specs[0]?.argv).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "config",
      "--format",
      "json",
    ]);
  });
});

describe("parsing", () => {
  it("names a project volume as Compose does", () => {
    const volumes = [{ type: "volume", source: "pgdata", target: "/var/lib/postgresql/data" }];
    expect(dataLocationOfService(volumes, { pgdata: { name: "restow_pgdata" } }, "restow")).toEqual(
      {
        kind: "volume",
        source: "restow_pgdata",
      },
    );
    expect(dataLocationOfService(volumes, {}, "other")).toEqual({
      kind: "volume",
      source: "other_pgdata",
    });
    expect(
      dataLocationOfService([{ type: "volume", source: "x", target: "/data" }], {}, "r"),
    ).toBeNull();
  });

  it("reads the postgres container", () => {
    const inspect = {
      Id: "c".repeat(64),
      Image: IMAGE,
      State: { Status: "running", Health: { Status: "healthy" } },
      Mounts: [
        {
          Type: "volume",
          Name: "restow_pgdata",
          Source: "/var/lib/docker/volumes/restow_pgdata/_data",
          Destination: "/var/lib/postgresql/data",
        },
      ],
    };
    expect(parsePostgresInspect(JSON.stringify(inspect))).toEqual({
      id: "c".repeat(64),
      imageId: IMAGE,
      state: "running",
      health: "healthy",
      location: { kind: "volume", source: "restow_pgdata" },
    });
    const bind = {
      ...inspect,
      State: { Status: "exited" },
      Mounts: [
        {
          Type: "bind",
          Source: "/mnt/x/restow-postgres-1",
          Destination: "/var/lib/postgresql/data",
        },
      ],
    };
    expect(parsePostgresInspect(JSON.stringify(bind))).toMatchObject({
      state: "exited",
      health: null,
      location: { kind: "bind", source: "/mnt/x/restow-postgres-1" },
    });
    expect(parsePostgresInspect("not json")).toBeNull();
  });

  it("reads manifests and refuses broken ones", () => {
    expect(
      parseManifest(`source entries=3 bytes=10 meta=${"a".repeat(64)} content=${"b".repeat(64)}`),
    ).toEqual({
      entries: 3,
      bytes: 10,
      meta: "a".repeat(64),
      content: "b".repeat(64),
    });
    expect(parseManifest("source entries=3 bytes=10 meta=x content=y")).toBeNull();
    expect(parseManifest(undefined)).toBeNull();
  });

  it("reads key=value lines", () => {
    expect(keyValues("a=1\nb = two\nnoise\n=x\n")).toEqual({ a: "1", b: "two" });
  });
});
