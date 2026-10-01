import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findComposeFile } from "./config.js";
import { isDumpFileName } from "./dumps.js";
import type { PostgresSettings } from "./env-file.js";
import {
  type BuildSpec,
  type CommandResult,
  type CommandRunner,
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
} from "./ops.js";
import type { Redactor } from "./redact.js";
import { HELPER_LABEL } from "./runner-helper.js";
import { DIGEST_PINNED_IMAGE } from "./signature.js";

/**
 * DockerOps implemented by composing `docker` and `docker compose` command lines
 * for a CommandRunner. Every command is an argument vector; values that come from
 * outside (image references, service names, file names, build arguments) are
 * checked against strict patterns first, and none of them is ever part of a shell
 * string (redirections go through the runner's file parameters).
 */

export const SERVICES = {
  api: "api",
  worker: "worker",
  scheduler: "scheduler",
  caddy: "caddy",
  postgres: "postgres",
  updater: "updater",
} as const;

const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,299}$/;
const LOCAL_TAG = /^[a-z0-9][a-z0-9._/-]{0,100}:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const SERVICE_NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const BUILD_ARG_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const BUILD_ARG_VALUE = /^[0-9A-Za-z._-]{0,64}$/;

/** SQL the updater runs: the count of applied migrations is its marker for "the new api migrated". */
export const MIGRATION_COUNT_SQL = "SELECT count(*) FROM drizzle.__drizzle_migrations";

const MINUTE = 60_000;
const TIMEOUTS = {
  config: MINUTE,
  quick: 30_000,
  pull: 30 * MINUTE,
  build: 90 * MINUTE,
  psql: 2 * MINUTE,
  dump: 6 * 60 * MINUTE,
  verify: 30 * MINUTE,
  up: 15 * MINUTE,
  verifySignature: 10 * MINUTE,
} as const;

/** An image named by digest (`name@sha256:...`): what a signature is checked for. */
const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9._/:-]{0,199}@sha256:[0-9a-f]{64}$/;
const SIGNER_IDENTITY =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\.github\/workflows\/[A-Za-z0-9._-]+@refs\/tags\/v[0-9A-Za-z.-]+$/;
const OIDC_ISSUER = /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._\/-]*)?$/;

export interface CliDockerOpsOptions {
  runner: CommandRunner;
  redactor: Redactor;
  projectDir: string;
  /** Compose project name (`-p`). */
  projectName: string;
  /** Compose file named explicitly (`-f`); null lets Compose discover the project's own files. */
  composeFile: string | null;
  /** Directory the database dumps live in. */
  dumpsDir: string;
  /** POSTGRES_USER and POSTGRES_DB from the project's `.env`, read when needed. */
  postgres: () => Promise<PostgresSettings>;
  selfInspect: () => Promise<SelfContainer | null>;
}

export class CliDockerOps implements DockerOps {
  constructor(private readonly options: CliDockerOpsOptions) {}

  get runnerKind(): "cli" | "helper" {
    return this.options.runner.kind;
  }

  // -- Environment ----------------------------------------------------------

  async ping(): Promise<void> {
    try {
      await this.options.runner.ping();
    } catch (error) {
      throw new OpsError(
        "Docker is not reachable.",
        this.options.redactor.oneLine((error as Error).message, 500),
      );
    }
  }

  readiness(): Promise<RunnerReadiness> {
    return this.options.runner.readiness();
  }

  composeFilePresent(): Promise<string | null> {
    return findComposeFile(this.options.projectDir, this.options.composeFile);
  }

  inspectSelf(): Promise<SelfContainer | null> {
    return this.options.selfInspect();
  }

  async freeBytes(dir: string): Promise<number> {
    const stats = await fs.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  // -- Configuration and versions --------------------------------------------

  /** `docker compose config` as JSON, with `env` set (and the profiles named). */
  private async config(
    env: Readonly<Record<string, string>>,
    profiles: readonly string[] = [],
  ): Promise<(service: string) => string | null> {
    const result = await this.compose(
      [...profiles.flatMap((profile) => ["--profile", profile]), "config", "--format", "json"],
      { timeoutMs: TIMEOUTS.config, env, maxOutputBytes: 16 * 1024 * 1024 },
    );
    this.expectSuccess(result, "Reading the compose configuration");
    let parsed: { services?: Record<string, { image?: unknown } | undefined> };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // Never quote the output: it holds the resolved environment.
      throw new OpsError(
        "Reading the compose configuration failed.",
        "The output was not valid JSON.",
      );
    }
    return (service: string): string | null => {
      const image = parsed.services?.[service]?.image;
      return typeof image === "string" && image.length > 0 ? image : null;
    };
  }

  async configUpdaterImage(env: Readonly<Record<string, string>>): Promise<string | null> {
    return (await this.config(env, [SERVICES.updater]))(SERVICES.updater);
  }

  async configImages(env: Readonly<Record<string, string>>): Promise<ConfiguredImages> {
    const imageOf = await this.config(env);
    return {
      api: imageOf(SERVICES.api),
      caddy: imageOf(SERVICES.caddy),
      worker: imageOf(SERVICES.worker),
      scheduler: imageOf(SERVICES.scheduler),
    };
  }

  async apiRunningVersion(): Promise<string | null> {
    const ids = await this.compose(["ps", "-q", SERVICES.api], { timeoutMs: TIMEOUTS.quick });
    if (ids.exitCode !== 0) {
      return null;
    }
    const id = ids.stdout.split("\n")[0]?.trim();
    if (!id || !/^[0-9a-f]{12,64}$/.test(id)) {
      return null;
    }
    const inspect = await this.docker(["inspect", "--format", "{{json .Config.Env}}", id], {
      timeoutMs: TIMEOUTS.quick,
    });
    if (inspect.exitCode !== 0) {
      return null;
    }
    try {
      const env = JSON.parse(inspect.stdout) as unknown;
      if (Array.isArray(env)) {
        for (const entry of env) {
          if (typeof entry === "string" && entry.startsWith("RESTOW_VERSION=")) {
            const value = entry.slice("RESTOW_VERSION=".length).trim();
            return value || null;
          }
        }
      }
    } catch {
      // Unreadable: unknown.
    }
    return null;
  }

  // -- Images ---------------------------------------------------------------

  async pull(image: string): Promise<void> {
    assertImageReference(image);
    const result = await this.docker(["pull", image], { timeoutMs: TIMEOUTS.pull });
    if (result.exitCode !== 0) {
      throw new PullError(
        result.timedOut ? "The image pull timed out." : "The image pull failed.",
        result.errorTail,
        !result.timedOut && isManifestNotFound(result.errorTail),
      );
    }
  }

  async imageDigests(image: string): Promise<string[]> {
    assertImageReference(image);
    const result = await this.docker(
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      {
        timeoutMs: TIMEOUTS.quick,
      },
    );
    this.expectSuccess(result, "Inspecting the image");
    try {
      const list = JSON.parse(result.stdout) as unknown;
      if (!Array.isArray(list)) {
        return [];
      }
      return list
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.slice(entry.indexOf("@") + 1))
        .filter((digest) => /^sha256:[0-9a-f]{64}$/.test(digest));
    } catch {
      return [];
    }
  }

  async verifySignature(check: SignatureCheck): Promise<void> {
    if (
      !IMAGE_BY_DIGEST.test(check.image) ||
      !SIGNER_IDENTITY.test(check.certificateIdentity) ||
      !OIDC_ISSUER.test(check.certificateOidcIssuer) ||
      !DIGEST_PINNED_IMAGE.test(check.verifierImage)
    ) {
      throw new SignatureError("The signature check is not valid.");
    }
    // cosign runs in its own short-lived container (pinned by digest, no capabilities,
    // read-only, only /tmp writable); it needs the network for the registry and for
    // Sigstore's trust root. The label lets a restarted updater remove a leftover.
    const result = await this.docker(
      [
        "run",
        "--rm",
        "--label",
        `${HELPER_LABEL}=1`,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=64m",
        "--env",
        "HOME=/tmp",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        check.verifierImage,
        "verify",
        "--certificate-identity",
        check.certificateIdentity,
        "--certificate-oidc-issuer",
        check.certificateOidcIssuer,
        check.image,
      ],
      { timeoutMs: TIMEOUTS.verifySignature, maxOutputBytes: 1024 * 1024 },
    );
    if (result.exitCode !== 0) {
      throw new SignatureError(
        result.timedOut
          ? "The signature check timed out."
          : `The signature check failed (exit code ${result.exitCode}).`,
        result.errorTail,
      );
    }
  }

  async build(spec: BuildSpec): Promise<void> {
    if (!path.isAbsolute(spec.contextDir) || spec.contextDir.includes("\0")) {
      throw new OpsError("The build context must be an absolute path.");
    }
    if (!LOCAL_TAG.test(spec.tag)) {
      throw new OpsError("The image tag is not valid.");
    }
    const args: string[] = ["build", "--target", spec.target, "--tag", spec.tag];
    for (const [name, value] of Object.entries(spec.buildArgs)) {
      if (!BUILD_ARG_NAME.test(name) || !BUILD_ARG_VALUE.test(value)) {
        throw new OpsError("A build argument is not valid.");
      }
      args.push("--build-arg", `${name}=${value}`);
    }
    args.push(spec.contextDir);
    const result = await this.docker(args, {
      timeoutMs: TIMEOUTS.build,
      env: { DOCKER_BUILDKIT: "1" },
    });
    this.expectSuccess(result, "Building the image");
  }

  // -- Database -------------------------------------------------------------

  async migrationCount(): Promise<number> {
    const { user, db } = await this.options.postgres();
    const result = await this.compose(
      [
        "exec",
        "-T",
        SERVICES.postgres,
        "psql",
        "-U",
        user,
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
        "-Atc",
        MIGRATION_COUNT_SQL,
      ],
      { timeoutMs: TIMEOUTS.psql },
    );
    this.expectSuccess(result, "Reading the migration count");
    const text = result.stdout.trim();
    if (!/^\d+$/.test(text)) {
      throw new OpsError(
        "Reading the migration count failed.",
        "The database answered with an unexpected value.",
      );
    }
    return Number(text);
  }

  async dumpDatabase(file: string): Promise<void> {
    this.assertDumpPath(file);
    const { user, db } = await this.options.postgres();
    const result = await this.compose(
      ["exec", "-T", SERVICES.postgres, "pg_dump", "-U", user, "-Fc", "-d", db],
      { timeoutMs: TIMEOUTS.dump, stdoutFile: file },
    );
    this.expectSuccess(result, "Dumping the database");
  }

  async verifyDump(file: string): Promise<DumpVerification> {
    this.assertDumpPath(file);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) {
      throw new OpsError("The dump is empty.");
    }
    const handle = await fs.open(file, "r");
    try {
      const header = Buffer.alloc(5);
      await handle.read(header, 0, 5, 0);
      if (header.toString("latin1") !== "PGDMP") {
        throw new OpsError("The dump is not a PostgreSQL custom-format archive.");
      }
    } finally {
      await handle.close();
    }
    const result = await this.compose(["exec", "-T", SERVICES.postgres, "pg_restore", "--list"], {
      timeoutMs: TIMEOUTS.verify,
      stdinFile: file,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    this.expectSuccess(result, "Reading the dump");
    const entries = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith(";")).length;
    if (entries === 0) {
      throw new OpsError("The dump has no content.");
    }
    return { bytes: stat.size, entries };
  }

  // -- Compose --------------------------------------------------------------

  async composeStop(services: readonly string[], timeoutSeconds: number): Promise<void> {
    assertServices(services);
    const result = await this.compose(
      ["stop", "-t", String(Math.max(0, Math.floor(timeoutSeconds))), ...services],
      {
        timeoutMs: TIMEOUTS.up + timeoutSeconds * 1000,
      },
    );
    this.expectSuccess(result, "Stopping services");
  }

  async composeUp(services: readonly string[]): Promise<void> {
    assertServices(services);
    const result = await this.compose(
      ["up", "-d", "--no-deps", "--no-build", "--pull", "never", ...services],
      { timeoutMs: TIMEOUTS.up },
    );
    this.expectSuccess(result, "Starting services");
  }

  async composeStart(services: readonly string[]): Promise<void> {
    assertServices(services);
    const result = await this.compose(["start", ...services], { timeoutMs: TIMEOUTS.up });
    this.expectSuccess(result, "Starting services");
  }

  async servicesState(): Promise<ServiceState[]> {
    const result = await this.compose(["ps", "-a", "--format", "json"], {
      timeoutMs: TIMEOUTS.quick,
    });
    this.expectSuccess(result, "Reading the service states");
    return parseComposePs(result.stdout);
  }

  async apiLogsTail(lines: number): Promise<string> {
    const count = Math.max(1, Math.min(500, Math.floor(lines)));
    const result = await this.compose(
      ["logs", "--no-color", "--no-log-prefix", "--tail", String(count), SERVICES.api],
      { timeoutMs: TIMEOUTS.quick, maxOutputBytes: 256 * 1024 },
    );
    if (result.exitCode !== 0) {
      return "";
    }
    const text = result.stdout.trim() ? result.stdout : result.errorTail;
    return this.options.redactor.tail(text, 1500);
  }

  // -- Plumbing -------------------------------------------------------------

  private assertDumpPath(file: string): void {
    if (path.dirname(file) !== this.options.dumpsDir || !isDumpFileName(path.basename(file))) {
      throw new OpsError("The file is not a dump file of this updater.");
    }
  }

  private baseCompose(): string[] {
    const args = ["compose", "-p", this.options.projectName];
    if (this.options.composeFile) {
      args.push("-f", this.options.composeFile);
    }
    return args;
  }

  private compose(
    args: readonly string[],
    options: {
      timeoutMs: number;
      env?: Readonly<Record<string, string>>;
      stdoutFile?: string;
      stdinFile?: string;
      maxOutputBytes?: number;
    },
  ): Promise<CommandResult> {
    return this.options.runner.run({
      argv: ["docker", ...this.baseCompose(), ...args],
      ...options,
    });
  }

  private docker(
    args: readonly string[],
    options: { timeoutMs: number; env?: Readonly<Record<string, string>>; maxOutputBytes?: number },
  ): Promise<CommandResult> {
    return this.options.runner.run({ argv: ["docker", ...args], ...options });
  }

  private expectSuccess(result: CommandResult, action: string): void {
    if (result.exitCode === 0) {
      return;
    }
    throw new OpsError(
      result.timedOut ? `${action} timed out.` : `${action} failed (exit code ${result.exitCode}).`,
      result.errorTail,
    );
  }
}

function assertImageReference(image: string): void {
  if (!IMAGE_REFERENCE.test(image)) {
    throw new OpsError("The image reference is not valid.");
  }
}

function assertServices(services: readonly string[]): void {
  if (services.length === 0 || services.some((service) => !SERVICE_NAME.test(service))) {
    throw new OpsError("A service name is not valid.");
  }
}

/**
 * The registry answered that this tag does not exist (as opposed to any other pull
 * problem). Docker words it differently by image store:
 *
 *   classic:     `manifest for <ref> not found: manifest unknown: manifest unknown`
 *   containerd:  `failed to resolve reference "<ref>": <ref>: not found`
 *
 * Access problems (`denied`, `unauthorized`, a rate limit) are never "not found": the
 * image may well exist, and the operator must see the real reason.
 */
export function isManifestNotFound(text: string): boolean {
  if (
    /denied|unauthorized|forbidden|requires 'docker login'|rate limit|toomanyrequests/i.test(text)
  ) {
    return false;
  }
  return (
    /manifest unknown|manifest for .+ not found|no such manifest|not found: manifest/i.test(text) ||
    /failed to resolve reference .+: not found\s*$/i.test(text.trim())
  );
}

/** `docker compose ps --format json`: a JSON array (older Compose) or one object per line (newer). */
export function parseComposePs(output: string): ServiceState[] {
  const text = output.trim();
  if (!text) {
    return [];
  }
  let entries: unknown[];
  try {
    const parsed = JSON.parse(text) as unknown;
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        throw new OpsError("Reading the service states failed.", "The output was not valid JSON.");
      }
    }
  }
  const states: ServiceState[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const service = record.Service;
    const state = record.State;
    if (typeof service !== "string" || typeof state !== "string") {
      continue;
    }
    const health = typeof record.Health === "string" && record.Health ? record.Health : null;
    const exitCode = typeof record.ExitCode === "number" ? record.ExitCode : null;
    states.push({ service, state: state.toLowerCase(), health, exitCode });
  }
  return states;
}
