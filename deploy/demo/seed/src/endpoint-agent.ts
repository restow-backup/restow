import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentApi, AgentConfig, AgentTask, SampleFile } from "./agent-api.js";
import type { DemoMachine } from "./endpoint-files.js";
import type { Rng } from "./prng.js";
import { randomInt } from "./prng.js";
import { rewriteRepositoryUrl } from "./restic-proxy.js";
import { type BackupSummary, Restic, type ResticNode } from "./restic.js";

/**
 * A simulated Restow agent (agent/internal/core): what the demo seed plays for
 * each simulated machine. It enrolls with a one-time token, keeps the
 * configuration the server hands out, answers heartbeats, runs real restic
 * backups of the machine's folders, records the SHA-256 of a few sample files
 * for the restore test, runs the restore tests the server hands back
 * (`verify_sample`) and reports every run to the real agent API with the
 * run log, the statistics and the errors, the way the Go agent does.
 */

/** The version the simulated agents report: the agent's own (agent/dist/VERSION). */
export const AGENT_VERSION = "0.2.0";
const SNAPSHOT_TAG = "restow-agent";
/** Files per restore test. The agent takes up to 20; the demo keeps its nightly reset short. */
export const SAMPLE_FILES = 6;
const SAMPLE_POOL = 4 * SAMPLE_FILES;
const SAMPLE_MAX_FILE_SIZE = 256 * 1024 * 1024;
/** How far a file's modification time may differ from the snapshot's record (agent/internal/core/sample.go). */
const MTIME_SLACK_MS = 2000;

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Binary units, one decimal (agent/internal/core/util.go `formatBytes`). */
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  let div = 1024;
  let exp = 0;
  for (let m = Math.floor(n / 1024); m >= 1024; m = Math.floor(m / 1024)) {
    div *= 1024;
    exp += 1;
  }
  return `${(n / div).toFixed(1)} ${"KMGTPE"[exp]}iB`;
}

/**
 * The log of one run, kept as the last 200 lines and sent with the end of the
 * run (agent/internal/runlog). Line times come from a clock the caller sets, so
 * a backup played back for a past day logs that day.
 */
export class RunLog {
  private readonly lines: string[] = [];

  constructor(private readonly now: () => Date) {}

  private add(level: string, message: string): void {
    const stamp = `${this.now().toISOString().slice(0, 19)}Z`;
    this.lines.push(`${stamp} ${level} ${message.slice(0, 2000)}`);
    if (this.lines.length > 200) {
      this.lines.shift();
    }
  }

  info(message: string): void {
    this.add("INFO", message);
  }

  warn(message: string): void {
    this.add("WARN", message);
  }

  error(message: string): void {
    this.add("ERROR", message);
  }

  /** Output of restic, one line per input line. */
  raw(source: string, text: string): void {
    for (const line of text.split("\n")) {
      if (line.trim() !== "") {
        this.add("INFO", `${source}: ${line.trim()}`);
      }
    }
  }

  tail(): string {
    return this.lines.join("\n");
  }
}

/** A reservoir sample of the regular, non-empty files of a snapshot (agent/internal/restic/ls.go). */
export function sampleCandidates(
  nodes: Iterable<ResticNode>,
  rng: Rng,
  want = SAMPLE_FILES,
  pool = SAMPLE_POOL,
): ResticNode[] {
  const kept: ResticNode[] = [];
  let seen = 0;
  for (const node of nodes) {
    if (
      node.type !== "file" ||
      node.size === 0 ||
      !node.path.startsWith("/") ||
      node.size > SAMPLE_MAX_FILE_SIZE
    ) {
      continue;
    }
    seen += 1;
    if (kept.length < Math.max(pool, want)) {
      kept.push(node);
    } else {
      const slot = randomInt(rng, 0, seen - 1);
      if (slot < kept.length) {
        kept[slot] = node;
      }
    }
  }
  for (let index = kept.length - 1; index > 0; index--) {
    const other = randomInt(rng, 0, index);
    [kept[index], kept[other]] = [kept[other] as ResticNode, kept[index] as ResticNode];
  }
  return kept;
}

function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha256: hash.digest("hex"), size }));
  });
}

/**
 * The hash of a file as the snapshot holds it: taken from the file on disk, but
 * only when it is provably unchanged since the snapshot saw it (same size and
 * modification time before and after hashing), so a later mismatch points at the
 * backup and not at a file edited afterwards (agent/internal/core/sample.go).
 */
export async function hashUnchanged(node: ResticNode): Promise<SampleFile | null> {
  try {
    const before = lstatSync(node.path);
    if (!before.isFile() || before.size !== node.size) {
      return null;
    }
    if (node.mtime && Math.abs(before.mtimeMs - node.mtime.getTime()) > MTIME_SLACK_MS) {
      return null;
    }
    const { sha256, size } = await sha256File(node.path);
    const after = lstatSync(node.path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || size !== before.size) {
      return null;
    }
    return { path: node.path, sha256, size };
  } catch {
    return null;
  }
}

export interface BackupOutcome {
  runId: string;
  snapshotId: string;
  status: "succeeded" | "partial";
  summary: BackupSummary;
  sample: SampleFile[];
}

export interface SimAgentOptions {
  machine: DemoMachine;
  api: AgentApi;
  /** `http://127.0.0.1:<port>` of the proxy restic talks to (restic-proxy.ts). */
  proxyOrigin: string;
  resticBin: string;
  /** Private working folder: restic's cache and temporary files. */
  workDir: string;
  /** Seeds the choice of the sample files. */
  rng: Rng;
  log: (message: string) => void;
}

export interface AgentState {
  hostname: string;
  endpointId: string;
  agentSecret: string;
  agentVersion: string;
  osVersion: string;
  configVersion: number;
  profile: "server" | "client";
  schedule: AgentConfig["schedule"];
}

export class SimAgent {
  endpointId = "";
  agentSecret = "";
  private repository = "";
  private repositoryPassword = "";
  private restic: Restic | null = null;
  private config: AgentConfig | null = null;
  private resticVersion = "";
  private clock: () => Date = () => new Date();

  constructor(private readonly options: SimAgentOptions) {}

  get machine(): DemoMachine {
    return this.options.machine;
  }

  get enrolled(): boolean {
    return this.endpointId !== "";
  }

  get configVersion(): number {
    return Number(this.config?.configVersion ?? 0);
  }

  /** Enroll with a one-time token, as `restow-agent enroll` does, and prove the access works. */
  async enroll(token: string): Promise<void> {
    const { machine, api } = this.options;
    const answer = await api.enroll({
      token,
      hostname: machine.hostname,
      os: machine.os,
      arch: machine.arch,
      agentVersion: AGENT_VERSION,
      osVersion: machine.osVersion,
    });
    this.endpointId = String(answer.endpointId);
    this.agentSecret = answer.agentSecret;
    // The server hands out its public address; inside the demo's network the
    // simulated agent reaches the same endpoint through the proxy.
    this.repository = rewriteRepositoryUrl(answer.repository.url, this.options.proxyOrigin);
    this.repositoryPassword = answer.repository.password;
    this.config = answer.config ?? null;
    api.setCredentials({ endpointId: this.endpointId, secret: this.agentSecret });
    const restic = this.newRestic((line) => this.options.log(`restic: ${line}`));
    this.restic = restic;
    this.resticVersion = await restic.version();
    await this.fetchConfig();
    await restic.checkAccess();
    this.options.log(
      `${machine.hostname} enrolled as ${this.endpointId} (restic ${this.resticVersion})`,
    );
  }

  /** The agent's state, for the heartbeat sidecar (heartbeat.ts) and a later look. */
  state(): AgentState {
    const { machine } = this.options;
    return {
      hostname: machine.hostname,
      endpointId: this.endpointId,
      agentSecret: this.agentSecret,
      agentVersion: AGENT_VERSION,
      osVersion: machine.osVersion,
      configVersion: this.configVersion,
      profile: machine.kind,
      schedule: this.config?.schedule ?? { kind: "daily" },
    };
  }

  private newRestic(log: (line: string) => void): Restic {
    const { workDir, resticBin, machine } = this.options;
    return new Restic({
      bin: resticBin,
      repository: this.repository,
      password: this.repositoryPassword,
      restUser: this.endpointId,
      restPass: this.agentSecret,
      cacheDir: join(workDir, machine.hostname, "cache"),
      tmpDir: join(workDir, machine.hostname, "tmp"),
      log,
    });
  }

  async fetchConfig(): Promise<AgentConfig> {
    this.config = await this.options.api.config();
    return this.config;
  }

  /** One heartbeat; every task the answer carries is carried out. */
  async heartbeat(nextRunAt: Date | null = null): Promise<AgentTask[]> {
    const { api, machine } = this.options;
    const answer = await api.heartbeat({
      agentVersion: AGENT_VERSION,
      osVersion: machine.osVersion,
      state: "idle",
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
      configVersion: this.configVersion,
    });
    for (const task of answer.tasks) {
      await this.perform(task);
    }
    return answer.tasks;
  }

  private async perform(task: AgentTask): Promise<void> {
    switch (task.kind) {
      case "update_config":
        await this.fetchConfig();
        return;
      case "verify_sample":
        await this.verifySample(task);
        return;
      default:
        // The demo never asks the simulated machines for a backup now or a restore:
        // the demo guard refuses every request that would queue one.
        this.options.log(`${this.machine.hostname}: ignoring a ${task.kind} task`);
    }
  }

  /** Keep the clock of the run log on the simulated day of the run. */
  private clockFrom(at: Date): () => Date {
    const started = Date.now();
    return () => new Date(at.getTime() + (Date.now() - started));
  }

  /**
   * One backup, as the agent's `runBackup` does it: fetch the configuration, start
   * the run, back up the folders that exist with the configured excludes (and
   * never the agent's own working files), record the sample for the restore test,
   * finish the run. `at` is the moment the snapshot stands for.
   */
  async backup(at: Date): Promise<BackupOutcome> {
    const { api, machine, rng } = this.options;
    const restic = this.restic;
    if (!restic) {
      throw new Error("the simulated agent is not enrolled");
    }
    const config = await this.fetchConfig();
    const clock = this.clockFrom(at);
    const log = new RunLog(clock);
    const runLog = (line: string) => log.raw("restic", line);
    const runner = this.newRestic(runLog);
    const runId = await api.startRun({ kind: "backup", startedAt: new Date().toISOString() });
    log.info(
      `Run started (backup, trigger: scheduled). Agent ${AGENT_VERSION}, restic ${this.resticVersion}.`,
    );

    const sources: string[] = [];
    for (const path of config.paths) {
      if (existsSync(path)) {
        sources.push(path);
      } else {
        log.warn(`Path ${path} does not exist on this machine and is skipped.`);
      }
    }
    if (sources.length === 0) {
      const message = `None of the configured backup paths exists on this machine: ${config.paths.join(", ")}.`;
      log.error(message);
      await api.finishRun(runId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        errors: [{ message, code: "no_paths" }],
        logTail: log.tail(),
      });
      throw new Error(`${machine.hostname}: ${message}`);
    }
    log.info(`Backing up: ${sources.join(", ")}`);
    const excludes = [
      ...config.excludes,
      join(this.options.workDir, machine.hostname, "cache"),
      join(this.options.workDir, machine.hostname, "tmp"),
      "Restow-Restore-*",
    ];
    let result: Awaited<ReturnType<Restic["backup"]>>;
    try {
      result = await runner.backup({
        paths: sources,
        excludes,
        host: machine.hostname,
        tags: [SNAPSHOT_TAG],
        time: at,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(message);
      await api.finishRun(runId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        errors: [{ message, code: "restic_error" }],
        logTail: log.tail(),
      });
      throw error;
    }
    const s = result.summary;
    log.info(
      `Snapshot ${shortId(result.snapshotId)} saved: ${s.filesNew} new, ${s.filesChanged} changed, ${s.filesUnmodified} unchanged files; ${formatBytes(s.totalBytesProcessed)} processed, ${formatBytes(s.dataAdded)} added to the repository.`,
    );
    if (result.partial) {
      log.warn(
        `Some files could not be read (${result.errors.length} errors); the snapshot is incomplete. Details are listed in the errors of this run.`,
      );
    }
    const sample = await this.collectSample(runner, result.snapshotId, log, rng);
    const status = result.partial ? "partial" : "succeeded";
    log.info(`Run finished: ${status}.`);
    await api.finishRun(runId, {
      status,
      finishedAt: new Date().toISOString(),
      snapshotId: result.snapshotId,
      stats: {
        filesNew: s.filesNew,
        filesChanged: s.filesChanged,
        filesUnmodified: s.filesUnmodified,
        dataAdded: s.dataAdded,
        totalFilesProcessed: s.totalFilesProcessed,
        totalBytesProcessed: s.totalBytesProcessed,
      },
      sample,
      errors: result.errors.map((e) => ({ path: e.path, message: e.message, code: e.during })),
      logTail: log.tail(),
    });
    return {
      runId,
      snapshotId: result.snapshotId,
      status,
      summary: s,
      sample,
    };
  }

  private async collectSample(
    runner: Restic,
    snapshotId: string,
    log: RunLog,
    rng: Rng,
  ): Promise<SampleFile[]> {
    const nodes = await runner.ls(snapshotId);
    const sample: SampleFile[] = [];
    for (const node of sampleCandidates(nodes, rng)) {
      if (sample.length >= SAMPLE_FILES) {
        break;
      }
      const hashed = await hashUnchanged(node);
      if (hashed) {
        sample.push(hashed);
      }
    }
    if (sample.length === 0) {
      log.warn("No sample files could be recorded for restore tests.");
    } else {
      log.info(`Recorded SHA-256 of ${sample.length} sample files for restore tests.`);
    }
    return sample;
  }

  /**
   * A `verify_sample` task: restore the listed files into a temporary folder,
   * compare their SHA-256 with the expected values, delete the copy and report
   * (agent/internal/core/verify.go).
   */
  async verifySample(task: AgentTask): Promise<void> {
    const { api, workDir, machine } = this.options;
    const params = (task.params ?? {}) as { snapshotId?: string; files?: SampleFile[] };
    const log = new RunLog(() => new Date());
    const runId = await api.startRun({
      kind: "verify_sample",
      taskId: task.id,
      startedAt: new Date().toISOString(),
    });
    log.info(
      `Run started (verify_sample, trigger: task). Agent ${AGENT_VERSION}, restic ${this.resticVersion}.`,
    );
    const fail = async (code: string, message: string) => {
      log.error(message);
      await api.finishRun(runId, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        errors: [{ message, code }],
        logTail: log.tail(),
      });
    };
    const files = params.files ?? [];
    if (!params.snapshotId || files.length === 0) {
      await fail("invalid_task", "The restore test lists no files or no snapshot.");
      return;
    }
    const base = join(workDir, machine.hostname, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const target = mkdtempSync(join(base, "verify-"));
    try {
      log.info(
        `Restoring ${files.length} sample file(s) of snapshot ${shortId(params.snapshotId)} into a temporary folder.`,
      );
      await this.newRestic((line) => log.raw("restic", line)).restore({
        snapshotId: params.snapshotId,
        target,
        includes: files.map((file) => file.path),
      });
      const errors: { path: string; message: string; code: string }[] = [];
      const verified: SampleFile[] = [];
      for (const file of files) {
        const local = join(target, file.path);
        try {
          const { sha256, size } = await sha256File(local);
          if (sha256.toLowerCase() === file.sha256.toLowerCase()) {
            verified.push({ path: file.path, sha256: sha256.toLowerCase(), size });
          } else {
            errors.push({
              path: file.path,
              code: "hash_mismatch",
              message: `SHA-256 mismatch: expected ${file.sha256.toLowerCase()}, restored file has ${sha256}.`,
            });
          }
        } catch {
          errors.push({
            path: file.path,
            code: "missing",
            message: "The file was not restored (not found in the snapshot).",
          });
        }
      }
      if (errors.length > 0) {
        log.error(`Restore test failed: ${errors.length} of ${files.length} files did not match.`);
      } else {
        log.info(
          `Restore test passed: all ${verified.length} files restored with matching SHA-256.`,
        );
      }
      log.info("The temporary copy was deleted.");
      await api.finishRun(runId, {
        status: errors.length > 0 ? "failed" : "succeeded",
        finishedAt: new Date().toISOString(),
        snapshotId: params.snapshotId,
        sample: verified,
        errors,
        logTail: log.tail(),
      });
    } catch (error) {
      await fail("restic_error", error instanceof Error ? error.message : String(error));
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }
}
