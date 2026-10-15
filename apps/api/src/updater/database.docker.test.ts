import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseMover } from "./database.js";
import { CliDatabaseOps, type DatabaseOps } from "./database-ops.js";
import { EnvFile, postgresSettings } from "./env-file.js";
import { memoryLogger } from "./logger.js";
import { type ApiClient, OpsError, systemClock } from "./ops.js";
import { CliDockerOps } from "./ops-cli.js";
import { Redactor } from "./redact.js";
import { LocalRunner } from "./runner-local.js";
import { StatusStore } from "./store.js";

/**
 * The database move against a real Docker daemon: real `docker compose`, a real
 * PostgreSQL 16 with data in a named volume, the helper containers of database-ops.ts
 * copying, comparing and starting PostgreSQL on the copy, and the way back. Skipped
 * unless RESTOW_UPDATER_DOCKER_TARGET names an empty directory on another local file
 * system than Docker's (the target of the move), for example:
 *
 *   truncate -s 4G /var/tmp/restow-move.img && mkfs.ext4 -q -F /var/tmp/restow-move.img
 *   mkdir -p /mnt/restow-move && mount -o loop /var/tmp/restow-move.img /mnt/restow-move
 *   RESTOW_UPDATER_DOCKER_TARGET=/mnt/restow-move pnpm --filter @restow/api exec \
 *     vitest run src/updater/database.docker.test.ts
 *
 * Needs the images postgres:16-alpine and alpine:3.22 locally (nothing is pulled). The
 * application services are stand-ins (alpine running a shell loop); the database is real.
 */

const exec = promisify(execFile);
const TARGET = process.env.RESTOW_UPDATER_DOCKER_TARGET ?? "";
const PROJECT = "restow-dbmove-e2e";
const VOLUME = `${PROJECT}_pgdata`;

const COMPOSE = `name: ${PROJECT}
x-app: &app
  image: alpine:3.22
  env_file: [.env]
  command: ["sh", "-c", "trap 'exit 0' TERM; while true; do sleep 1; done"]
  restart: unless-stopped
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: restow
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?}
      POSTGRES_DB: restow
    volumes:
      - type: \${RESTOW_POSTGRES_DATA_TYPE:-volume}
        source: \${RESTOW_POSTGRES_DATA:-pgdata}
        target: /var/lib/postgresql/data
        bind:
          create_host_path: false
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U restow -d restow"]
      interval: 2s
      timeout: 5s
      retries: 30
    restart: unless-stopped
  api: *app
  worker: *app
  scheduler: *app
  caddy: *app
volumes:
  pgdata:
`;

/** The same project with the data directory fixed to the volume (a compose file before 0.4.0). */
const OLD_COMPOSE = COMPOSE.replace(
  /volumes:\n {6}- type:[\s\S]*?create_host_path: false\n/,
  "volumes:\n      - pgdata:/var/lib/postgresql/data\n",
);

let dir: string;
let projectDir: string;
let runner: LocalRunner;
let redactor: Redactor;

async function sh(args: string[], options: { cwd?: string; allowFail?: boolean } = {}) {
  try {
    const { stdout } = await exec(args[0] as string, args.slice(1), {
      cwd: options.cwd ?? projectDir,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    if (options.allowFail) {
      return null;
    }
    throw error;
  }
}

const compose = (...args: string[]) => sh(["docker", "compose", "-p", PROJECT, ...args]);
const psql = (sql: string) =>
  compose("exec", "-T", "postgres", "psql", "-U", "restow", "-d", "restow", "-Atc", sql);

async function waitHealthy(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await sh(
      ["docker", "inspect", "--format", "{{.State.Health.Status}}", `${PROJECT}-postgres-1`],
      { allowFail: true },
    );
    if (state === "healthy") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("PostgreSQL did not become healthy.");
}

/** The api stand-in is "ready" while its container runs. */
const api: Pick<ApiClient, "readiness"> = {
  readiness: async () => {
    const state = await sh(
      ["docker", "inspect", "--format", "{{.State.Status}}", `${PROJECT}-api-1`],
      { allowFail: true },
    );
    return state === "running"
      ? { ready: true, version: null, reason: null }
      : { ready: false, version: null, reason: `api ${state ?? "missing"}` };
  },
};

interface World {
  mover: DatabaseMover;
  store: StatusStore;
  database: DatabaseOps;
}

async function world(
  wrap: (
    ops: CliDockerOps,
    database: CliDatabaseOps,
  ) => {
    ops?: Partial<CliDockerOps>;
    database?: Partial<DatabaseOps>;
  } = () => ({}),
): Promise<World> {
  const logger = memoryLogger(redactor);
  const envFile = new EnvFile(path.join(projectDir, ".env"));
  const store = await StatusStore.open(path.join(dir, "state"), logger, () => new Date());
  const ops = new CliDockerOps({
    runner,
    redactor,
    projectDir,
    projectName: PROJECT,
    composeFile: null,
    dumpsDir: path.join(dir, "state", "dumps"),
    postgres: async () => postgresSettings(await envFile.read()),
    selfInspect: async () => null,
  });
  const database = new CliDatabaseOps({
    runner,
    redactor,
    projectName: PROJECT,
    composeFile: null,
    postgres: async () => postgresSettings(await envFile.read()),
  });
  const overrides = wrap(ops, database);
  const opsView = {
    composeStop: (services: readonly string[], timeout: number) =>
      ops.composeStop(services, timeout),
    composeUp: (services: readonly string[]) => ops.composeUp(services),
    servicesState: () => ops.servicesState(),
    migrationCount: () => ops.migrationCount(),
    ...overrides.ops,
  };
  const databaseView: DatabaseOps = Object.assign(
    Object.create(database),
    overrides.database ?? {},
  );
  const mover = new DatabaseMover({
    ops: opsView,
    database: databaseView,
    api,
    envFile,
    store,
    clock: systemClock,
    logger,
    redactor,
    otherActivity: () => null,
    healthTimeoutSeconds: 120,
  });
  return { mover, store, database: databaseView };
}

async function postgresMount(): Promise<string> {
  return (await sh([
    "docker",
    "inspect",
    "--format",
    '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}',
    `${PROJECT}-postgres-1`,
  ])) as string;
}

async function inVolume(script: string): Promise<string> {
  return (await sh([
    "docker",
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${VOLUME}:/old`,
    "--entrypoint",
    "sh",
    "postgres:16-alpine",
    "-c",
    script,
  ])) as string;
}

const ORIGINAL_ENV =
  "POSTGRES_PASSWORD=e2e-password\nRESTOW_POSTGRES_DATA_TYPE=\nRESTOW_POSTGRES_DATA=\n";

async function freshProject(): Promise<void> {
  await compose("down", "-v", "--remove-orphans").catch(() => undefined);
  await fs.writeFile(path.join(projectDir, "docker-compose.yml"), COMPOSE);
  await fs.writeFile(path.join(projectDir, ".env"), ORIGINAL_ENV, { mode: 0o600 });
  await fs.rm(path.join(dir, "state"), { recursive: true, force: true });
  for (const entry of await fs.readdir(TARGET)) {
    if (entry.startsWith("restow-postgres-")) {
      await sh(["rm", "-rf", path.join(TARGET, entry)]);
    }
  }
  await compose("up", "-d");
  await waitHealthy();
  await psql(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text); INSERT INTO drizzle.__drizzle_migrations (hash) SELECT 'm' || g FROM generate_series(1, 12) g; CREATE TABLE canary AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 200000) g;",
  );
}

describe.skipIf(!TARGET)("moving the database with a real Docker daemon", () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-dbmove-"));
    projectDir = path.join(dir, "project");
    await fs.mkdir(projectDir);
    redactor = new Redactor();
    runner = new LocalRunner({ redactor, cwd: projectDir });
  }, 60_000);

  afterAll(async () => {
    await compose("down", "-v", "--remove-orphans").catch(() => undefined);
    for (const entry of await fs.readdir(TARGET).catch(() => [] as string[])) {
      if (entry.startsWith("restow-postgres-")) {
        await sh(["rm", "-rf", path.join(TARGET, entry)], { allowFail: true });
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }, 120_000);

  it("moves the data, verifies it, switches, and the old copy cannot start any more", async () => {
    await freshProject();
    const { mover, store } = await world();
    const check = await mover.check(TARGET);
    expect(check.problems).toEqual([]);

    await mover.start({ targetDir: TARGET, requestedBy: { userId: null, label: "e2e", ip: null } });
    await mover.settled();
    const move = store.state.database?.move;
    expect(move?.failure).toBeNull();
    expect(move?.status).toBe("succeeded");
    const dataDir = move?.dataDir as string;
    expect(dataDir.startsWith(`${TARGET}/restow-postgres-`)).toBe(true);

    // Real data, real location.
    expect(await postgresMount()).toBe(`bind ${dataDir}`);
    expect(await psql("SELECT count(*), sum(id) FROM canary")).toBe("200000|20000100000");
    expect(await psql("SELECT count(*) FROM drizzle.__drizzle_migrations")).toBe("12");
    const env = await fs.readFile(path.join(projectDir, ".env"), "utf8");
    expect(env).toBe(
      `POSTGRES_PASSWORD=e2e-password\nRESTOW_POSTGRES_DATA_TYPE=bind\nRESTOW_POSTGRES_DATA=${dataDir}\n`,
    );
    // Owner and permissions survived the copy.
    expect(await sh(["stat", "-c", "%u:%g %a", dataDir])).toBe("70:70 700");

    // The old copy is marked and PostgreSQL refuses it.
    expect(await inVolume("ls /old | sort | tr '\\n' ' '")).toContain("PG_VERSION.restow-moved");
    expect(await inVolume("cat /old/RESTOW-MOVED.txt")).toContain(dataDir);
    expect(await inVolume("[ -e /old/PG_VERSION ] && echo yes || echo no")).toBe("no");

    // A restart and a recreate keep the new location (it is in .env).
    await compose("up", "-d", "--force-recreate", "postgres");
    await waitHealthy();
    expect(await postgresMount()).toBe(`bind ${dataDir}`);

    // An old compose file (the volume fixed) cannot start PostgreSQL on the stale copy.
    await fs.writeFile(path.join(projectDir, "old-compose.yml"), OLD_COMPOSE);
    await sh(
      [
        "docker",
        "compose",
        "-p",
        PROJECT,
        "-f",
        "old-compose.yml",
        "up",
        "-d",
        "--force-recreate",
        "postgres",
      ],
      {
        allowFail: true,
      },
    );
    let healthy = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await sh(
        [
          "docker",
          "inspect",
          "--format",
          "{{.State.Health.Status}} {{.State.Status}}",
          `${PROJECT}-postgres-1`,
        ],
        { allowFail: true },
      );
      if (state?.startsWith("healthy")) {
        healthy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(healthy).toBe(false);
    const logs = (await sh(["docker", "logs", `${PROJECT}-postgres-1`], { allowFail: true })) ?? "";
    expect(await inVolume("[ -e /old/PG_VERSION ] && echo yes || echo no")).toBe("no");
    expect(logs).not.toContain("database system is ready to accept connections");
    await compose("up", "-d", "--force-recreate", "postgres");
    await waitHealthy();
    expect(await psql("SELECT count(*) FROM canary")).toBe("200000");

    // Removing the old copy empties the volume and keeps the marker; the database runs on.
    const copyId = store.state.database?.oldCopies[0]?.id as string;
    await mover.removeOldCopy(copyId, { userId: null, label: "e2e", ip: null });
    await mover.settled();
    expect(store.state.database?.removal?.status).toBe("succeeded");
    expect(await inVolume("ls -A /old")).toBe("RESTOW-MOVED.txt");
    expect(await psql("SELECT count(*) FROM canary")).toBe("200000");
  }, 600_000);

  it("goes back to the volume when the check on the copy fails, and removes the copy", async () => {
    await freshProject();
    const { mover, store } = await world(() => ({
      database: {
        trial: async () => {
          throw new OpsError("PostgreSQL stopped on the copy.", "simulated");
        },
      },
    }));
    await mover.start({ targetDir: TARGET, requestedBy: { userId: null, label: "e2e", ip: null } });
    await mover.settled();
    const move = store.state.database?.move;
    expect(move?.status).toBe("rolled_back");
    expect(move?.failure?.code).toBe("trial.failed");
    expect(await postgresMount()).toBe(`volume ${VOLUME}`);
    expect(await fs.readFile(path.join(projectDir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
    expect(await psql("SELECT count(*) FROM canary")).toBe("200000");
    expect(
      (await fs.readdir(TARGET)).filter((entry) => entry.startsWith("restow-postgres-")),
    ).toEqual([]);
    expect(
      await sh(["docker", "inspect", "--format", "{{.State.Status}}", `${PROJECT}-api-1`]),
    ).toBe("running");
  }, 600_000);

  it("goes back after the switch: .env, PG_VERSION and the volume, keeping the copy", async () => {
    await freshProject();
    let ups = 0;
    const { mover, store } = await world((ops) => ({
      ops: {
        composeUp: async (services: readonly string[]) => {
          if (services.includes("api") && ups++ === 0) {
            throw new OpsError("Starting services failed (exit code 1).", "simulated");
          }
          await ops.composeUp(services);
        },
      },
    }));
    await mover.start({ targetDir: TARGET, requestedBy: { userId: null, label: "e2e", ip: null } });
    await mover.settled();
    const move = store.state.database?.move;
    expect(move?.failure?.code).toBe("start_application.failed");
    expect(move?.status).toBe("rolled_back");
    expect(move?.keptCopy).toBe(move?.dataDir);
    expect(await postgresMount()).toBe(`volume ${VOLUME}`);
    expect(await fs.readFile(path.join(projectDir, ".env"), "utf8")).toBe(ORIGINAL_ENV);
    expect(
      await inVolume("[ -e /old/PG_VERSION ] && [ ! -e /old/RESTOW-MOVED.txt ] && echo ok"),
    ).toBe("ok");
    expect(await psql("SELECT count(*) FROM canary")).toBe("200000");
  }, 600_000);

  it("refuses a directory on Docker's own file system", async () => {
    await freshProject();
    const { mover } = await world();
    const check = await mover.check("/var/lib/restow-db-e2e-missing");
    expect(check.problems.map((problem) => problem.code)).toEqual(["path_missing"]);
    await fs.mkdir("/srv/restow-db-e2e", { recursive: true });
    try {
      const same = await mover.check("/srv/restow-db-e2e");
      expect(same.problems.map((problem) => problem.code)).toContain("same_filesystem");
    } finally {
      await fs.rm("/srv/restow-db-e2e", { recursive: true, force: true });
    }
  }, 300_000);
});
