#!/usr/bin/env node
/**
 * End-to-end proof of the Restow updater against a REAL Docker daemon.
 *
 * A scratch compose project (real postgres, stub api/worker/scheduler/edge images, a
 * local registry) is updated by the real updater process through its HTTP API, exactly
 * as the api does it. Nothing in the updater is faked: real `docker pull`, real
 * `pg_dump`, real `docker compose up`, real rollback. What is stubbed is the
 * application inside the images (see stub/), not the updater and not Docker.
 *
 *   node scripts/updater-e2e/run.mjs [--mode local|container] [--only a,b] [--keep] [--cleanup]
 *
 * See README.md for what this proves and what it does not.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const API_DIR = path.join(REPO, "apps", "api");
const STUB_DIR = path.join(REPO, "scripts", "updater-e2e", "stub");
/** Everything this script creates on disk lives here (colima only shares /Users into its VM). */
const WORK = path.join(os.homedir(), ".restow-e2e", "updater-e2e");
const PROJECT = "restow-updater-e2e";
const PORT = { registry: 55501, api: 55512, edge: 55513, updater: 55514 };
const REGISTRY = `localhost:${PORT.registry}`;
const REGISTRY_CONTAINER = `${PROJECT}-registry`;
const APP_REPO = `${REGISTRY}/e2e-app`;
const WEB_REPO = `${REGISTRY}/e2e-web`;
const UPDATER_IMAGE = "e2e-updater:local";
const STATE_VOLUME = `${PROJECT}_updater-state`;
const SERVICES = ["postgres", "api", "worker", "scheduler", "caddy"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const MODE = option("mode", "local");
const ONLY = option("only", null)?.split(",") ?? null;
assert(["local", "container"].includes(MODE), "--mode must be local or container");

const DIRS = {
  project: path.join(WORK, "project"),
  state: path.join(WORK, "state"),
  shared: path.join(WORK, "shared"),
  build: path.join(WORK, "build"),
};
const ENV_FILE = path.join(DIRS.project, ".env");
const POSTGRES_PASSWORD = randomBytes(12).toString("hex");

/** Versions of the stub app image: how each behaves. */
const APP_VERSIONS = {
  "1.0.0": { mode: "ready", migrate: 0 },
  "2.0.0": { mode: "ready", migrate: 1 },
  "2.1.0": { mode: "never", migrate: 0 },
  "2.2.0": { mode: "crash", migrate: 0 },
  "2.3.0": { mode: "ready", migrate: 0 },
  "3.0.0": { mode: "never", migrate: 1 },
  "3.1.0": { mode: "never", migrate: 0 },
};
/** Versions of the stub web image that are published (2.3.0 deliberately is not). */
const WEB_VERSIONS = ["1.0.0", "2.0.0", "2.1.0", "2.2.0", "3.0.0", "3.1.0"];

const digests = new Map();
/**
 * The stub images in the local registry carry no signature of the release workflow (that
 * needs GitHub's OIDC and Sigstore), so the run switches the check off, except for the
 * scenario that proves an unsigned release is refused.
 */
let verifySignatures = false;
let secret = "";
let updaterProcess = null;
const created = { images: new Set(), pulledBefore: new Set() };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
              `${command} ${argv.join(" ")} failed (${code}): ${String(stderr || stdout || error.message).slice(-600)}`,
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

async function waitFor(description, predicate, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
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

function log(message) {
  console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function ensureClean() {
  for (const [name, port] of Object.entries(PORT)) {
    assert(
      await portIsFree(port),
      `Port ${port} (${name}) is in use. Run with --cleanup if it is a leftover of this script.`,
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
    `Containers of the ${PROJECT} project exist: run with --cleanup first.`,
  );
  const registry = await docker(
    "ps",
    "-a",
    "--filter",
    `name=^${REGISTRY_CONTAINER}$`,
    "--format",
    "{{.Names}}",
  );
  assert(registry.stdout.trim() === "", `${REGISTRY_CONTAINER} exists: run with --cleanup first.`);
}

async function rememberImages() {
  const list = await docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}");
  for (const line of list.stdout.split("\n")) {
    if (line.trim()) {
      created.pulledBefore.add(line.trim());
    }
  }
}

function envText() {
  return [
    "# Restow updater E2E project (generated; safe to delete)",
    "POSTGRES_USER=restow",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "POSTGRES_DB=restow",
    "",
    "# image references the updater rewrites",
    `RESTOW_IMAGE=${APP_REPO}:1.0.0`,
    "# keep this comment where it is",
    `RESTOW_WEB_IMAGE=${WEB_REPO}:1.0.0`,
    "SOME_OTHER_SETTING=untouched",
    "",
  ].join("\n");
}

function composeText() {
  return `name: ${PROJECT}
x-app: &app
  image: \${RESTOW_IMAGE:-${APP_REPO}:1.0.0}
  env_file:
    - .env
  # The stub is a shell script as PID 1: without an init it would ignore SIGTERM (as the real image's node does not).
  init: true
  # The stub image inherits the postgres image's data VOLUME; a tmpfs keeps it from leaving anonymous volumes behind.
  tmpfs:
    - /var/lib/postgresql/data
  volumes:
    - ${DIRS.shared}:/updater-shared:ro
  depends_on:
    postgres:
      condition: service_healthy
  restart: unless-stopped

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-restow}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: \${POSTGRES_DB:-restow}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-restow} -d \${POSTGRES_DB:-restow}"]
      interval: 3s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  api:
    <<: *app
    environment:
      ROLE: api
    ports:
      - "127.0.0.1:${PORT.api}:3000"

  worker:
    <<: *app
    environment:
      ROLE: worker

  scheduler:
    <<: *app
    environment:
      ROLE: scheduler

  caddy:
    image: \${RESTOW_WEB_IMAGE:-${WEB_REPO}:1.0.0}
    init: true
    ports:
      - "127.0.0.1:${PORT.edge}:8080"
    depends_on:
      - api
    restart: unless-stopped

  updater:
    profiles: ["updater"]
    image: ${UPDATER_IMAGE}
    environment:
      ROLE: updater
      RESTOW_UPDATER_PROJECT_DIR: ${DIRS.project}
      RESTOW_UPDATER_API_URL: http://api:3000
      RESTOW_UPDATER_IMAGE_REPOSITORY: ${APP_REPO}
      RESTOW_UPDATER_WEB_IMAGE_REPOSITORY: ${WEB_REPO}
      RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS: "30"
      RESTOW_UPDATER_MIN_FREE_MB: "100"
      RESTOW_UPDATER_VERIFY_SIGNATURES: \${E2E_VERIFY_SIGNATURES:-false}
      RESTOW_VERSION: e2e-container
    ports:
      - "127.0.0.1:${PORT.updater}:8090"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${DIRS.project}:${DIRS.project}
      - updater-state:/state
      - ${DIRS.shared}:/updater-shared
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped

volumes:
  pgdata:
  updater-state:
`;
}

async function startRegistry() {
  await docker(
    "run",
    "-d",
    "--name",
    REGISTRY_CONTAINER,
    "--label",
    "restow-updater-e2e=1",
    "-p",
    `127.0.0.1:${PORT.registry}:5000`,
    "registry:2",
  );
  await waitFor(
    "the registry",
    async () => (await fetch(`http://127.0.0.1:${PORT.registry}/v2/`)).ok,
    { timeoutMs: 30_000 },
  );
}

async function buildAndPushImages() {
  for (const [version, behaviour] of Object.entries(APP_VERSIONS)) {
    const tag = `${APP_REPO}:${version}`;
    await docker(
      "build",
      "-q",
      "-t",
      tag,
      "-f",
      path.join(STUB_DIR, "Dockerfile"),
      "--build-arg",
      `STUB_VERSION=${version}`,
      "--build-arg",
      `STUB_MODE=${behaviour.mode}`,
      "--build-arg",
      `STUB_MIGRATE=${behaviour.migrate}`,
      STUB_DIR,
    );
    created.images.add(tag);
    const push = await docker("push", tag);
    const digest = /digest: (sha256:[0-9a-f]{64})/.exec(push.stdout)?.[1];
    assert(digest, `no digest in the push output for ${tag}`);
    digests.set(tag, digest);
    // Only 1.0.0 stays on this machine: it runs. Every later version must be pulled by the updater.
    if (version !== "1.0.0") {
      await docker("rmi", tag);
    }
  }
  for (const version of WEB_VERSIONS) {
    const tag = `${WEB_REPO}:${version}`;
    await docker(
      "build",
      "-q",
      "-t",
      tag,
      "--build-arg",
      `STUB_VERSION=${version}`,
      path.join(STUB_DIR, "web"),
    );
    created.images.add(tag);
    const push = await docker("push", tag);
    digests.set(tag, /digest: (sha256:[0-9a-f]{64})/.exec(push.stdout)?.[1]);
    if (version !== "1.0.0") {
      await docker("rmi", tag);
    }
  }
}

function updaterEnv() {
  return {
    RESTOW_UPDATER_PORT: String(PORT.updater),
    RESTOW_UPDATER_STATE_DIR: DIRS.state,
    RESTOW_UPDATER_SHARED_DIR: DIRS.shared,
    RESTOW_UPDATER_PROJECT_DIR: DIRS.project,
    RESTOW_UPDATER_PROJECT_NAME: PROJECT,
    RESTOW_UPDATER_API_URL: `http://127.0.0.1:${PORT.api}`,
    RESTOW_UPDATER_IMAGE_REPOSITORY: APP_REPO,
    RESTOW_UPDATER_WEB_IMAGE_REPOSITORY: WEB_REPO,
    RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS: "30",
    RESTOW_UPDATER_MIN_FREE_MB: "100",
    RESTOW_UPDATER_VERIFY_SIGNATURES: verifySignatures ? "true" : "false",
    RESTOW_VERSION: "e2e-local",
  };
}

async function startUpdater() {
  if (MODE === "local") {
    const logFile = fsSync.openSync(path.join(WORK, "updater.log"), "a");
    // One process (no tsx wrapper), so that a kill really ends the updater.
    updaterProcess = spawn(process.execPath, ["--import", "tsx", "src/updater/main.ts"], {
      cwd: API_DIR,
      env: { PATH: process.env.PATH, HOME: os.homedir(), ...updaterEnv() },
      stdio: ["ignore", logFile, logFile],
    });
    updaterProcess.once("exit", () => {
      updaterProcess = null;
    });
  } else {
    process.env.E2E_VERIFY_SIGNATURES = verifySignatures ? "true" : "false";
    await compose("--profile", "updater", "up", "-d", "--no-deps", "updater");
  }
  await waitFor(
    "the updater to answer /healthz",
    async () => (await fetch(`http://127.0.0.1:${PORT.updater}/healthz`)).ok,
    { timeoutMs: 60_000 },
  );
  secret = (await fs.readFile(path.join(DIRS.shared, "secret"), "utf8")).trim();
  assert.match(secret, /^[0-9a-f]{64}$/);
}

async function killUpdater() {
  if (MODE === "local") {
    updaterProcess?.kill("SIGKILL");
    await waitFor("the updater to exit", () => updaterProcess === null, {
      timeoutMs: 10_000,
      intervalMs: 100,
    });
  } else {
    await docker("kill", `${PROJECT}-updater-1`);
  }
}

async function buildUpdaterImage() {
  // Compile only the updater's own sources (exactly what the published image runs) and put them,
  // with their three runtime packages, on node:22-slim: the same base as the Restow image, no docker CLI.
  const out = path.join(DIRS.build, "dist");
  await fs.rm(DIRS.build, { recursive: true, force: true });
  await fs.mkdir(DIRS.build, { recursive: true });
  const tsconfig = path.join(DIRS.build, "tsconfig.json");
  await fs.writeFile(
    tsconfig,
    JSON.stringify({
      extends: path.join(API_DIR, "tsconfig.json"),
      compilerOptions: {
        outDir: out,
        rootDir: path.join(API_DIR, "src", "updater"),
        noEmit: false,
        typeRoots: [
          path.join(REPO, "node_modules", "@types"),
          path.join(API_DIR, "node_modules", "@types"),
        ],
        declaration: false,
        sourceMap: false,
      },
      include: [path.join(API_DIR, "src", "updater", "*.ts")],
      exclude: ["**/*.test.ts", "**/testing.ts", "**/fake-engine-api.ts"],
    }),
  );
  await run(path.join(REPO, "node_modules", ".bin", "tsc"), ["-p", tsconfig], {
    exec: { cwd: API_DIR },
  });
  const modules = path.join(DIRS.build, "node_modules");
  for (const pkg of ["zod", "hono", "@hono/node-server"]) {
    const from = await fs.realpath(path.join(API_DIR, "node_modules", pkg));
    await fs.mkdir(path.dirname(path.join(modules, pkg)), { recursive: true });
    await fs.cp(from, path.join(modules, pkg), { recursive: true });
  }
  await fs.writeFile(path.join(DIRS.build, "package.json"), JSON.stringify({ type: "module" }));
  await fs.writeFile(
    path.join(DIRS.build, "Dockerfile"),
    [
      "FROM node:22-slim",
      "WORKDIR /app",
      "COPY package.json ./",
      "COPY node_modules ./node_modules",
      "COPY dist ./dist",
      'CMD ["node", "/app/dist/main.js"]',
      "",
    ].join("\n"),
  );
  await docker("build", "-q", "-t", UPDATER_IMAGE, DIRS.build);
  created.images.add(UPDATER_IMAGE);
}

async function psql(sql, { db = "restow" } = {}) {
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

async function setupDatabase() {
  await compose("up", "-d", "postgres");
  // Over TCP: the temporary server the image's first-start initialisation runs listens on the
  // socket only, and stops again right after, so a socket check can pass too early.
  await waitFor(
    "postgres",
    async () =>
      (
        await composeAllowFail(
          "exec",
          "-T",
          "postgres",
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "restow",
          "-d",
          "restow",
        )
      ).code === 0,
    { timeoutMs: 90_000 },
  );
  await psql("CREATE SCHEMA IF NOT EXISTS drizzle");
  await psql(
    "CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  await psql(
    "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) SELECT 'baseline-' || g, g FROM generate_series(1, 12) g",
  );
  await psql(
    "CREATE TABLE IF NOT EXISTS public.canary (id SERIAL PRIMARY KEY, note text NOT NULL)",
  );
  await psql("INSERT INTO public.canary (note) SELECT 'row ' || g FROM generate_series(1, 7) g");
}

async function apiVersion() {
  // What the updater asks the api: /readyz with the shared secret.
  const response = await fetch(`http://127.0.0.1:${PORT.api}/readyz`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    return null;
  }
  const body = await response.json();
  return body.status === "ready" ? (body.version ?? null) : null;
}

async function setup() {
  await ensureClean();
  await rememberImages();
  await fs.rm(WORK, { recursive: true, force: true });
  for (const dir of [DIRS.project, DIRS.state, DIRS.shared]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(ENV_FILE, envText(), { mode: 0o600 });
  await fs.writeFile(path.join(DIRS.project, "docker-compose.yml"), composeText());
  log("starting the local registry and building the stub images");
  await startRegistry();
  await buildAndPushImages();
  if (MODE === "container") {
    log("building the updater image");
    await buildUpdaterImage();
  }
  log(`starting the updater (${MODE} mode)`);
  await startUpdater();
  log("starting the project");
  await setupDatabase();
  await compose("up", "-d", "--no-deps", "api", "worker", "scheduler", "caddy");
  await waitFor("the baseline api (1.0.0)", async () => (await apiVersion()) === "1.0.0", {
    timeoutMs: 60_000,
  });
  // The helper runner pulls its CLI image in the background: until then the updater says so and refuses to schedule.
  await waitFor(
    "the updater to report itself ready",
    async () => (await state()).capabilities.ready,
    {
      timeoutMs: 240_000,
      intervalMs: 2000,
    },
  );
}

// ---------------------------------------------------------------------------
// The updater's HTTP API (as the api uses it)
// ---------------------------------------------------------------------------

async function updaterApi(method, route, { body, auth = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT.updater}${route}`, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${secret}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

/**
 * A release publishes the registry digests of its images (release.yml); `null` leaves one
 * out, a value overrides it.
 */
function scheduleBody(version, { digestApp, digestWeb, leadSeconds = 0 } = {}) {
  if (digestApp === undefined) {
    digestApp = digests.get(`${APP_REPO}:${version}`) ?? `sha256:${"9".repeat(64)}`;
  }
  if (digestWeb === undefined) {
    digestWeb = digests.get(`${WEB_REPO}:${version}`);
  }
  return {
    release: {
      version,
      tag: `v${version}`,
      url: null,
      prerelease: false,
      digests: {
        ...(digestApp ? { app: digestApp } : {}),
        ...(digestWeb ? { web: digestWeb } : {}),
      },
    },
    mode: "image",
    source: null,
    leadSeconds,
    requestedBy: { userId: "e2e", label: "e2e@example.com", ip: "127.0.0.1" },
  };
}

async function state(refresh = true) {
  const { status, json } = await updaterApi("GET", refresh ? "/v1/state?refresh=1" : "/v1/state");
  assert.equal(status, 200);
  return json;
}

async function waitTerminal(timeoutMs = 240_000) {
  return await waitFor(
    "the run to finish",
    async () => {
      const current = await state(false);
      if (current.phase !== "succeeded" && current.phase !== "failed") {
        return null;
      }
      return await state();
    },
    { timeoutMs, intervalMs: 1000 },
  );
}

async function acknowledge() {
  const { status } = await updaterApi("POST", "/v1/acknowledge", { body: {} });
  assert.equal(status, 200);
}

async function schedule(version, options) {
  const { status, json } = await updaterApi("POST", "/v1/schedule", {
    body: scheduleBody(version, options),
  });
  assert.equal(status, 202, `schedule ${version}: ${JSON.stringify(json)}`);
  return json;
}

// ---------------------------------------------------------------------------
// Observations of the real world
// ---------------------------------------------------------------------------

async function snapshot() {
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
  const containers = {};
  for (const entry of entries) {
    if (SERVICES.includes(entry.Service)) {
      containers[entry.Service] = { id: entry.ID, image: entry.Image, state: entry.State };
    }
  }
  return {
    containers,
    env: await fs.readFile(ENV_FILE, "utf8"),
    migrations: Number(await psql("SELECT count(*) FROM drizzle.__drizzle_migrations")),
    canary: Number(await psql("SELECT count(*) FROM public.canary")),
  };
}

async function readDump(file) {
  if (MODE === "local") {
    return await fs.readFile(path.join(DIRS.state, "dumps", file));
  }
  const result = await run(
    "docker",
    ["run", "--rm", "-v", `${STATE_VOLUME}:/state:ro`, "alpine:3", "cat", `/state/dumps/${file}`],
    { buffer: true },
  );
  return result.stdout;
}

function pipeInto(command, argv, input, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${argv.join(" ")} failed (${code}): ${stderr.slice(-400)}`)),
    );
    child.stdin.end(input);
  });
}

/** Restore a dump into a scratch database of the real postgres and report what is in it. */
async function restoreIntoScratch(file) {
  const bytes = await readDump(file);
  assert(bytes.length > 1000, `dump ${file} is suspiciously small (${bytes.length} bytes)`);
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "PGDMP");
  await compose("exec", "-T", "postgres", "createdb", "-U", "restow", "scratch_e2e");
  try {
    await pipeInto(
      "docker",
      [
        "compose",
        "-p",
        PROJECT,
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
      DIRS.project,
    );
    return {
      canary: Number(await psql("SELECT count(*) FROM public.canary", { db: "scratch_e2e" })),
      migrations: Number(
        await psql("SELECT count(*) FROM drizzle.__drizzle_migrations", { db: "scratch_e2e" }),
      ),
    };
  } finally {
    await compose("exec", "-T", "postgres", "dropdb", "-U", "restow", "--if-exists", "scratch_e2e");
  }
}

function expectedEnv(original, app, web) {
  let text = original.replace(/^RESTOW_IMAGE=.*$/m, `RESTOW_IMAGE=${app}`);
  if (web) {
    text = text.replace(/^RESTOW_WEB_IMAGE=.*$/m, `RESTOW_WEB_IMAGE=${web}`);
  }
  return text;
}

async function forceBaseline(version) {
  // Operator-style reset between scenarios: image variables back, services recreated.
  const app = `${APP_REPO}:${version}`;
  let text = await fs.readFile(ENV_FILE, "utf8");
  text = text.replace(/^RESTOW_IMAGE=.*$/m, `RESTOW_IMAGE=${app}`);
  await fs.writeFile(ENV_FILE, text);
  await compose("up", "-d", "--no-deps", "--force-recreate", "api", "worker", "scheduler");
  await waitFor(`api ${version}`, async () => (await apiVersion()) === version, {
    timeoutMs: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const results = [];

async function scenario(name, fn) {
  if (ONLY && !ONLY.includes(name)) {
    return;
  }
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

const same = (before, after, services) => {
  for (const service of services) {
    assert.deepEqual(
      after.containers[service],
      before.containers[service],
      `${service} was touched`,
    );
  }
};

async function main() {
  if (flag("cleanup")) {
    await cleanup();
    return;
  }
  try {
    await setup();
  } catch (error) {
    console.error(`SETUP FAILED: ${error.stack ?? error.message}`);
    await cleanup();
    process.exit(2);
  }

  const original = envText();
  let baselineVersion = "1.0.0";

  await scenario("authentication and public status", async () => {
    assert.equal((await updaterApi("GET", "/v1/state", { auth: false })).status, 401);
    const wrong = await fetch(`http://127.0.0.1:${PORT.updater}/v1/state`, {
      headers: { Authorization: `Bearer ${"0".repeat(64)}` },
    });
    assert.equal(wrong.status, 401);
    const state0 = await state();
    assert.equal(state0.phase, "idle");
    assert.equal(state0.capabilities.ready, true, JSON.stringify(state0.capabilities.blockers));
    assert.equal(state0.capabilities.runner, MODE === "container" ? "helper" : "cli");
    const pub = await updaterApi("GET", "/public/status", { auth: false });
    assert.equal(pub.status, 200);
    assert.equal(pub.json.phase, "idle");
    assert(!pub.text.includes(secret));
    assert.equal((await updaterApi("GET", "/healthz", { auth: false })).status, 200);
  });

  await scenario("an unsigned release or one without digest is not installed", async () => {
    const before = await snapshot();
    const unverifiable = await updaterApi("POST", "/v1/schedule", {
      body: scheduleBody("2.0.0", { digestApp: null }),
    });
    assert.equal(unverifiable.status, 422, unverifiable.text);
    assert.equal(unverifiable.json.code, "invalid_request");
    assert.match(unverifiable.json.message, /no image digest/);
    // With the signature check on (the default), the stubs have no signature of the release
    // workflow: cosign runs, finds none (or cannot reach the registry), and nothing is pulled.
    verifySignatures = true;
    await killUpdater();
    await startUpdater();
    try {
      await waitFor("the updater to be ready", async () => (await state()).capabilities.ready, {
        timeoutMs: 180_000,
        intervalMs: 2000,
      });
      await schedule("2.0.0");
      const final = await waitTerminal(600_000);
      assert.equal(final.run.outcome, "unchanged", JSON.stringify(final.run.failure));
      assert.equal(final.run.failure.code, "fetch.signature_invalid");
      assert.equal(final.run.signatureVerified, false);
      assert.match(final.run.failure.detail, /release\.yml@refs\/tags\/v2\.0\.0/);
      // (In this harness cosign cannot even reach the local registry from its own container,
      // so the check fails before it looks for a signature: it fails closed either way.)
      assert(
        final.run.log.some((line) => line.includes("Verifying the release signature")),
        final.run.log.join("\n"),
      );
      const after = await snapshot();
      same(before, after, SERVICES);
      assert.equal(after.env, before.env);
      assert.equal(
        (await dockerAllowFail("image", "inspect", `${APP_REPO}:2.0.0`)).code !== 0,
        true,
        "the unverified image was never pulled",
      );
      await acknowledge();
    } finally {
      verifySignatures = false;
      await killUpdater();
      await startUpdater();
    }
  });

  await scenario("cancel and busy", async () => {
    await schedule("2.0.0", { leadSeconds: 300 });
    const busy = await updaterApi("POST", "/v1/schedule", { body: scheduleBody("2.0.0") });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.code, "busy");
    const pub = await updaterApi("GET", "/public/status", { auth: false });
    assert.equal(pub.json.phase, "scheduled");
    // The public status names no version (signed-in users get it from the api).
    assert.equal(pub.json.targetVersion, undefined);
    assert.equal(pub.json.fromVersion, undefined);
    assert(!pub.text.includes("2.0.0"), pub.text);
    const cancelled = await updaterApi("POST", "/v1/cancel", { body: {} });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.phase, "idle");
    assert.equal(cancelled.json.history[0].cancelled, true);
    const again = await updaterApi("POST", "/v1/cancel", { body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "not_scheduled");
  });

  await scenario("success", async () => {
    const before = await snapshot();
    const started = Date.now();
    await schedule("2.0.0", {
      digestApp: digests.get(`${APP_REPO}:2.0.0`),
      digestWeb: digests.get(`${WEB_REPO}:2.0.0`),
    });
    const final = await waitTerminal();
    const seconds = Math.round((Date.now() - started) / 1000);
    assert.equal(final.phase, "succeeded", JSON.stringify(final.run?.failure));
    assert.equal(final.run.outcome, "succeeded");
    assert.equal(
      final.run.digestVerified,
      true,
      "the pulled images must match the digests the registry published",
    );
    // Switched off for the unsigned stubs, and recorded as such.
    assert.equal(final.run.signatureVerified, false);
    assert.equal(final.run.fromVersion, "1.0.0");
    assert.deepEqual(
      final.run.steps.map((s) => s.status),
      Array(7).fill("done"),
    );
    assert.equal(final.run.progress, 100);

    const after = await snapshot();
    for (const service of ["api", "worker", "scheduler"]) {
      assert.equal(after.containers[service].image, `${APP_REPO}:2.0.0`, `${service} image`);
      assert.equal(after.containers[service].state, "running");
      assert.notEqual(
        after.containers[service].id,
        before.containers[service].id,
        `${service} was recreated`,
      );
    }
    assert.equal(after.containers.caddy.image, `${WEB_REPO}:2.0.0`);
    assert.equal(after.containers.caddy.state, "running");
    same(before, after, ["postgres"]);
    assert.equal(
      after.env,
      expectedEnv(original, `${APP_REPO}:2.0.0`, `${WEB_REPO}:2.0.0`),
      ".env: only the two image lines change",
    );
    assert.equal(after.migrations, before.migrations + 1, "the new api migrated");
    assert.equal(await apiVersion(), "2.0.0");

    const dumps = final.capabilities.dumps;
    assert.equal(dumps.length, 1);
    const restored = await restoreIntoScratch(dumps[0].file);
    assert.equal(restored.canary, before.canary, "the dump restores the canary rows");
    assert.equal(
      restored.migrations,
      before.migrations,
      "the dump is the state before the migration",
    );

    const events = final.events.map((e) => e.action);
    assert(events.includes("update.started") && events.includes("update.succeeded"), events.join());
    const pub = await updaterApi("GET", "/public/status", { auth: false });
    assert.equal(pub.json.phase, "succeeded");
    assert.equal(pub.json.outcome, "succeeded");
    const timings = final.events
      .at(-1)
      .details.steps.map((step) => `${step.id} ${Math.round(step.durationMs / 1000)}s`);
    log(`success took ${seconds}s (${timings.join(", ")})`);
    await acknowledge();
    baselineVersion = "2.0.0";
  });

  await scenario("digest mismatch leaves everything untouched", async () => {
    const before = await snapshot();
    await schedule("2.1.0", { digestApp: `sha256:${"ab".repeat(32)}` });
    const final = await waitTerminal();
    assert.equal(final.run.outcome, "unchanged");
    assert.equal(final.run.failure.code, "fetch.digest_mismatch");
    assert.equal(final.run.digestVerified, false);
    const after = await snapshot();
    same(before, after, SERVICES);
    assert.equal(after.env, before.env);
    assert.equal(after.migrations, before.migrations);
    await acknowledge();
  });

  await scenario("pull failure (tag does not exist) leaves everything untouched", async () => {
    const before = await snapshot();
    await schedule("9.9.9");
    const final = await waitTerminal();
    assert.equal(final.run.outcome, "unchanged");
    assert.equal(final.run.failure.code, "fetch.pull_failed");
    assert.match(
      final.run.failure.detail,
      /not found|manifest unknown|does not exist|no such/i,
      final.run.failure.detail,
    );
    const after = await snapshot();
    same(before, after, SERVICES);
    assert.equal(after.env, before.env);
    assert.equal(
      final.capabilities.dumps.length,
      1,
      "no dump was taken for an update that never started",
    );
    await acknowledge();
  });

  await scenario("health failure before migrations: real rollback", async () => {
    const before = await snapshot();
    const started = Date.now();
    await schedule("2.1.0");
    const final = await waitTerminal();
    assert.equal(final.run.outcome, "rolled_back", JSON.stringify(final.run.failure));
    assert.equal(final.run.failure.code, "health.timeout");
    assert.equal(final.run.failure.migrationsRan, false);
    const after = await snapshot();
    assert.equal(after.env, before.env, ".env restored byte for byte");
    for (const service of ["api", "worker", "scheduler"]) {
      assert.equal(after.containers[service].image, `${APP_REPO}:2.0.0`);
      assert.equal(after.containers[service].state, "running");
    }
    assert.equal(after.containers.caddy.image, before.containers.caddy.image);
    assert.equal(after.migrations, before.migrations);
    assert.equal(await apiVersion(), "2.0.0", "the previous version answers again");
    assert(final.capabilities.dumps.length >= 2, "the dump of the failed attempt is kept");
    assert.equal(final.run.recovery, null);
    log(`rollback took ${Math.round((Date.now() - started) / 1000)}s`);
    await acknowledge();
  });

  await scenario("api crash loop fails fast and rolls back", async () => {
    const before = await snapshot();
    const started = Date.now();
    await schedule("2.2.0");
    const final = await waitTerminal();
    const seconds = (Date.now() - started) / 1000;
    assert.equal(final.run.outcome, "rolled_back", JSON.stringify(final.run.failure));
    assert.equal(final.run.failure.code, "health.crashed");
    assert(seconds < 25, `fail-fast took ${seconds}s (health timeout is 30s)`);
    const after = await snapshot();
    assert.equal(after.env, before.env);
    assert.equal(after.containers.api.image, `${APP_REPO}:2.0.0`);
    assert.equal(await apiVersion(), "2.0.0");
    await acknowledge();
  });

  await scenario("web image not published: the current web image stays", async () => {
    const before = await snapshot();
    await schedule("2.3.0", { digestWeb: null });
    const final = await waitTerminal();
    assert.equal(final.run.outcome, "succeeded", JSON.stringify(final.run.failure));
    assert.equal(final.run.digestVerified, true);
    assert.equal(final.run.steps.find((s) => s.id === "fetch").detail.web, "not_published");
    const after = await snapshot();
    assert.equal(after.containers.api.image, `${APP_REPO}:2.3.0`);
    assert.equal(after.containers.caddy.image, `${WEB_REPO}:2.0.0`);
    assert.equal(after.env, expectedEnv(before.env, `${APP_REPO}:2.3.0`, null));
    assert.equal(await apiVersion(), "2.3.0");
    await acknowledge();
    baselineVersion = "2.3.0";
  });

  await scenario("failure after migrations: needs attention, nothing rolled back", async () => {
    const before = await snapshot();
    await schedule("3.0.0");
    const final = await waitTerminal();
    const run = final.run;
    assert.equal(run.outcome, "needs_attention", JSON.stringify(run.failure));
    assert.equal(run.failure.migrationsRan, true);
    assert(["health.timeout", "health.crashed"].includes(run.failure.code), run.failure.code);
    const after = await snapshot();
    for (const service of ["api", "worker", "scheduler"]) {
      assert.notEqual(after.containers[service].state, "running", `${service} must be stopped`);
    }
    assert.equal(
      after.containers.caddy.state,
      "running",
      "the edge stays up (it serves the maintenance page)",
    );
    assert.equal(after.containers.caddy.id, before.containers.caddy.id);
    assert.equal(after.migrations, before.migrations + 1, "the migration ran");
    assert.match(
      after.env,
      new RegExp(`RESTOW_IMAGE=${APP_REPO}:3.0.0`),
      ".env keeps the new reference: nothing was rolled back",
    );
    assert.equal(run.recovery.fromVersion, "2.3.0");
    assert.deepEqual(run.recovery.previousImages, {
      app: `${APP_REPO}:2.3.0`,
      web: `${WEB_REPO}:2.0.0`,
    });
    assert(run.recovery.dumpBytes > 1000);

    // The recovery data is enough: restore the dump into a scratch database (it is the state
    // before the migration), then do what the documentation tells the operator.
    const restored = await restoreIntoScratch(run.recovery.dumpFile);
    assert.equal(restored.migrations, before.migrations, "the kept dump predates the migration");
    assert.equal(restored.canary, before.canary);
    await compose("exec", "-T", "postgres", "dropdb", "-U", "restow", "--force", "restow");
    await compose("exec", "-T", "postgres", "createdb", "-U", "restow", "restow");
    await pipeInto(
      "docker",
      [
        "compose",
        "-p",
        PROJECT,
        "exec",
        "-T",
        "postgres",
        "pg_restore",
        "-U",
        "restow",
        "-d",
        "restow",
        "--no-owner",
      ],
      await readDump(run.recovery.dumpFile),
      DIRS.project,
    );
    assert.equal(
      Number(await psql("SELECT count(*) FROM drizzle.__drizzle_migrations")),
      before.migrations,
    );
    let text = await fs.readFile(ENV_FILE, "utf8");
    text = text.replace(/^RESTOW_IMAGE=.*$/m, `RESTOW_IMAGE=${run.recovery.previousImages.app}`);
    await fs.writeFile(ENV_FILE, text);
    await compose("up", "-d", "--no-deps", "api", "worker", "scheduler");
    await waitFor(
      "the previous version after the manual recovery",
      async () => (await apiVersion()) === "2.3.0",
      { timeoutMs: 60_000 },
    );
    await acknowledge();
    assert(
      final.capabilities.dumps.length <= 4,
      `kept ${final.capabilities.dumps.length} dumps (3 newest plus the one a needs_attention run needs)`,
    );
  });

  await scenario(
    "the updater is killed during a run: the run is recorded as interrupted",
    async () => {
      await schedule("3.1.0");
      await waitFor(
        "the run to reach the health step",
        async () => (await state(false)).run?.step === "health",
        { timeoutMs: 120_000, intervalMs: 500 },
      );
      await killUpdater();
      await startUpdater();
      const current = await state();
      assert.equal(current.phase, "failed");
      assert.equal(current.run.failure.code, "interrupted");
      assert.equal(current.run.outcome, "needs_attention");
      assert(current.run.recovery?.dumpFile, "the dump is named");
      assert.equal(current.history[0].id, current.run.id);
      const actions = current.events.map((event) => event.action);
      assert(actions.includes("update.failed"), actions.join());
      // Operator recovery: put the image variable back and recreate the services.
      await forceBaseline(baselineVersion);
      await acknowledge();
    },
  );

  await scenario("final state", async () => {
    const final = await state();
    assert.equal(final.phase, "idle");
    assert(final.capabilities.dumps.length <= 4, `kept ${final.capabilities.dumps.length} dumps`);
    assert.equal(final.history.length <= 10, true);
    assert.equal(await apiVersion(), baselineVersion);
    // The secret never appears in any response.
    for (const route of ["/v1/state", "/public/status", "/healthz"]) {
      assert(!(await updaterApi("GET", route)).text.includes(secret), `${route} leaked the secret`);
    }
  });

  await cleanup();
  printSummary();
}

function printSummary() {
  console.log("\n=== updater E2E summary ===");
  for (const result of results) {
    console.log(
      `${result.ok ? "PASS" : "FAIL"}  ${result.name}  (${result.seconds}s)${result.ok ? "" : `\n      ${result.error}`}`,
    );
  }
  const failed = results.filter((result) => !result.ok);
  console.log(
    `${results.length - failed.length}/${results.length} scenarios passed (mode: ${MODE})`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Cleanup: only what this script created
// ---------------------------------------------------------------------------

async function cleanup() {
  if (flag("keep")) {
    log("--keep: leaving the project, the registry and the images in place");
    return;
  }
  log("cleaning up");
  updaterProcess?.kill("SIGKILL");
  if (fsSync.existsSync(path.join(DIRS.project, "docker-compose.yml"))) {
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
  // -v: the registry image declares an anonymous data volume; it goes with the container.
  await dockerAllowFail("rm", "-fv", REGISTRY_CONTAINER);
  // Helper containers of a crashed updater carry this label.
  const helpers = await dockerAllowFail(
    "ps",
    "-aq",
    "--filter",
    "label=com.restow.updater.helper=1",
    "--filter",
    `label=com.docker.compose.project=${PROJECT}`,
  );
  void helpers;
  for (const image of [...APP_TAGS(), ...WEB_TAGS(), UPDATER_IMAGE]) {
    await dockerAllowFail("rmi", image);
  }
  // Images this script pulled that were not on the machine before.
  for (const image of ["registry:2", "docker:27-cli"]) {
    if (created.pulledBefore.size > 0 && !created.pulledBefore.has(image)) {
      await dockerAllowFail("rmi", image);
    }
  }
  await fs.rm(WORK, { recursive: true, force: true });
}

const APP_TAGS = () => Object.keys(APP_VERSIONS).map((version) => `${APP_REPO}:${version}`);
const WEB_TAGS = () => [...WEB_VERSIONS, "2.3.0"].map((version) => `${WEB_REPO}:${version}`);

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

main().catch(async (error) => {
  console.error(error.stack ?? error.message);
  await cleanup().catch(() => undefined);
  process.exit(2);
});
