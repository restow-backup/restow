import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import type { z } from "zod";
import type { DumpStore } from "./dumps.js";
import type { Logger } from "./logger.js";
import type { Clock, DockerOps } from "./ops.js";
import type { Redactor } from "./redact.js";
import type { RestoreOps } from "./restore-ops.js";
import {
  type RestoreRecord,
  type RestoreStart,
  type restoreActorSchema,
  restoreRecordSchema,
} from "./restore-protocol.js";
import { type RestoreReport, restoreReportSchema } from "./restore-report.js";
import { writeAtomic } from "./store.js";

/**
 * A restore from a database dump in the setup wizard (docs/DATABASE.md, "Restore an installation
 * from a dump"), on a fresh installation whose setup has not run. The order is what keeps the
 * restored data safe: no worker and no scheduler, which run the deleting passes, ever start on
 * restored data before restore mode is on in it.
 *
 *   1. restoring              worker and scheduler stop; the dump is restored into the scratch
 *                             database `restow_restore` (the live database stays the fresh one)
 *   2. preparing              `restow restore prepare`: migrated, restore mode switched on (the
 *                             first write), master key and storage checked (the report)
 *   3. awaiting_confirmation  the operator reads the report in the wizard and activates or aborts
 *   4. activating             the api stops, `restow restore activate` makes the scratch database
 *                             the live one, the api starts and must become healthy
 *   5. starting               only now worker and scheduler start, on the restored database
 *
 * A refusal (wrong master key, a dump of a newer release, ...), a failure before the activation
 * and an abort drop the scratch database and start worker and scheduler again: the live database
 * is still the fresh one. A failure from the activation on, and an updater restart in the middle
 * of a step, end `needs_attention`: worker and scheduler are never started by themselves then
 * (docs/DATABASE.md, "When a restore needs attention", has the commands to finish by hand; the
 * wizard's last step reads the status from the public setup state and shows them).
 */

const WORKER_SERVICES = ["worker", "scheduler"] as const;
const STOP_SECONDS = 90;
const POLL_MS = 2000;
const CRASHED = ["restarting", "exited", "dead"];

export class RestoreRefusedError extends Error {
  constructor(
    readonly code: "busy" | "not_found" | "blocked" | "invalid_request",
    message: string,
  ) {
    super(message);
    this.name = "RestoreRefusedError";
  }
}

class StepFailure extends Error {}

export interface DatabaseRestorerDeps {
  ops: Pick<DockerOps, "composeStop" | "composeUp" | "servicesState">;
  restore: RestoreOps;
  dumps: Pick<DumpStore, "pathOf" | "sizeOf">;
  /** Where the restore's record is kept (`/state/restore.json`). */
  stateFile: string;
  clock: Clock;
  logger: Logger;
  redactor: Redactor;
  /** What else runs that a restore must not overlap (an update, a move): why, or null. */
  otherActivity: () => string | null;
  /** How long the api gets to become healthy after the activation. */
  healthTimeoutSeconds: number;
}

type Actor = z.infer<typeof restoreActorSchema>;

export class DatabaseRestorer {
  private record: RestoreRecord | null = null;
  private execution: Promise<void> | null = null;

  constructor(private readonly deps: DatabaseRestorerDeps) {}

  /** Load the record; a step that was running when the updater stopped needs attention. */
  async init(): Promise<void> {
    try {
      const parsed = restoreRecordSchema.safeParse(
        JSON.parse(await fs.readFile(this.deps.stateFile, "utf8")),
      );
      this.record = parsed.success ? parsed.data : null;
    } catch {
      this.record = null;
    }
    if (this.record?.status === "running") {
      this.deps.logger.warn(
        `The restore ${this.record.id} was interrupted in phase ${this.record.phase}; worker and scheduler are not started by themselves (docs/DATABASE.md).`,
      );
      await this.finish("needs_attention", "The updater restarted during the restore.");
    }
  }

  view(): RestoreRecord | null {
    return this.record;
  }

  /** A restore runs or waits for its confirmation: nothing else may change the database. */
  active(): boolean {
    return (
      this.execution !== null ||
      this.record?.status === "running" ||
      this.record?.status === "awaiting_confirmation"
    );
  }

  /** The dump a restore uses (never pruned or deleted meanwhile). */
  protectedDump(): string | null {
    return this.record && this.record.status !== "done" ? this.record.dump : null;
  }

  async settled(): Promise<void> {
    await (this.execution ?? Promise.resolve());
  }

  async start(request: RestoreStart): Promise<RestoreRecord> {
    if (this.active()) {
      throw new RestoreRefusedError("busy", "A restore is running or waits for its confirmation.");
    }
    const other = this.deps.otherActivity();
    if (other) {
      throw new RestoreRefusedError("busy", other);
    }
    let file: string;
    try {
      file = this.deps.dumps.pathOf(request.dump);
    } catch {
      throw new RestoreRefusedError("not_found", "There is no such dump.");
    }
    if ((await this.deps.dumps.sizeOf(request.dump)) === null) {
      throw new RestoreRefusedError("not_found", "There is no such dump.");
    }
    this.record = {
      id: randomBytes(8).toString("hex"),
      status: "running",
      phase: "restoring",
      dump: request.dump,
      startedAt: this.deps.clock.now().toISOString(),
      finishedAt: null,
      report: null,
      message: null,
      requestedBy: request.requestedBy,
      servicesStopped: false,
    };
    await this.save();
    this.deps.logger.info(
      `Restore ${this.record.id} of ${request.dump} started, as ${request.requestedBy.label} asked.`,
    );
    this.run(() => this.restoreAndPrepare(file));
    return this.record;
  }

  async activate(input: {
    acceptUnreachable: boolean;
    requestedBy: Actor;
  }): Promise<RestoreRecord> {
    const record = this.record;
    if (record?.status !== "awaiting_confirmation" || this.execution) {
      throw new RestoreRefusedError("invalid_request", "No restore waits for its confirmation.");
    }
    if ((record.report?.storage.unreachable ?? 0) > 0 && !input.acceptUnreachable) {
      throw new RestoreRefusedError(
        "blocked",
        "Storage targets of the restored installation could not be read; confirm that you go ahead without them.",
      );
    }
    this.deps.logger.info(`Restore ${record.id} activated, as ${input.requestedBy.label} asked.`);
    record.status = "running";
    record.phase = "activating";
    await this.save();
    this.run(() => this.activateAndStart());
    return record;
  }

  async abort(input: { requestedBy: Actor }): Promise<RestoreRecord> {
    const record = this.record;
    if (record?.status !== "awaiting_confirmation" || this.execution) {
      throw new RestoreRefusedError("invalid_request", "No restore waits for its confirmation.");
    }
    this.deps.logger.info(`Restore ${record.id} aborted, as ${input.requestedBy.label} asked.`);
    record.status = "running";
    await this.save();
    this.run(async () => {
      await this.rollBack("aborted", "Aborted at the confirmation; nothing was changed.");
    });
    return record;
  }

  // ---------------------------------------------------------------------------

  private run(step: () => Promise<void>): void {
    this.execution = step()
      .catch(async (error: unknown) => {
        const message = this.deps.redactor.oneLine(
          error instanceof Error ? error.message : String(error),
          400,
        );
        this.deps.logger.error(`Restore failed: ${message}`);
        await this.finish("needs_attention", message).catch(() => undefined);
      })
      .finally(() => {
        this.execution = null;
      });
  }

  private async restoreAndPrepare(file: string): Promise<void> {
    const record = this.current();
    try {
      // First of all: nothing that deletes may run while restored data appears.
      await this.deps.ops.composeStop([...WORKER_SERVICES], STOP_SECONDS);
      record.servicesStopped = true;
      await this.save();
      await this.deps.restore.createScratch();
      await this.deps.restore.restoreDump(file);
      record.phase = "preparing";
      await this.save();
      const result = await this.deps.restore.restoreCli("prepare", [
        "--json",
        "--dump-name",
        record.dump,
        "--via",
        "setup wizard",
      ]);
      const report = parseReport(result.stdout);
      if (!report) {
        throw new StepFailure(
          `restow restore prepare ended with exit code ${result.exitCode}: ${this.deps.redactor.oneLine(result.errorTail, 300)}`,
        );
      }
      record.report = report;
      if (!report.ok) {
        await this.rollBack("refused", report.refusal?.message ?? "The dump was refused.");
        return;
      }
      record.status = "awaiting_confirmation";
      record.phase = "awaiting_confirmation";
      await this.save();
      this.deps.logger.info(`Restore ${record.id} is prepared and waits for its confirmation.`);
    } catch (error) {
      const message = this.deps.redactor.oneLine(
        error instanceof Error
          ? `${error.message} ${(error as { detail?: string }).detail ?? ""}`
          : String(error),
        400,
      );
      await this.rollBack("failed", message);
    }
  }

  /** Before the activation: the fresh database is untouched, so it runs again as before. */
  private async rollBack(status: "refused" | "failed" | "aborted", message: string): Promise<void> {
    const record = this.current();
    try {
      await this.deps.restore.dropScratch();
    } catch (error) {
      this.deps.logger.warn(
        `The database of the restore could not be dropped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (record.servicesStopped) {
      try {
        await this.deps.ops.composeUp([...WORKER_SERVICES]);
        record.servicesStopped = false;
      } catch (error) {
        await this.finish(
          "needs_attention",
          `${message} Worker and scheduler could not be started again: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    await this.finish(status, message);
  }

  private async activateAndStart(): Promise<void> {
    const record = this.current();
    await this.deps.ops.composeStop(["api"], STOP_SECONDS);
    const result = await this.deps.restore.restoreCli("activate", ["--json"]);
    if (result.exitCode !== 0) {
      // The live database is whatever it was (activate refuses before it renames anything, or
      // finishes a half swap next time): the api serves again, worker and scheduler stay stopped.
      await this.deps.ops.composeUp(["api"]).catch(() => undefined);
      throw new StepFailure(
        `restow restore activate ended with exit code ${result.exitCode}: ${this.deps.redactor.oneLine(result.errorTail, 300)}`,
      );
    }
    await this.deps.ops.composeUp(["api"]);
    await this.waitHealthy("api");
    record.phase = "starting";
    await this.save();
    // Only now: the live database is the restored one, with restore mode on.
    await this.deps.ops.composeUp([...WORKER_SERVICES]);
    record.servicesStopped = false;
    await this.finish("done", null);
    this.deps.logger.info(`Restore ${record.id} is live; restore mode is on.`);
  }

  private async waitHealthy(service: string): Promise<void> {
    const deadline = this.deps.clock.now().getTime() + this.deps.healthTimeoutSeconds * 1000;
    let crashed = 0;
    for (;;) {
      const state = (await this.deps.ops.servicesState()).find(
        (entry) => entry.service === service,
      );
      if (state?.state === "running" && (state.health === "healthy" || state.health === null)) {
        return;
      }
      if (state && CRASHED.includes(state.state)) {
        crashed += 1;
        if (crashed >= 2) {
          throw new StepFailure(`The ${service} did not start on the restored database.`);
        }
      }
      if (this.deps.clock.now().getTime() > deadline) {
        throw new StepFailure(
          `The ${service} did not become healthy within ${this.deps.healthTimeoutSeconds} s.`,
        );
      }
      await this.deps.clock.sleep(POLL_MS);
    }
  }

  private current(): RestoreRecord {
    if (!this.record) {
      throw new Error("no restore record");
    }
    return this.record;
  }

  private async finish(status: RestoreRecord["status"], message: string | null): Promise<void> {
    const record = this.current();
    record.status = status;
    record.message = message;
    record.finishedAt = this.deps.clock.now().toISOString();
    await this.save();
  }

  private async save(): Promise<void> {
    if (this.record) {
      await writeAtomic(this.deps.stateFile, JSON.stringify(this.record));
    }
  }
}

/** The report `restow restore prepare --json` printed (its last line). */
export function parseReport(stdout: string): RestoreReport | null {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("{"))
    .at(-1);
  if (!line) {
    return null;
  }
  try {
    const parsed = restoreReportSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
