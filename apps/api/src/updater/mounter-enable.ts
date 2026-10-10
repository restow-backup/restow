import { type EnvFile, MOUNTER_IMAGE_KEY, UPDATER_IMAGE_KEY, envValueOf } from "./env-file.js";
import type { Logger } from "./logger.js";
import type { Clock, DockerOps } from "./ops.js";
import type {
  MounterEnableReason,
  MounterEnableRecord,
  MounterEnableView,
  SelfUpdateRecord,
  UpdaterPhase,
} from "./protocol.js";
import type { Redactor } from "./redact.js";
import { SELF_UPDATE_HELPER_TIMEOUT_MS, type SelfRecreateLauncher } from "./self-update.js";
import { DIGEST_PINNED_IMAGE } from "./signature.js";
import type { StatusStore } from "./store.js";

/**
 * "Enable network shares" (docs/FILESHARES.md 3.9, docs/MOUNTS.md "Enabling it"): an
 * installation that runs the opt-in updater but not the mounter starts the mounter from
 * the web interface. The api forwards the provider owner's request to
 * `POST /v1/mounter/enable`; the updater does what it already does when it moves the
 * mounter after an update (self-update.ts, `moveMounter`):
 *
 *   1. it refuses while an update is scheduled or running, while its own update is
 *      pending, and while an earlier start still runs;
 *   2. it checks that the compose file has the `mounter` service in the profile `mounts`
 *      taking its image from RESTOW_MOUNTER_IMAGE (`docker compose config` with a probe
 *      value);
 *   3. it writes RESTOW_MOUNTER_IMAGE only when the updater itself runs a release image
 *      whose signature it verified (the image its last self-update pinned and
 *      confirmed, {@link verifiedUpdaterImage}); otherwise it leaves the line as it is,
 *      and an empty line lets the mounter pin the image it runs on its first start;
 *   4. its helper container (self-recreate.ts, `MOUNTER_RECREATE_TARGET`: the pinned
 *      Docker CLI image, no network) runs
 *      `docker compose --profile mounts up -d --no-deps --no-build --pull missing mounter`.
 *
 * The outcome is kept in the state document (`mounterEnable`) and shown in the
 * Installation > Network shares section. Switching the mounter off stays a command.
 */

/** How long `POST /v1/mounter/enable` waits for the helper before it answers "running". */
export const MOUNTER_ENABLE_ANSWER_WAIT_MS = 60_000;

/** A probe value for the compose check when nothing is written (a digest no registry has). */
export const MOUNTER_COMPOSE_PROBE = `restow.invalid/mounter-compose-check:0@sha256:${"0".repeat(64)}`;

export class MounterEnableRefusedError extends Error {
  constructor(
    readonly code: "busy",
    message: string,
  ) {
    super(message);
    this.name = "MounterEnableRefusedError";
  }
}

/**
 * The image the updater runs when it is a release image whose signature it verified: the
 * one its last self-update wrote to RESTOW_UPDATER_IMAGE and confirmed by starting with
 * it. An image the updater pinned on its first start (what the operator started, not
 * verified) or a local build gives null.
 */
export function verifiedUpdaterImage(input: {
  updaterImage: string | null;
  selfUpdate: SelfUpdateRecord | null;
}): string | null {
  const image = input.updaterImage ?? "";
  if (!DIGEST_PINNED_IMAGE.test(image)) {
    return null;
  }
  const last = input.selfUpdate;
  return last?.status === "succeeded" && last.image === image ? image : null;
}

export interface MounterEnablerDeps {
  envFile: Pick<EnvFile, "read" | "pinImage">;
  ops: Pick<DockerOps, "configMounterImage">;
  /** The helper that runs `docker compose --profile mounts up -d mounter`; null: none. */
  launcher: SelfRecreateLauncher | null;
  store: StatusStore;
  /** The update engine's phase (an update scheduled or running refuses the start). */
  phase: () => UpdaterPhase;
  clock: Clock;
  logger: Logger;
  redactor: Redactor;
  helperTimeoutMs?: number;
}

export class MounterEnabler {
  private current: Promise<void> | null = null;

  constructor(private readonly deps: MounterEnablerDeps) {}

  view(): MounterEnableView {
    const last = this.deps.store.state.mounterEnable;
    return { last: last ? structuredClone(last) : null };
  }

  /** At start: a start the previous process left running is recorded as interrupted. */
  async reconcile(): Promise<void> {
    const last = this.deps.store.state.mounterEnable;
    if (!last || last.status !== "running") {
      return;
    }
    last.status = "failed";
    last.reason = "interrupted";
    last.finishedAt = this.deps.clock.now().toISOString();
    last.detail = "The updater stopped while it started the mounter.";
    await this.deps.store.save();
  }

  /**
   * Start the mounter. Throws {@link MounterEnableRefusedError} when it may not start
   * now; otherwise records `running` and resolves with the work, which never throws.
   */
  async start(): Promise<{ done: Promise<void> }> {
    const { deps } = this;
    if (this.current) {
      throw new MounterEnableRefusedError("busy", "The mounter is being started already.");
    }
    const phase = deps.phase();
    if (phase === "scheduled" || phase === "running") {
      throw new MounterEnableRefusedError(
        "busy",
        `An update is ${phase}; start the mounter after it has finished.`,
      );
    }
    if (deps.store.state.selfUpdate?.status === "pending") {
      throw new MounterEnableRefusedError(
        "busy",
        "The updater is replacing itself; start the mounter after it has finished.",
      );
    }
    deps.store.state.mounterEnable = {
      status: "running",
      reason: null,
      image: null,
      requestedAt: deps.clock.now().toISOString(),
      finishedAt: null,
      detail: "",
    };
    await deps.store.save();
    const done = this.run()
      .catch(async (error: unknown) => {
        await this.finish("failed", "helper_failed", this.detail(error));
      })
      .finally(() => {
        this.current = null;
      });
    this.current = done;
    return { done };
  }

  private async run(): Promise<void> {
    const { deps } = this;
    let updaterImage: string | null = null;
    try {
      updaterImage = envValueOf(await deps.envFile.read(), UPDATER_IMAGE_KEY);
    } catch {
      updaterImage = null;
    }
    const image = verifiedUpdaterImage({ updaterImage, selfUpdate: deps.store.state.selfUpdate });
    const probe = image ?? MOUNTER_COMPOSE_PROBE;

    let resolved: string | null;
    try {
      resolved = await deps.ops.configMounterImage({ [MOUNTER_IMAGE_KEY]: probe });
    } catch (error) {
      await this.finish("failed", "compose_unsupported", this.detail(error));
      return;
    }
    if (resolved !== probe) {
      await this.finish(
        "failed",
        "compose_unsupported",
        `The compose file has no mounter service in the profile "mounts" that takes its image from ${MOUNTER_IMAGE_KEY} (it resolves to ${resolved ?? "nothing"}). Use the docker-compose.yml of this release.`,
      );
      return;
    }

    if (image) {
      try {
        await deps.envFile.pinImage(MOUNTER_IMAGE_KEY, image);
      } catch (error) {
        await this.finish("failed", "env_write_failed", this.detail(error));
        return;
      }
      await this.note({ image });
      deps.logger.info(
        `${MOUNTER_IMAGE_KEY} is now ${image} (the verified image this updater runs); starting the mounter.`,
      );
    } else {
      deps.logger.info(
        `Starting the mounter; ${MOUNTER_IMAGE_KEY} stays as it is (empty: the mounter pins the image it runs on its first start).`,
      );
    }

    if (!deps.launcher) {
      await this.finish(
        "failed",
        "launch_failed",
        "No Docker Engine API to start the helper container with.",
      );
      return;
    }
    let handle: Awaited<ReturnType<SelfRecreateLauncher["launch"]>>;
    try {
      handle = await deps.launcher.launch();
    } catch (error) {
      await this.finish("failed", "launch_failed", this.detail(error));
      return;
    }
    const result = await handle.wait(deps.helperTimeoutMs ?? SELF_UPDATE_HELPER_TIMEOUT_MS);
    if (result.exitCode === null) {
      await this.finish(
        "failed",
        "helper_failed",
        `The helper did not finish in time. ${result.output}`,
      );
      return;
    }
    if (result.exitCode !== 0) {
      await this.finish(
        "failed",
        "helper_failed",
        `docker compose up exited with ${result.exitCode}. ${result.output}`,
      );
      return;
    }
    await this.finish("started", null, "");
    deps.logger.info("The mounter was started (docker compose --profile mounts up -d mounter).");
  }

  private async note(patch: Partial<MounterEnableRecord>): Promise<void> {
    const last = this.deps.store.state.mounterEnable;
    if (!last) {
      return;
    }
    Object.assign(last, patch);
    await this.deps.store.save();
  }

  private async finish(
    status: "started" | "failed",
    reason: MounterEnableReason | null,
    detail: string,
  ): Promise<void> {
    const last = this.deps.store.state.mounterEnable;
    if (!last) {
      return;
    }
    last.status = status;
    last.reason = reason;
    last.finishedAt = this.deps.clock.now().toISOString();
    last.detail = this.deps.redactor.oneLine(detail, 1000);
    if (status === "failed") {
      this.deps.logger.warn(
        `The mounter could not be started (${reason ?? status}): ${last.detail} Start it by hand: docker compose --profile mounts up -d mounter (docs/MOUNTS.md).`,
      );
    }
    await this.deps.store.save();
  }

  private detail(error: unknown): string {
    const text =
      error instanceof Error
        ? "detail" in error && typeof error.detail === "string" && error.detail
          ? `${error.message} ${error.detail}`
          : error.message
        : String(error);
    return this.deps.redactor.oneLine(text, 1000);
  }
}
