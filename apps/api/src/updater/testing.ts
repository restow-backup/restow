import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DumpStore } from "./dumps.js";
import { UpdateEngine } from "./engine.js";
import { EnvFile, assignedKey, assignedValue, parseEnvLines } from "./env-file.js";
import { type ImageVariant, defaultImageRepositories } from "./image-variant.js";
import { memoryLogger } from "./logger.js";
import type { MounterStatus } from "./mounter-status.js";
import {
  type ApiClient,
  type ApiReadinessResult,
  type BuildSpec,
  type Clock,
  type ConfiguredImages,
  type DockerOps,
  type DumpVerification,
  OpsError,
  PullError,
  type RunnerReadiness,
  type SelfContainer,
  type ServiceState,
  type SignatureCheck,
  SignatureError,
  type TimerHandle,
} from "./ops.js";
import { Preflight } from "./preflight.js";
import type { ScheduleRequest } from "./protocol.js";
import { Redactor } from "./redact.js";
import { type SelfRecreateHandle, type SelfRecreateLauncher, SelfUpdater } from "./self-update.js";
import {
  type FetchedSource,
  SourceError,
  type SourceFetchInput,
  type SourceProvider,
} from "./source.js";
import { StatusStore } from "./store.js";

/**
 * Fakes and a harness for driving the engine in tests: a clock that only moves when
 * told, a Docker world that behaves like a compose project (images follow `.env`,
 * an api container can migrate, crash or never come up), an api client and a source
 * provider. Nothing here touches Docker, the network or the real clock.
 */

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  private ms: number;
  private timers: { id: number; due: number; fn: () => void }[] = [];
  private nextId = 1;

  constructor(start = Date.parse("2026-09-30T10:00:00.000Z")) {
    this.ms = start;
  }

  now(): Date {
    return new Date(this.ms);
  }

  /** Time passes at once: the sleeper returns immediately after advancing the clock. */
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
    await Promise.resolve();
  }

  setTimer(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, due: this.ms + ms, fn });
    return {
      cancel: () => {
        this.timers = this.timers.filter((timer) => timer.id !== id);
      },
    };
  }

  /** Move time forward and fire the timers that became due, in order. */
  advance(ms: number): void {
    const target = this.ms + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!due) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.ms = Math.max(this.ms, due.due);
      due.fn();
    }
    this.ms = target;
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

// ---------------------------------------------------------------------------
// Docker world
// ---------------------------------------------------------------------------

export interface ApiBehavior {
  /** `ready` answers ready after `afterPolls` polls; `never` never answers; `crash` restarts in a loop. */
  kind: "ready" | "never" | "crash";
  afterPolls?: number;
  /** Migrations the api applies when it starts with this image. */
  migrates?: number;
  /** The version it reports (default: the image tag). */
  reportsVersion?: string;
}

export type Failure = Error | null | undefined;

interface FakeContainer {
  image: string;
  state: string;
  exitCode: number | null;
  polls: number;
}

/** The order in which services are reported (as `docker compose ps` would list them). */
const SERVICES = ["postgres", "api", "worker", "scheduler", "caddy"] as const;

export class FakeDockerOps implements DockerOps {
  readonly runnerKind = "cli" as const;

  /** Every operation in order, as one line each (arguments included). */
  readonly calls: string[] = [];
  readonly containers = new Map<string, FakeContainer>();
  /** Images present locally, with the digests they are known by. */
  readonly localImages = new Map<string, string[]>();
  /** Registry behaviour per image: missing = pulls fine. */
  readonly registry = new Map<string, "not_found" | "denied" | "ok">();
  /** Digest a pulled image gets (default `sha256:` + 64 x the first hex digit of the tag). */
  readonly pulledDigests = new Map<string, string[]>();
  /**
   * Signatures in the registry, by `name@digest`: the signer identity of each. Missing:
   * the image is signed by whatever `signAll` says (default: the expected signer).
   */
  readonly signatures = new Map<string, string | null>();
  /** Without an entry in `signatures`: true signs as asked, false leaves the image unsigned. */
  signAll = true;
  readonly signatureChecks: SignatureCheck[] = [];
  readonly apiBehavior = new Map<string, ApiBehavior>();
  readonly builds: BuildSpec[] = [];
  migrations = 12;
  freeBytesValue = 50 * 1024 ** 3;
  pingError: Error | null = null;
  composeFile: string | null = "docker-compose.yml";
  self: SelfContainer | null = null;
  runnerReady: RunnerReadiness = { ready: true, detail: null };
  /** Compose takes the image from the variables (false: the compose file hard-codes them). */
  honoursVariables = true;
  /**
   * The `updater` service's image: pinned on its own (a fixed reference), following
   * RESTOW_IMAGE (an old compose file), `fallback` as the compose files of this release
   * (`${RESTOW_UPDATER_IMAGE:-${RESTOW_IMAGE}}`), or no such service.
   */
  updaterImage: "pinned" | "follows" | "fallback" | "none" = "pinned";
  /**
   * The `mounter` service's image: `fallback` as the compose files of this release
   * (`${RESTOW_MOUNTER_IMAGE:-${RESTOW_IMAGE}}`), a fixed reference, or no such service.
   */
  mounterImage: "pinned" | "fallback" | "none" = "fallback";
  /** The project has a `mounter` container (the mounts profile was started). */
  mounterContainer = false;
  /** Errors to raise, per operation name, per call number (0-based). */
  private readonly failures = new Map<string, ((call: number) => Failure)[]>();
  private readonly counters = new Map<string, number>();
  /** Content of the dump files the fake writes. */
  dumpContent = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(2048, 7)]);
  apiRunningVersionValue: string | null = null;

  constructor(
    private readonly projectDir: string,
    private readonly dumpsDir: string,
  ) {
    for (const name of SERVICES) {
      this.containers.set(name, {
        image: `${name}:initial`,
        state: "running",
        exitCode: null,
        polls: 0,
      });
    }
  }

  // -- Scripting ------------------------------------------------------------

  /** Make the n-th call (0-based) of an operation fail; without `call`, every call fails. */
  failOn(operation: string, error: Error, call?: number): void {
    const list = this.failures.get(operation) ?? [];
    list.push((index) => (call === undefined || call === index ? error : null));
    this.failures.set(operation, list);
  }

  clearFailures(operation?: string): void {
    if (operation) {
      this.failures.delete(operation);
    } else {
      this.failures.clear();
    }
  }

  callsTo(prefix: string): string[] {
    return this.calls.filter((call) => call === prefix || call.startsWith(`${prefix} `));
  }

  /** Put the project into the state of an installation running `image` for the app roles. */
  async installAt(appImage: string, webImage: string, version: string): Promise<void> {
    for (const name of ["api", "worker", "scheduler"] as const) {
      this.containers.set(name, { image: appImage, state: "running", exitCode: null, polls: 0 });
    }
    this.containers.set("caddy", { image: webImage, state: "running", exitCode: null, polls: 0 });
    this.apiBehavior.set(appImage, { kind: "ready", reportsVersion: version });
    this.localImages.set(appImage, [digestOf("initial")]);
    this.localImages.set(webImage, [digestOf("initial-web")]);
  }

  private hit(operation: string, detail = ""): void {
    this.calls.push(detail ? `${operation} ${detail}` : operation);
    const index = this.counters.get(operation) ?? 0;
    this.counters.set(operation, index + 1);
    for (const rule of this.failures.get(operation) ?? []) {
      const error = rule(index);
      if (error) {
        throw error;
      }
    }
  }

  // -- Environment ----------------------------------------------------------

  async ping(): Promise<void> {
    this.hit("ping");
    if (this.pingError) {
      throw new OpsError("Docker is not reachable.", this.pingError.message);
    }
  }

  async readiness(): Promise<RunnerReadiness> {
    return this.runnerReady;
  }

  async composeFilePresent(): Promise<string | null> {
    return this.composeFile;
  }

  async inspectSelf(): Promise<SelfContainer | null> {
    return this.self;
  }

  async freeBytes(): Promise<number> {
    return this.freeBytesValue;
  }

  // -- Compose semantics ----------------------------------------------------

  private async envValue(
    key: string,
    processEnv: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    const fromProcess = processEnv[key];
    if (fromProcess !== undefined) {
      return fromProcess;
    }
    const text = await fs.readFile(path.join(this.projectDir, ".env"), "utf8");
    const lines = parseEnvLines(text);
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = (lines[index] as { text: string }).text;
      if (assignedKey(line) === key) {
        const value = assignedValue(line);
        return value === "" ? null : value;
      }
    }
    return null;
  }

  private async imageFor(
    service: string,
    processEnv: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    if (!this.honoursVariables) {
      return `hardcoded/${service}:1`;
    }
    if (service === "caddy") {
      return (await this.envValue("RESTOW_WEB_IMAGE", processEnv)) ?? "restow-web:local";
    }
    return (await this.envValue("RESTOW_IMAGE", processEnv)) ?? "restow:local";
  }

  async configImages(env: Readonly<Record<string, string>>): Promise<ConfiguredImages> {
    this.hit("configImages", JSON.stringify(env));
    return {
      api: await this.imageFor("api", env),
      caddy: await this.imageFor("caddy", env),
      worker: await this.imageFor("worker", env),
      scheduler: await this.imageFor("scheduler", env),
    };
  }

  async configUpdaterImage(env: Readonly<Record<string, string>>): Promise<string | null> {
    this.hit("configUpdaterImage", JSON.stringify(env));
    if (this.updaterImage === "none") {
      return null;
    }
    if (this.updaterImage === "fallback") {
      return (
        (await this.envValue("RESTOW_UPDATER_IMAGE", env)) ?? (await this.imageFor("api", env))
      );
    }
    return this.updaterImage === "follows"
      ? await this.imageFor("api", env)
      : "ghcr.io/restow-backup/restow:0.1.0";
  }

  async configMounterImage(env: Readonly<Record<string, string>>): Promise<string | null> {
    this.hit("configMounterImage", JSON.stringify(env));
    if (this.mounterImage === "none") {
      return null;
    }
    if (this.mounterImage === "fallback") {
      return (
        (await this.envValue("RESTOW_MOUNTER_IMAGE", env)) ?? (await this.imageFor("api", env))
      );
    }
    return "ghcr.io/restow-backup/restow:0.1.0";
  }

  async mounterContainerExists(): Promise<boolean> {
    this.hit("mounterContainerExists");
    return this.mounterContainer;
  }

  async apiRunningVersion(): Promise<string | null> {
    this.hit("apiRunningVersion");
    return this.apiRunningVersionValue;
  }

  // -- Images ---------------------------------------------------------------

  async pull(image: string): Promise<void> {
    this.hit("pull", image);
    const behaviour = this.registry.get(image) ?? "ok";
    if (behaviour === "not_found") {
      throw new PullError(
        "The image pull failed.",
        `manifest for ${image} not found: manifest unknown`,
        true,
      );
    }
    if (behaviour === "denied") {
      throw new PullError(
        "The image pull failed.",
        "denied: requested access to the resource is denied",
        false,
      );
    }
    this.localImages.set(image, this.pulledDigests.get(image) ?? [digestOf(image)]);
  }

  async verifySignature(check: SignatureCheck): Promise<void> {
    this.hit("verifySignature", `${check.image} ${check.certificateIdentity}`);
    this.signatureChecks.push(check);
    const signer = this.signatures.has(check.image)
      ? this.signatures.get(check.image)
      : this.signAll
        ? check.certificateIdentity
        : null;
    if (signer !== check.certificateIdentity) {
      throw new SignatureError(
        "The signature check failed (exit code 1).",
        signer
          ? `none of the expected identities matched what was in the certificate, got subjects [${signer}]`
          : "Error: no signatures found",
      );
    }
  }

  async imageDigests(image: string): Promise<string[]> {
    this.hit("imageDigests", image);
    return this.localImages.get(image) ?? [];
  }

  async build(spec: BuildSpec): Promise<void> {
    this.hit("build", `${spec.target} ${spec.tag}`);
    this.builds.push(spec);
    this.localImages.set(spec.tag, [digestOf(spec.tag)]);
  }

  // -- Database -------------------------------------------------------------

  async migrationCount(): Promise<number> {
    this.hit("migrationCount");
    return this.migrations;
  }

  async dumpDatabase(file: string): Promise<void> {
    this.hit("dumpDatabase", path.basename(file));
    await fs.writeFile(file, this.dumpContent, { mode: 0o600 });
  }

  async verifyDump(file: string): Promise<DumpVerification> {
    this.hit("verifyDump", path.basename(file));
    const stat = await fs.stat(file);
    if (stat.size === 0) {
      throw new OpsError("The dump is empty.");
    }
    return { bytes: stat.size, entries: 42 };
  }

  // -- Compose --------------------------------------------------------------

  async composeStop(services: readonly string[], timeoutSeconds: number): Promise<void> {
    this.hit("composeStop", `${services.join(",")} -t ${timeoutSeconds}`);
    for (const name of services) {
      const container = this.containers.get(name);
      if (container) {
        container.state = "exited";
        container.exitCode = 0;
      }
    }
  }

  async composeUp(services: readonly string[]): Promise<void> {
    this.hit("composeUp", services.join(","));
    for (const name of services) {
      const image = await this.imageFor(name);
      const existing = this.containers.get(name);
      const container: FakeContainer = existing ?? {
        image,
        state: "running",
        exitCode: null,
        polls: 0,
      };
      const recreate = existing !== undefined && existing.image !== image;
      if (!existing || recreate || existing.state !== "running") {
        container.image = image;
        container.state = "running";
        container.exitCode = null;
        container.polls = 0;
        if (name === "api") {
          const behaviour = this.apiBehavior.get(image);
          this.migrations += behaviour?.migrates ?? 0;
          if (behaviour?.kind === "crash") {
            container.state = "restarting";
            container.exitCode = 1;
          }
        }
      }
      this.containers.set(name, container);
    }
  }

  async composeStart(services: readonly string[]): Promise<void> {
    this.hit("composeStart", services.join(","));
    for (const name of services) {
      const container = this.containers.get(name);
      if (container) {
        container.state = "running";
      }
    }
  }

  async servicesState(): Promise<ServiceState[]> {
    this.hit("servicesState");
    return [...this.containers.entries()].map(([service, container]) => ({
      service,
      state: container.state,
      health: null,
      exitCode: container.exitCode,
    }));
  }

  async apiLogsTail(lines: number): Promise<string> {
    this.hit("apiLogsTail", String(lines));
    return "Error: migration 0042 failed: relation already exists";
  }

  /** What the api answers to `GET /readyz` right now. */
  readyz(): ApiReadinessResult {
    const container = this.containers.get("api");
    if (!container || container.state !== "running") {
      return { ready: false, version: null, reason: "The api is not running." };
    }
    const behaviour = this.apiBehavior.get(container.image) ?? { kind: "ready" as const };
    container.polls += 1;
    if (behaviour.kind === "never" || behaviour.kind === "crash") {
      return { ready: false, version: null, reason: "The api is starting." };
    }
    if (container.polls <= (behaviour.afterPolls ?? 0)) {
      return { ready: false, version: null, reason: "The api is starting." };
    }
    return {
      ready: true,
      version: behaviour.reportsVersion ?? container.image.split(":").pop() ?? null,
      reason: null,
    };
  }
}

export function digestOf(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `sha256:${hash.toString(16).padStart(8, "0").repeat(8)}`;
}

export class FakeApiClient implements ApiClient {
  readonly calls: string[] = [];
  token: string | null = "ghp_0123456789abcdefghijTOKEN";
  tokenError: Error | null = null;
  /** Answer of `readiness()` before the fake world is consulted (null: ask the world). */
  override: ApiReadinessResult | null = null;

  constructor(private readonly ops: FakeDockerOps) {}

  async readiness(): Promise<ApiReadinessResult> {
    this.calls.push("readiness");
    return this.override ?? this.ops.readyz();
  }

  async sourceToken(): Promise<string | null> {
    this.calls.push("sourceToken");
    if (this.tokenError) {
      throw this.tokenError;
    }
    return this.token;
  }
}

export class FakeSourceProvider implements SourceProvider {
  readonly fetches: { version: string; archiveUrl: string; token: string | null }[] = [];
  purges = 0;
  cleanups = 0;
  failWith: Error | null = null;
  /** Answer like an updater whose allowlist does not name the source. */
  notAllowed = false;

  validate(archiveUrl: string): void {
    if (!archiveUrl.startsWith("https://")) {
      throw new Error("The archive URL must use https.");
    }
    if (this.notAllowed) {
      throw new SourceError(
        "The repository is not in RESTOW_UPDATER_SOURCE_HOSTS.",
        "download",
        true,
      );
    }
  }

  async fetch(input: SourceFetchInput): Promise<FetchedSource> {
    this.fetches.push({ version: input.version, archiveUrl: input.archiveUrl, token: input.token });
    await input.onStage?.("downloading");
    if (this.failWith) {
      throw this.failWith;
    }
    await input.onStage?.("extracting");
    return {
      contextDir: `/fake/src/${input.version}`,
      cleanup: async () => {
        this.cleanups += 1;
      },
    };
  }

  async purge(): Promise<void> {
    this.purges += 1;
  }
}

// ---------------------------------------------------------------------------
// Self-update helper
// ---------------------------------------------------------------------------

/** The helper container that recreates the updater, scripted. */
export class FakeLauncher implements SelfRecreateLauncher {
  launches = 0;
  launchError: Error | null = null;
  /** What the helper ends with; null: it does not end in time. */
  exitCode: number | null = 0;
  output = "";
  /** Runs while the old updater waits (e.g. Compose stopping it: `selfUpdater.stop()`). */
  onWait: (() => void) | null = null;

  async launch(): Promise<SelfRecreateHandle> {
    this.launches += 1;
    if (this.launchError) {
      throw this.launchError;
    }
    return {
      wait: async () => {
        this.onWait?.();
        return { exitCode: this.exitCode, output: this.output };
      },
    };
  }
}

/** The mounter's `busy` answers, scripted: one per call, the last one repeats. */
export class FakeMounterStatus implements MounterStatus {
  calls = 0;
  constructor(private readonly answers: (boolean | null)[] = [false]) {}

  async busy(): Promise<boolean | null> {
    const answer = this.answers[Math.min(this.calls, this.answers.length - 1)] ?? null;
    this.calls += 1;
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export const DEFAULT_ENV = [
  "# Restow configuration",
  "POSTGRES_PASSWORD=super-secret-db-password",
  "POSTGRES_USER=restow",
  "RESTOW_APP_DOMAIN=restow.example.com",
  "",
  "RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.1.0",
  "# keep this comment",
  "RESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web:0.1.0",
  "BETTER_AUTH_SECRET=abcdefghijklmnopqrstuvwxyz",
  "",
].join("\n");

/** DEFAULT_ENV of an installation that runs the Community images. */
export const COMMUNITY_ENV = DEFAULT_ENV.replace(
  "restow-backup/restow:0.1.0",
  "restow-backup/restow-community:0.1.0",
).replace("restow-backup/restow-web:0.1.0", "restow-backup/restow-web-community:0.1.0");

export interface Harness {
  dir: string;
  projectDir: string;
  stateDir: string;
  clock: FakeClock;
  ops: FakeDockerOps;
  api: FakeApiClient;
  source: FakeSourceProvider;
  store: StatusStore;
  engine: UpdateEngine;
  preflight: Preflight;
  envFile: EnvFile;
  dumps: DumpStore;
  redactor: Redactor;
  logger: ReturnType<typeof memoryLogger>;
  /** The updater's own update; null unless `selfUpdate` was given. */
  selfUpdater: SelfUpdater | null;
  /** `.env` as it is on disk now. */
  readEnv(): Promise<string>;
  /** Recreate the engine on the same state directory, as after an updater restart. */
  restart(overrides?: Partial<HarnessOptions>): Promise<Harness>;
  cleanup(): Promise<void>;
}

/** A cosign image reference of the right shape for the fakes. */
export const TEST_COSIGN_IMAGE = `ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:${"c".repeat(64)}`;

export interface HarnessOptions {
  env?: string;
  /** The build the installation runs (default full): its images, repositories and targets. */
  imageVariant?: ImageVariant;
  /** Image mode verifies signatures (default true). */
  verifySignatures?: boolean;
  healthTimeoutSeconds?: number;
  /** Give the engine a self-updater (self-update.ts). */
  selfUpdate?: {
    enabled?: boolean;
    /** The updater's own version (default 0.1.0, the installed release). */
    updaterVersion?: string | null;
    launcher?: SelfRecreateLauncher | null;
    /** Move the mounter along (self-update.ts, followMounter). */
    mounter?: {
      launcher?: SelfRecreateLauncher | null;
      status?: MounterStatus;
      idleWaitMs?: number;
      pollMs?: number;
    };
  };
  /** Reuse the directories of another harness (restart). */
  reuse?: { dir: string; clock: FakeClock; ops: FakeDockerOps };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = options.reuse?.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-")));
  const projectDir = path.join(dir, "project");
  const stateDir = path.join(dir, "state");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const imageVariant = options.imageVariant ?? "full";
  const repositories = defaultImageRepositories(imageVariant);
  if (!options.reuse) {
    const env = options.env ?? (imageVariant === "community" ? COMMUNITY_ENV : DEFAULT_ENV);
    await fs.writeFile(path.join(projectDir, ".env"), env, { mode: 0o600 });
    await fs.writeFile(path.join(projectDir, "docker-compose.yml"), "name: restow\n");
  }

  const redactor = new Redactor();
  const logger = memoryLogger(redactor);
  const clock = options.reuse?.clock ?? new FakeClock();
  const dumps = new DumpStore(path.join(stateDir, "dumps"));
  const ops = options.reuse?.ops ?? new FakeDockerOps(projectDir, dumps.directory);
  if (!options.reuse) {
    await ops.installAt(`${repositories.app}:0.1.0`, `${repositories.web}:0.1.0`, "0.1.0");
  }
  const api = new FakeApiClient(ops);
  const source = new FakeSourceProvider();
  const store = await StatusStore.open(stateDir, logger, () => clock.now());
  const envFile = new EnvFile(path.join(projectDir, ".env"));
  const preflight = new Preflight({
    ops,
    envFile,
    dumps,
    clock,
    redactor,
    projectDir,
    stateDir,
    minFreeMb: 1024,
    imageRepository: repositories.app,
    webImageRepository: repositories.web,
  });
  const selfUpdater = options.selfUpdate
    ? new SelfUpdater({
        enabled: options.selfUpdate.enabled ?? true,
        verifySignatures: options.verifySignatures ?? true,
        updaterVersion:
          options.selfUpdate.updaterVersion === undefined
            ? "0.1.0"
            : options.selfUpdate.updaterVersion,
        imageRepository: repositories.app,
        envFile,
        ops,
        launcher: options.selfUpdate.launcher === undefined ? null : options.selfUpdate.launcher,
        ...(options.selfUpdate.mounter
          ? {
              mounter: {
                ops,
                launcher:
                  options.selfUpdate.mounter.launcher === undefined
                    ? null
                    : options.selfUpdate.mounter.launcher,
                status: options.selfUpdate.mounter.status ?? new FakeMounterStatus(),
                ...(options.selfUpdate.mounter.idleWaitMs !== undefined
                  ? { idleWaitMs: options.selfUpdate.mounter.idleWaitMs }
                  : {}),
                ...(options.selfUpdate.mounter.pollMs !== undefined
                  ? { pollMs: options.selfUpdate.mounter.pollMs }
                  : {}),
              },
            }
          : {}),
        store,
        clock,
        logger,
        redactor,
      })
    : null;
  if (selfUpdater) {
    await selfUpdater.reconcile();
  }
  const engine = new UpdateEngine({
    config: {
      projectDir,
      imageVariant,
      imageRepository: repositories.app,
      webImageRepository: repositories.web,
      healthTimeoutSeconds: options.healthTimeoutSeconds ?? 600,
      verifySignatures: options.verifySignatures ?? true,
      cosignImage: TEST_COSIGN_IMAGE,
    },
    store,
    ops,
    api,
    source,
    clock,
    redactor,
    logger,
    envFile,
    dumps,
    preflight,
    ...(selfUpdater ? { selfUpdater } : {}),
  });

  const harness: Harness = {
    dir,
    projectDir,
    stateDir,
    clock,
    ops,
    api,
    source,
    store,
    engine,
    preflight,
    envFile,
    dumps,
    redactor,
    logger,
    selfUpdater,
    readEnv: () => fs.readFile(path.join(projectDir, ".env"), "utf8"),
    restart: async (overrides = {}) => {
      // The old process is gone: its timers and its next steps must not run any more.
      await engine.shutdown();
      return await createHarness({ ...options, ...overrides, reuse: { dir, clock, ops } });
    },
    cleanup: async () => {
      await engine.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** The digests the fake registry gives the published images of `version`. */
export function releaseDigests(version: string): { app: string; web: string } {
  return {
    app: digestOf(`ghcr.io/restow-backup/restow:${version}`),
    web: digestOf(`ghcr.io/restow-backup/restow-web:${version}`),
  };
}

/** The certificate identity the release workflow signs `version` with. */
export function releaseSigner(version: string): string {
  return `https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v${version}`;
}

/** A valid image-mode schedule request for `version`. */
export function scheduleRequest(
  version: string,
  overrides: Partial<ScheduleRequest> & { digests?: { app?: string; web?: string } } = {},
): ScheduleRequest {
  const { digests, ...rest } = overrides;
  const plain = version.replace(/^v/, "");
  return {
    release: {
      version,
      tag: `v${plain}`,
      url: `https://example.com/releases/v${plain}`,
      prerelease: false,
      // What the fake registry gives these tags; a release publishes both by default.
      digests: digests ?? releaseDigests(plain),
    },
    mode: "image",
    source: null,
    leadSeconds: 0,
    requestedBy: { userId: "user-1", label: "admin@example.com", ip: "203.0.113.7" },
    ...rest,
    switchTo: rest.switchTo ?? null,
  };
}

/** Wait until the engine has no scheduled or running run. */
export async function settle(engine: UpdateEngine): Promise<void> {
  for (let attempt = 0; attempt < 20_000; attempt++) {
    await engine.settled();
    const phase = engine.view().phase;
    if (phase !== "running" && phase !== "scheduled") {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("The engine did not settle.");
}

/** Make the fake api of `image` behave as given. */
export function apiAt(harness: Harness, image: string, behaviour: ApiBehavior): void {
  harness.ops.apiBehavior.set(image, behaviour);
}

/** Wait until the run has reached `step` (real time; the fake world answers at once). */
export async function waitForStep(harness: Harness, step: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (harness.engine.view().run?.step === step) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`The run did not reach step ${step}.`);
}

/** Wait until the fake world has seen a call that starts with `prefix`. */
export async function waitForCall(harness: Harness, prefix: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (harness.ops.calls.filter((call) => call.startsWith(prefix)).length >= count) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No call ${prefix} was made.`);
}
