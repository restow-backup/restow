/**
 * The seams of the updater. The engine is driven only through these interfaces,
 * so every scenario (a failing pull, a crashing api, a rollback that fails) can be
 * scripted with fakes and no Docker.
 *
 *   CommandRunner  runs one `docker` command line. Two implementations: the
 *                  `docker` binary (runner-local.ts) and a short-lived helper
 *                  container reached over the Engine API (runner-helper.ts).
 *   DockerOps      the semantic operations the engine needs (ops-cli.ts builds
 *                  them out of command lines).
 *   ApiClient      what the updater asks the api over HTTP.
 */

import type { BuildTarget } from "./image-variant.js";

// ---------------------------------------------------------------------------
// CommandRunner
// ---------------------------------------------------------------------------

export interface CommandSpec {
  /** Program and arguments. `argv[0]` is `docker`. Never a shell string. */
  argv: readonly string[];
  /** Extra environment variables for this command (everything else is filtered). */
  env?: Readonly<Record<string, string>>;
  /** Write the command's stdout to this file (absolute path, mode 0600) instead of capturing it. */
  stdoutFile?: string;
  /** Feed this file to the command's stdin. */
  stdinFile?: string;
  timeoutMs: number;
  /** Cap for captured stdout in bytes (default 4 MiB). */
  maxOutputBytes?: number;
}

export interface CommandResult {
  exitCode: number;
  /** Captured stdout, raw (may hold configuration; never log it). Empty with `stdoutFile`. */
  stdout: string;
  /** Redacted last part of stderr (falls back to the stdout tail when stderr is empty). */
  errorTail: string;
  timedOut: boolean;
  /** Captured stdout hit the cap and was cut. */
  truncated: boolean;
}

export interface RunnerReadiness {
  ready: boolean;
  /** Why it is not ready (redacted, non-sensitive). */
  detail: string | null;
}

export interface CommandRunner {
  readonly kind: "cli" | "helper";
  /** Docker answers. Throws with a redacted message when it does not. */
  ping(): Promise<void>;
  /** Whether commands can be run right now. Never waits for a long download. */
  readiness(): Promise<RunnerReadiness>;
  run(spec: CommandSpec): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// DockerOps
// ---------------------------------------------------------------------------

/** A Docker or Compose operation failed. `detail` is redacted and single-line. */
export class OpsError extends Error {
  constructor(
    message: string,
    readonly detail: string = "",
  ) {
    super(message);
    this.name = "OpsError";
  }
}

/** A pull failed; `notFound` when the registry said the manifest does not exist. */
export class PullError extends OpsError {
  constructor(
    message: string,
    detail: string,
    readonly notFound: boolean,
  ) {
    super(message, detail);
    this.name = "PullError";
  }
}

/** The signature of an image could not be verified (missing, wrong signer, verifier failed). */
export class SignatureError extends OpsError {
  constructor(message: string, detail = "") {
    super(message, detail);
    this.name = "SignatureError";
  }
}

/** What a keyless cosign verification checks (signature.ts). */
export interface SignatureCheck {
  /** The image by digest: `name@sha256:<64 hex>`. */
  image: string;
  /** The exact certificate identity (SAN) of the signer. */
  certificateIdentity: string;
  /** The OIDC issuer the certificate was issued for. */
  certificateOidcIssuer: string;
  /** The cosign image to verify with, pinned by digest. */
  verifierImage: string;
}

/** The container this process runs in (null when it does not run in one). */
export interface SelfContainer {
  id: string;
  /** The `com.docker.compose.project` label. */
  projectName: string | null;
  /** The `com.docker.compose.project.working_dir` label. */
  workingDir: string | null;
}

export interface ConfiguredImages {
  api: string | null;
  caddy: string | null;
  worker: string | null;
  scheduler: string | null;
}

export type ServiceRunState =
  | "running"
  | "restarting"
  | "exited"
  | "created"
  | "paused"
  | "dead"
  | "removing";

export interface ServiceState {
  service: string;
  state: ServiceRunState | string;
  health: string | null;
  exitCode: number | null;
}

export interface ApiReadinessResult {
  /** HTTP 200 and status "ready". */
  ready: boolean;
  /** The version the api reports, when it answered with one. */
  version: string | null;
  /** Why the api did not answer as ready (redacted, short); null when ready. */
  reason: string | null;
}

export interface BuildSpec {
  contextDir: string;
  /** A Dockerfile target of the installation's build (image-variant.ts). */
  target: BuildTarget;
  tag: string;
  buildArgs: Readonly<Record<string, string>>;
}

export interface DumpVerification {
  bytes: number;
  /** Entries `pg_restore --list` printed. */
  entries: number;
}

export interface DockerOps {
  readonly runnerKind: "cli" | "helper";

  /** Docker answers. Throws OpsError otherwise. */
  ping(): Promise<void>;
  /** Whether commands can run now (the helper image is present, the CLI has Compose). */
  readiness(): Promise<RunnerReadiness>;
  /** The compose file of the project: its name, or null when there is none. */
  composeFilePresent(): Promise<string | null>;
  /** The container this process runs in; null when it does not run in one. */
  inspectSelf(): Promise<SelfContainer | null>;
  /** Free bytes on the file system holding `dir`. */
  freeBytes(dir: string): Promise<number>;

  /** The image references Compose resolves for the app roles, with `env` set in the process environment. */
  configImages(env: Readonly<Record<string, string>>): Promise<ConfiguredImages>;
  /**
   * The image Compose resolves for the `updater` service (profile `updater`), with
   * `env` set in the process environment; null when the project defines no such service.
   */
  configUpdaterImage(env: Readonly<Record<string, string>>): Promise<string | null>;
  /**
   * The image Compose resolves for the `mounter` service (profile `mounts`), with `env`
   * set in the process environment; null when the project defines no such service.
   */
  configMounterImage(env: Readonly<Record<string, string>>): Promise<string | null>;
  /** The project has a `mounter` container, running or not. false when that cannot be read. */
  mounterContainerExists(): Promise<boolean>;
  /** The version the api container was built with (its RESTOW_VERSION variable); null when unknown. */
  apiRunningVersion(): Promise<string | null>;

  pull(image: string): Promise<void>;
  /** Content digests (`sha256:...`) the local copy of an image is known by. */
  imageDigests(image: string): Promise<string[]>;
  /**
   * Verify the keyless cosign signature of an image in its registry, by digest.
   * Resolves only when a valid signature of exactly that signer exists; throws
   * SignatureError otherwise (also when the verifier cannot run or reach Sigstore).
   */
  verifySignature(check: SignatureCheck): Promise<void>;
  build(spec: BuildSpec): Promise<void>;

  /** Number of applied database migrations. Throws when it cannot be read. */
  migrationCount(): Promise<number>;
  /** Stream a custom-format dump of the application database into `file`. */
  dumpDatabase(file: string): Promise<void>;
  /** The dump is non-empty and `pg_restore --list` can read it. Throws otherwise. */
  verifyDump(file: string): Promise<DumpVerification>;

  composeStop(services: readonly string[], timeoutSeconds: number): Promise<void>;
  /** `up -d --no-deps` for exactly these services, never building and never pulling. */
  composeUp(services: readonly string[]): Promise<void>;
  composeStart(services: readonly string[]): Promise<void>;
  servicesState(): Promise<ServiceState[]>;
  /** Last lines of the api's log, redacted. Empty when unavailable. */
  apiLogsTail(lines: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// ApiClient
// ---------------------------------------------------------------------------

export interface ApiClient {
  /** `GET /readyz` with the shared secret. Never throws: an unreachable api is `ready: false`. */
  readiness(): Promise<ApiReadinessResult>;
  /** The stored access token for a private source repository; null when there is none. Throws when the api cannot be asked. */
  sourceToken(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Run `fn` once after `ms`. The timer never keeps the process alive on its own. */
  setTimer(fn: () => void, ms: number): TimerHandle;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};
