import { type EnvFile, UPDATER_IMAGE_KEY, envValueOf } from "./env-file.js";
import type { Logger } from "./logger.js";
import type { Clock, DockerOps } from "./ops.js";
import type {
  Run,
  SelfUpdateReason,
  SelfUpdateRecord,
  SelfUpdateStatus,
  SelfUpdateView,
} from "./protocol.js";
import type { Redactor } from "./redact.js";
import { isNewerVersion, sameVersion } from "./semver.js";
import { DIGEST_PINNED_IMAGE } from "./signature.js";
import type { StatusStore } from "./store.js";

/**
 * The updater's own image (docs/UPDATING.md, "The updater updates itself").
 *
 * The updater holds the Docker socket, so the image it runs is root on the host. Two
 * rules keep that image out of reach of anything but a human or the release workflow's
 * signature:
 *
 *   1. Its image is never taken from RESTOW_IMAGE, the line an update rewrites. The
 *      compose files fall back to RESTOW_IMAGE only while RESTOW_UPDATER_IMAGE is
 *      empty, and on its first start the updater fills that line with the image it
 *      already runs, by digest ({@link pinOwnImage}): pinning freezes what the operator
 *      started, it never starts anything new. Until the line is written, the preflight
 *      blocks every update ("updater image not pinned").
 *   2. It moves to a new image only after an update in `image` mode succeeded and that
 *      release's application image passed the keyless signature check of the release
 *      workflow for exactly that tag (signature.ts). Then RESTOW_UPDATER_IMAGE becomes
 *      that image by the verified digest, never by a tag, and a short-lived helper
 *      container runs `docker compose up -d updater` (the updater cannot recreate its
 *      own container from inside). `source` mode, a switched-off signature check or
 *      RESTOW_UPDATER_SELF_UPDATE=false leave the updater where it is.
 *
 * A self-update that fails never turns the application update into a failure: the
 * record says why, and the Updates tab shows the command that finishes it by hand.
 */

/** How long the old updater waits for the helper before it records a failure. */
export const SELF_UPDATE_HELPER_TIMEOUT_MS = 5 * 60_000;
/** How long the old updater waits to be replaced after the helper reported success. */
export const SELF_UPDATE_REPLACE_GRACE_MS = 30_000;

/** The helper container that recreates the updater (self-recreate.ts). */
export interface SelfRecreateLauncher {
  /** Create and start the helper. Throws when it cannot be started. */
  launch(): Promise<SelfRecreateHandle>;
}

export interface SelfRecreateHandle {
  /**
   * Wait for the helper to end: its exit code and the redacted tail of its output;
   * `exitCode` is null when it did not end within `timeoutMs`. Usually the old updater
   * is stopped by Compose before this resolves.
   */
  wait(timeoutMs: number): Promise<{ exitCode: number | null; output: string }>;
}

export type SelfUpdateDecision =
  | { action: "none" }
  | { action: "skip"; reason: SelfUpdateReason }
  | { action: "update"; image: string };

export interface SelfUpdateDecisionInput {
  /** RESTOW_UPDATER_SELF_UPDATE is not false. */
  enabled: boolean;
  /** RESTOW_UPDATER_VERIFY_SIGNATURES is not false. */
  verifySignatures: boolean;
  /** The updater's own version; null for an unversioned local build. */
  updaterVersion: string | null;
  run: Pick<
    Run,
    "mode" | "outcome" | "signatureVerified" | "digestVerified" | "targetVersion" | "switchTo"
  >;
  /** The application image digest the release published and the run verified. */
  appDigest: string | undefined;
  /** Where image mode pulled the application image from. */
  imageRepository: string;
}

/** Whether, and to what, the updater moves itself after a run. */
export function selfUpdateDecision(input: SelfUpdateDecisionInput): SelfUpdateDecision {
  const { run } = input;
  if (run.outcome !== "succeeded") {
    return { action: "none" };
  }
  // Already there (or further): nothing to do, nothing to report. A build switch keeps the
  // version but changes the image, so the updater follows it to the full build.
  if (
    !run.switchTo &&
    input.updaterVersion !== null &&
    isNewerVersion(input.updaterVersion, run.targetVersion) !== true
  ) {
    return { action: "none" };
  }
  if (!input.enabled) {
    return { action: "skip", reason: "disabled" };
  }
  if (run.mode !== "image") {
    return { action: "skip", reason: "source_mode" };
  }
  if (
    !input.verifySignatures ||
    run.signatureVerified !== true ||
    run.digestVerified !== true ||
    !input.appDigest
  ) {
    return { action: "skip", reason: "signature_unverified" };
  }
  const image = `${input.imageRepository}:${run.targetVersion}@${input.appDigest}`;
  if (!DIGEST_PINNED_IMAGE.test(image)) {
    return { action: "skip", reason: "signature_unverified" };
  }
  return { action: "update", image };
}

export interface SelfUpdaterDeps {
  enabled: boolean;
  verifySignatures: boolean;
  updaterVersion: string | null;
  imageRepository: string;
  envFile: EnvFile;
  ops: Pick<DockerOps, "configUpdaterImage">;
  /** null: no Docker Engine API to start the helper with (never in the published image). */
  launcher: SelfRecreateLauncher | null;
  store: StatusStore;
  clock: Clock;
  logger: Logger;
  redactor: Redactor;
  helperTimeoutMs?: number;
  replaceGraceMs?: number;
}

export class SelfUpdater {
  /** The process is being stopped (usually: replaced); nothing more is recorded. */
  private stopped = false;

  constructor(private readonly deps: SelfUpdaterDeps) {}

  view(): SelfUpdateView {
    const last = this.deps.store.state.selfUpdate;
    return {
      enabled: this.deps.enabled,
      verifiesSignatures: this.deps.verifySignatures,
      last: last ? structuredClone(last) : null,
    };
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * At start: a self-update the previous process began is confirmed by the version
   * this process runs, or recorded as failed when it is still the old one.
   */
  async reconcile(): Promise<void> {
    const { store, clock, updaterVersion, logger } = this.deps;
    const last = store.state.selfUpdate;
    if (!last || last.status !== "pending") {
      return;
    }
    if (updaterVersion !== null && sameVersion(updaterVersion, last.targetVersion)) {
      last.status = "succeeded";
      last.reason = null;
      last.finishedAt = clock.now().toISOString();
      logger.info(`The updater now runs ${updaterVersion} (${last.image ?? "image unknown"}).`);
    } else {
      last.status = "failed";
      last.reason = "not_replaced";
      last.finishedAt = clock.now().toISOString();
      last.detail = `The updater started again with version ${updaterVersion ?? "unknown"}, not ${last.targetVersion}.`;
      logger.warn(`The self-update to ${last.targetVersion} did not take effect: ${last.detail}`);
    }
    await store.save();
  }

  /**
   * After a run ended: move the updater to the release it installed, when that is
   * allowed (see {@link selfUpdateDecision}). Never throws.
   */
  async afterRun(
    run: Run,
    appDigest: string | undefined,
    imageRepository: string = this.deps.imageRepository,
  ): Promise<void> {
    try {
      await this.attempt(run, appDigest, imageRepository);
    } catch (error) {
      this.deps.logger.error(
        `The self-update could not be recorded: ${this.deps.redactor.oneLine((error as Error).message, 300)}`,
      );
    }
  }

  private async attempt(
    run: Run,
    appDigest: string | undefined,
    imageRepository: string,
  ): Promise<void> {
    const { deps } = this;
    const decision = selfUpdateDecision({
      enabled: deps.enabled,
      verifySignatures: deps.verifySignatures,
      updaterVersion: deps.updaterVersion,
      run,
      appDigest,
      imageRepository,
    });
    if (decision.action === "none") {
      return;
    }
    if (decision.action === "skip") {
      deps.logger.info(
        `The updater stays at ${deps.updaterVersion ?? "its local build"} (${decision.reason}); move it by hand (docs/UPDATING.md).`,
      );
      await this.record("skipped", run.targetVersion, null, decision.reason, "");
      return;
    }

    const image = decision.image;
    await this.record("pending", run.targetVersion, image, null, "");

    // The compose file must take the updater's image from RESTOW_UPDATER_IMAGE; checked
    // with the value set for this one command, before anything is written.
    let resolved: string | null;
    try {
      resolved = await deps.ops.configUpdaterImage({ [UPDATER_IMAGE_KEY]: image });
    } catch (error) {
      await this.fail("compose_unsupported", this.detail(error));
      return;
    }
    if (resolved !== image) {
      await this.fail(
        "compose_unsupported",
        `The updater service of the compose file resolves to ${resolved ?? "no image"}, not to ${UPDATER_IMAGE_KEY}. Use the docker-compose.yml of this release.`,
      );
      return;
    }

    try {
      await deps.envFile.pinUpdaterImage(image);
    } catch (error) {
      await this.fail("env_write_failed", this.detail(error));
      return;
    }
    deps.logger.info(
      `${UPDATER_IMAGE_KEY} is now ${image} (signature of the release workflow verified); recreating the updater.`,
    );

    if (!deps.launcher) {
      await this.fail("launch_failed", "No Docker Engine API to start the helper container with.");
      return;
    }
    let handle: SelfRecreateHandle;
    try {
      handle = await deps.launcher.launch();
    } catch (error) {
      await this.fail("launch_failed", this.detail(error));
      return;
    }
    const result = await handle.wait(deps.helperTimeoutMs ?? SELF_UPDATE_HELPER_TIMEOUT_MS);
    if (this.stopped) {
      return;
    }
    if (result.exitCode === null) {
      await this.fail("helper_failed", `The helper did not finish in time. ${result.output}`);
      return;
    }
    if (result.exitCode !== 0) {
      await this.fail(
        "helper_failed",
        `docker compose up exited with ${result.exitCode}. ${result.output}`,
      );
      return;
    }
    // Compose stops this container before it starts the new one: still being here a
    // while after the helper succeeded means nothing was replaced.
    await deps.clock.sleep(deps.replaceGraceMs ?? SELF_UPDATE_REPLACE_GRACE_MS);
    if (this.stopped) {
      return;
    }
    await this.fail(
      "not_replaced",
      "docker compose up finished, but this updater was not replaced (does the compose file pin the updater's image some other way?).",
    );
  }

  private async record(
    status: SelfUpdateStatus,
    targetVersion: string,
    image: string | null,
    reason: SelfUpdateReason | null,
    detail: string,
  ): Promise<void> {
    const now = this.deps.clock.now().toISOString();
    const record: SelfUpdateRecord = {
      status,
      reason,
      fromVersion: this.deps.updaterVersion,
      targetVersion,
      image,
      startedAt: now,
      finishedAt: status === "pending" ? null : now,
      detail,
    };
    this.deps.store.state.selfUpdate = record;
    await this.deps.store.save();
  }

  private async fail(reason: SelfUpdateReason, detail: string): Promise<void> {
    const last = this.deps.store.state.selfUpdate;
    if (!last || this.stopped) {
      return;
    }
    last.status = "failed";
    last.reason = reason;
    last.finishedAt = this.deps.clock.now().toISOString();
    last.detail = this.deps.redactor.oneLine(detail, 1000);
    this.deps.logger.warn(
      `The self-update to ${last.targetVersion} failed (${reason}): ${last.detail}`,
    );
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

// ---------------------------------------------------------------------------
// Pinning the image the updater runs (first start)
// ---------------------------------------------------------------------------

/** What the updater's container says about its own image. */
export interface OwnImage {
  /** The reference the container was created with (`Config.Image`), e.g. `ghcr.io/x/restow:0.2.0`. */
  configured: string;
  /** The registry digests of that image (`name@sha256:...`); empty for a local build. */
  repoDigests: readonly string[];
}

/** The repository of a reference (without tag and digest). */
function repositoryOf(reference: string): string {
  const withoutDigest = reference.split("@")[0] as string;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

/**
 * The image the container runs, pinned by digest (`name:tag@sha256:...`); null when it
 * has no registry digest of its own repository (a local build such as `restow:local`).
 */
export function pinnedReferenceOf(own: OwnImage): string | null {
  if (DIGEST_PINNED_IMAGE.test(own.configured)) {
    return own.configured;
  }
  const repository = repositoryOf(own.configured);
  const entry = own.repoDigests.find((candidate) => repositoryOf(candidate) === repository);
  const digest = entry?.slice(entry.indexOf("@") + 1);
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return null;
  }
  const pinned = `${own.configured.split("@")[0]}@${digest}`;
  return DIGEST_PINNED_IMAGE.test(pinned) ? pinned : null;
}

export type PinResult = "pinned" | "already_set" | "local_image" | "failed";

/**
 * First start: when `.env` names no RESTOW_UPDATER_IMAGE, write the image this
 * container already runs, by digest. Later rewrites of RESTOW_IMAGE then no longer
 * reach the updater's image. Never throws.
 */
export async function pinOwnImage(deps: {
  envFile: EnvFile;
  ownImage: () => Promise<OwnImage | null>;
  logger: Logger;
}): Promise<PinResult> {
  const { envFile, logger } = deps;
  try {
    const current = envValueOf(await envFile.read(), UPDATER_IMAGE_KEY);
    if (current !== null && current !== "") {
      return "already_set";
    }
    const own = await deps.ownImage();
    const pinned = own ? pinnedReferenceOf(own) : null;
    if (!pinned) {
      logger.info(
        `${UPDATER_IMAGE_KEY} is not set and this updater runs ${own?.configured ?? "an image it cannot inspect"}, which has no registry digest; it is not pinned.`,
      );
      return "local_image";
    }
    await envFile.pinUpdaterImage(pinned);
    logger.info(
      `${UPDATER_IMAGE_KEY} was empty; pinned it to the image this updater runs: ${pinned}.`,
    );
    return "pinned";
  } catch (error) {
    logger.warn(`${UPDATER_IMAGE_KEY} could not be pinned: ${(error as Error).message}`);
    return "failed";
  }
}
