#!/usr/bin/env node
/**
 * The updater against the GENUINE Restow image and the repository's real
 * docker-compose.yml.
 *
 *   docker build --target runtime --build-arg RESTOW_VERSION=0.1.0-test1 -t restow:0.1.0-test1 .
 *   node scripts/updater-e2e/genuine.mjs [--keep] [--cleanup]
 *
 * The script builds the second version itself (same sources, another RESTOW_VERSION build
 * argument) and the two web images, starts the real compose project under the name
 * `restow-updater-genuine` (ports remapped through a compose override, which also proves
 * that an override file is honoured), starts the updater as the compose service of the
 * real file (`ROLE=updater` of the genuine image, helper containers), and then updates
 * 0.1.0-test1 to 0.1.0-test2 and attempts a broken 0.1.0-test3. See README.md.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORK = path.join(os.homedir(), ".restow-e2e", "updater-genuine");
const PROJECT = "restow-updater-genuine";
const PORT = {
  registry: 55530,
  api: 55532,
  updater: 55533,
  http: 55534,
  https: 55535,
  postgres: 55536,
};
const REGISTRY_CONTAINER = `${PROJECT}-registry`;
const REGISTRY = `localhost:${PORT.registry}`;
const DIRS = { project: path.join(WORK, "project") };
const ENV_FILE = path.join(DIRS.project, ".env");
const BASE_APP = "restow:0.1.0-test1";
const BASE_WEB = "restow-web:0.1.0-test1";
const MY_TAGS = [
  "restow:0.1.0-test1",
  "restow:0.1.0-test2",
  "restow-web:0.1.0-test1",
  "restow-web:0.1.0-test2",
  `${REGISTRY}/restow:0.1.0-test2`,
  `${REGISTRY}/restow-web:0.1.0-test2`,
  `${REGISTRY}/restow:0.1.0-test3`,
];
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const pulledBefore = new Set();
let secret = "";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) =>
  console.log(`[genuine ${new Date().toISOString().slice(11, 19)}] ${message}`);

function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      argv,
      {
        maxBuffer: 64 * 1024 * 1024,
        encoding: options.buffer ? "buffer" : "utf8",
        ...options.exec,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        if (error && !options.allowFail) {
          reject(
            new Error(
              `${command} ${argv.join(" ")} failed (${code}): ${String(stderr || stdout || error.message).slice(-800)}`,
            ),
          );
          return;
        }
        resolve({ code, stdout, stderr });
      },
    );
  });
}
const docker = (...argv) => run("docker", argv);
const dockerAllowFail = (...argv) => run("docker", argv, { allowFail: true });
const compose = (...argv) =>
  run("docker", ["compose", "-p", PROJECT, ...argv], { exec: { cwd: DIRS.project } });
const composeAllowFail = (...argv) =>
  run("docker", ["compose", "-p", PROJECT, ...argv], {
    exec: { cwd: DIRS.project },
    allowFail: true,
  });

async function waitFor(description, predicate, { timeoutMs = 120_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await predicate();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
      );
    }
    await sleep(intervalMs);
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function envText() {
  const pw = randomBytes(12).toString("hex");
  const app = randomBytes(12).toString("hex");
  const provider = randomBytes(12).toString("hex");
  return [
    "# generated for the updater E2E (test values only)",
    `POSTGRES_PASSWORD=${pw}`,
    `DATABASE_MIGRATION_URL=postgres://restow:${pw}@postgres:5432/restow`,
    `DATABASE_URL=postgres://restow_app:${app}@postgres:5432/restow`,
    `DATABASE_PROVIDER_URL=postgres://restow_provider:${provider}@postgres:5432/restow`,
    `RESTOW_MASTER_KEY=${randomBytes(32).toString("base64")}`,
    `BETTER_AUTH_SECRET=${randomBytes(24).toString("hex")}`,
    "RESTOW_APP_DOMAIN=localhost",
    `RESTOW_PROJECT_DIR=${DIRS.project}`,
    `RESTOW_IMPORT_DIR=${path.join(DIRS.project, "import")}`,
    "",
    "# image references the updater rewrites",
    `RESTOW_IMAGE=${BASE_APP}`,
    `RESTOW_WEB_IMAGE=${BASE_WEB}`,
    "# the updater's own image: pinned on its own, never rewritten by the updater",
    `RESTOW_UPDATER_IMAGE=${BASE_APP}`,
    "",
  ].join("\n");
}

function overrideText() {
  return `# Ports far away from the defaults, and the test settings of the updater.
services:
  postgres:
    ports: !override
      - "127.0.0.1:${PORT.postgres}:5432"
  api:
    ports: !override
      - "127.0.0.1:${PORT.api}:3000"
  caddy:
    ports: !override
      - "127.0.0.1:${PORT.http}:80"
      - "127.0.0.1:${PORT.https}:443"
  updater:
    environment:
      RESTOW_UPDATER_IMAGE_REPOSITORY: ${REGISTRY}/restow
      RESTOW_UPDATER_WEB_IMAGE_REPOSITORY: ${REGISTRY}/restow-web
      RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS: "90"
      # Locally built test releases carry no signature of the release workflow; the digests
      # are still required and checked.
      RESTOW_UPDATER_VERIFY_SIGNATURES: "false"
    ports:
      - "127.0.0.1:${PORT.updater}:8090"
`;
}

async function updaterApi(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT.updater}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const state = async (refresh = true) =>
  (await updaterApi("GET", refresh ? "/v1/state?refresh=1" : "/v1/state")).json;

async function apiReadyz(authenticated) {
  const response = await fetch(`http://127.0.0.1:${PORT.api}/readyz`, {
    headers: authenticated ? { Authorization: `Bearer ${secret}` } : {},
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function apiVersion() {
  const { body } = await apiReadyz(true);
  // /readyz is `ready` once the worker and the scheduler have reported in; right after an
  // update they may not have, and the api itself is what reports the version.
  return body?.checks?.database === true ? (body.version ?? null) : null;
}

async function psql(sql, db = "restow") {
  const result = await compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "restow",
    "-d",
    db,
    "-Atc",
    sql,
  );
  return result.stdout.trim();
}

async function containers() {
  const ps = await compose("ps", "-a", "--format", "json");
  const text = ps.stdout.trim();
  let entries;
  try {
    const parsed = JSON.parse(text);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return Object.fromEntries(
    entries.map((entry) => [
      entry.Service,
      { id: entry.ID, image: entry.Image, state: entry.State },
    ]),
  );
}

function pipeInto(argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "-p", PROJECT, ...argv], {
      cwd: DIRS.project,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${argv.join(" ")} failed (${code}): ${stderr.slice(-400)}`)),
    );
    child.stdin.end(input);
  });
}

async function pushTag(source, target) {
  await docker("tag", source, target);
  const push = await docker("push", target);
  const digest = /digest: (sha256:[0-9a-f]{64})/.exec(push.stdout)?.[1];
  assert(digest, `no digest for ${target}`);
  await docker("rmi", target);
  return digest;
}

async function setup() {
  for (const [name, port] of Object.entries(PORT)) {
    assert(
      await portIsFree(port),
      `port ${port} (${name}) is in use (run --cleanup if it is a leftover)`,
    );
  }
  const existing = await docker(
    "ps",
    "-a",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
    "--format",
    "{{.Names}}",
  );
  assert(
    existing.stdout.trim() === "",
    "containers of the genuine project exist: run --cleanup first",
  );
  for (const line of (
    await docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")
  ).stdout.split("\n")) {
    if (line.trim()) {
      pulledBefore.add(line.trim());
    }
  }
  assert(
    pulledBefore.has(BASE_APP),
    `${BASE_APP} is missing: docker build --target runtime --build-arg RESTOW_VERSION=0.1.0-test1 -t ${BASE_APP} .`,
  );

  log("building the second version and the web images from the same sources");
  await run(
    "docker",
    [
      "build",
      "--target",
      "runtime",
      "--build-arg",
      "RESTOW_VERSION=0.1.0-test2",
      "-t",
      "restow:0.1.0-test2",
      ".",
    ],
    { exec: { cwd: REPO } },
  );
  for (const version of ["0.1.0-test1", "0.1.0-test2"]) {
    await run("docker", ["build", "--target", "web", "-t", `restow-web:${version}`, "."], {
      exec: { cwd: REPO },
    });
  }

  log("registry and release images");
  await docker(
    "run",
    "-d",
    "--name",
    REGISTRY_CONTAINER,
    "-p",
    `127.0.0.1:${PORT.registry}:5000`,
    "registry:2",
  );
  await waitFor(
    "the registry",
    async () => (await fetch(`http://127.0.0.1:${PORT.registry}/v2/`)).ok,
    { timeoutMs: 30_000 },
  );
  const digests = {
    app: await pushTag("restow:0.1.0-test2", `${REGISTRY}/restow:0.1.0-test2`),
    web: await pushTag("restow-web:0.1.0-test2", `${REGISTRY}/restow-web:0.1.0-test2`),
  };
  // A release whose api cannot start: same image, entrypoint that exits at once.
  const brokenDir = path.join(WORK, "broken");
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(
    path.join(brokenDir, "Dockerfile"),
    'FROM restow:0.1.0-test2\nENV RESTOW_VERSION=0.1.0-test3\nENTRYPOINT ["/bin/sh", "-c", "echo broken release >&2; exit 3"]\n',
  );
  await docker("build", "-q", "-t", `${REGISTRY}/restow:0.1.0-test3`, brokenDir);
  const broken = await pushTag(`${REGISTRY}/restow:0.1.0-test3`, `${REGISTRY}/restow:0.1.0-test3`);

  log("starting the real compose project");
  await fs.mkdir(path.join(DIRS.project, "import"), { recursive: true });
  await fs.mkdir(path.join(DIRS.project, "deploy", "caddy-sites"), { recursive: true });
  await fs.copyFile(
    path.join(REPO, "docker-compose.yml"),
    path.join(DIRS.project, "docker-compose.yml"),
  );
  await fs.writeFile(ENV_FILE, envText(), { mode: 0o600 });
  await fs.writeFile(path.join(DIRS.project, "docker-compose.override.yml"), overrideText());
  await compose("up", "-d", "--no-build", "postgres", "api", "worker", "scheduler", "caddy");
  await waitFor(
    "the genuine api",
    async () => (await fetch(`http://127.0.0.1:${PORT.api}/healthz`)).ok,
    { timeoutMs: 180_000, intervalMs: 2000 },
  );
  await waitFor("the api to be ready", async () => (await apiReadyz(false)).status === 200, {
    timeoutMs: 120_000,
    intervalMs: 2000,
  });

  log("starting the updater service of the real file (ROLE=updater of the genuine image)");
  await compose("--profile", "updater", "up", "-d", "--no-build", "--no-deps", "updater");
  await waitFor(
    "the updater",
    async () => (await fetch(`http://127.0.0.1:${PORT.updater}/healthz`)).ok,
    { timeoutMs: 90_000 },
  );
  secret = (await compose("exec", "-T", "updater", "cat", "/updater-shared/secret")).stdout.trim();
  assert.match(secret, /^[0-9a-f]{64}$/);
  await waitFor(
    "the updater to report itself ready",
    async () => (await state()).capabilities.ready,
    { timeoutMs: 240_000, intervalMs: 2000 },
  );
  return { digests, broken };
}

const results = [];
async function scenario(name, fn) {
  const started = Date.now();
  log(`--- ${name}`);
  try {
    await fn();
    results.push({ name, ok: true, seconds: Math.round((Date.now() - started) / 1000) });
    log(`PASS ${name}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      seconds: Math.round((Date.now() - started) / 1000),
      error: error.message,
    });
    log(`FAIL ${name}: ${error.message}`);
    try {
      console.log(JSON.stringify((await state()).run, null, 2));
    } catch {
      // ignore
    }
  }
}

async function waitTerminal(timeoutMs = 360_000) {
  return await waitFor(
    "the run to finish",
    async () => {
      const current = await state(false);
      return current.phase === "succeeded" || current.phase === "failed" ? await state() : null;
    },
    { timeoutMs, intervalMs: 2000 },
  );
}

function scheduleBody(version, digests) {
  return {
    release: { version, tag: `v${version}`, url: null, prerelease: true, digests },
    mode: "image",
    source: null,
    leadSeconds: 0,
    requestedBy: { userId: "e2e", label: "e2e@example.com", ip: "127.0.0.1" },
  };
}

async function main() {
  if (flag("cleanup")) {
    await cleanup();
    return;
  }
  let released;
  try {
    released = await setup();
  } catch (error) {
    console.error(`SETUP FAILED: ${error.stack ?? error.message}`);
    await cleanup();
    process.exit(2);
  }
  const originalEnv = await fs.readFile(ENV_FILE, "utf8");

  await scenario("the genuine api answers the updater", async () => {
    // Unauthenticated callers get no version; the shared secret gets it: this is what the updater relies on.
    const anonymous = await apiReadyz(false);
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.body.version, undefined);
    assert.equal(await apiVersion(), "0.1.0-test1");
    const current = await state();
    assert.equal(current.capabilities.ready, true, JSON.stringify(current.capabilities.blockers));
    assert.equal(current.capabilities.runner, "helper");
    assert.equal(current.updaterVersion, "0.1.0-test1");
    assert.equal(current.capabilities.composeFile, "docker-compose.yml");
  });

  await scenario(
    "update 0.1.0-test1 to 0.1.0-test2 with the real compose file and override",
    async () => {
      const before = await containers();
      const migrationsBefore = Number(
        await psql("SELECT count(*) FROM drizzle.__drizzle_migrations"),
      );
      assert(migrationsBefore > 0, "the genuine api applied its migrations");
      await psql(
        "CREATE TABLE IF NOT EXISTS public.updater_canary (id serial primary key, note text)",
      );
      await psql(
        "INSERT INTO public.updater_canary (note) SELECT 'row ' || g FROM generate_series(1, 5) g",
      );

      const started = Date.now();
      const scheduled = await updaterApi(
        "POST",
        "/v1/schedule",
        scheduleBody("0.1.0-test2", released.digests),
      );
      assert.equal(scheduled.status, 202, JSON.stringify(scheduled.json));
      const final = await waitTerminal();
      log(`update took ${Math.round((Date.now() - started) / 1000)}s`);
      assert.equal(final.phase, "succeeded", JSON.stringify(final.run?.failure));
      assert.equal(final.run.digestVerified, true);
      assert.equal(final.run.fromVersion, "0.1.0-test1");
      assert.deepEqual(
        final.run.steps.map((step) => step.status),
        Array(7).fill("done"),
      );

      const after = await containers();
      for (const service of ["api", "worker", "scheduler"]) {
        assert.equal(after[service].image, `${REGISTRY}/restow:0.1.0-test2`, `${service} image`);
        assert.equal(after[service].state, "running");
        assert.notEqual(after[service].id, before[service].id);
      }
      assert.equal(after.caddy.image, `${REGISTRY}/restow-web:0.1.0-test2`);
      assert.equal(after.postgres.id, before.postgres.id, "postgres was not touched");
      assert.equal(after.updater.id, before.updater.id, "the updater does not replace itself");
      assert.equal(
        await apiVersion(),
        "0.1.0-test2",
        "the genuine new api reports its version to the updater",
      );

      const env = await fs.readFile(ENV_FILE, "utf8");
      assert.equal(
        env,
        originalEnv
          .replace(`RESTOW_IMAGE=${BASE_APP}`, `RESTOW_IMAGE=${REGISTRY}/restow:0.1.0-test2`)
          .replace(
            `RESTOW_WEB_IMAGE=${BASE_WEB}`,
            `RESTOW_WEB_IMAGE=${REGISTRY}/restow-web:0.1.0-test2`,
          ),
      );
      assert.equal(
        Number(await psql("SELECT count(*) FROM drizzle.__drizzle_migrations")),
        migrationsBefore,
      );

      // The real pg_dump of the real schema restores.
      const dump = final.capabilities.dumps[0];
      assert(dump && dump.bytes > 5000, JSON.stringify(dump));
      const bytes = (
        await run(
          "docker",
          ["compose", "-p", PROJECT, "exec", "-T", "updater", "cat", `/state/dumps/${dump.file}`],
          { buffer: true, exec: { cwd: DIRS.project } },
        )
      ).stdout;
      await compose("exec", "-T", "postgres", "createdb", "-U", "restow", "scratch_e2e");
      try {
        await pipeInto(
          [
            "exec",
            "-T",
            "postgres",
            "pg_restore",
            "-U",
            "restow",
            "-d",
            "scratch_e2e",
            "--no-owner",
          ],
          bytes,
        );
        assert.equal(
          Number(await psql("SELECT count(*) FROM public.updater_canary", "scratch_e2e")),
          5,
        );
        assert.equal(
          Number(await psql("SELECT count(*) FROM drizzle.__drizzle_migrations", "scratch_e2e")),
          migrationsBefore,
        );
      } finally {
        await compose(
          "exec",
          "-T",
          "postgres",
          "dropdb",
          "-U",
          "restow",
          "--if-exists",
          "scratch_e2e",
        );
      }
      await updaterApi("POST", "/v1/acknowledge", {});
    },
  );

  await scenario("a release whose api cannot start is rolled back", async () => {
    const before = await fs.readFile(ENV_FILE, "utf8");
    const started = Date.now();
    const scheduled = await updaterApi(
      "POST",
      "/v1/schedule",
      scheduleBody("0.1.0-test3", { app: released.broken }),
    );
    assert.equal(scheduled.status, 202, JSON.stringify(scheduled.json));
    const final = await waitTerminal();
    assert.equal(final.run.outcome, "rolled_back", JSON.stringify(final.run.failure));
    assert.equal(final.run.failure.code, "health.crashed");
    assert.equal(final.run.failure.migrationsRan, false);
    assert.equal(await fs.readFile(ENV_FILE, "utf8"), before, ".env restored byte for byte");
    const after = await containers();
    assert.equal(after.api.image, `${REGISTRY}/restow:0.1.0-test2`);
    assert.equal(after.api.state, "running");
    assert.equal(await apiVersion(), "0.1.0-test2");
    log(`rollback took ${Math.round((Date.now() - started) / 1000)}s`);
    await updaterApi("POST", "/v1/acknowledge", {});
  });

  await cleanup();
  console.log("\n=== genuine image E2E summary ===");
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"}  ${result.name}  (${result.seconds}s)${result.ok ? "" : `\n      ${result.error}`}`,
    );
  }
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
}

async function cleanup() {
  if (flag("keep")) {
    log("--keep: leaving everything in place");
    return;
  }
  log("cleaning up");
  if ((await fs.stat(path.join(DIRS.project, "docker-compose.yml")).catch(() => null)) !== null) {
    await composeAllowFail(
      "--profile",
      "updater",
      "down",
      "-v",
      "--remove-orphans",
      "--timeout",
      "5",
    );
  }
  await dockerAllowFail("rm", "-fv", REGISTRY_CONTAINER);
  for (const tag of MY_TAGS) {
    await dockerAllowFail("rmi", tag);
  }
  for (const image of ["registry:2", "docker:27-cli"]) {
    if (pulledBefore.size > 0 && !pulledBefore.has(image)) {
      await dockerAllowFail("rmi", image);
    }
  }
  await fs.rm(WORK, { recursive: true, force: true });
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

main().catch(async (error) => {
  console.error(error.stack ?? error.message);
  await cleanup().catch(() => undefined);
  process.exit(2);
});
