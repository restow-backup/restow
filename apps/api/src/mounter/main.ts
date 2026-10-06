import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { loadOrCreateSecret } from "../updater/auth.js";
import { resolveProjectLocation } from "../updater/config.js";
import { EngineClient } from "../updater/engine-api.js";
import { EnvFile, MOUNTER_IMAGE_KEY } from "../updater/env-file.js";
import { consoleLogger } from "../updater/logger.js";
import { type CommandRunner, systemClock } from "../updater/ops.js";
import { Redactor } from "../updater/redact.js";
import { HelperRunner } from "../updater/runner-helper.js";
import { LocalRunner } from "../updater/runner-local.js";
import { type OwnImage, pinOwnImage } from "../updater/self-update.js";
import { MounterConfigError, loadMounterConfig } from "./config.js";
import { MountEngine } from "./engine.js";
import { DockerMountOps } from "./ops.js";
import { buildMounterServer } from "./server.js";
import { FileOperationStore } from "./store.js";

/**
 * Entry point of the `mounter` role (`ROLE=mounter`, compose profile `mounts`,
 * docs/MOUNTS.md).
 *
 * The mounter adds NFS shares to the compose project it runs next to, as Docker
 * volumes mounted into the api and the worker. It holds the Docker socket, so like the
 * updater it holds no application credential and imports nothing from the application
 * (boundary.test.ts): only its own files and the updater's Docker building blocks.
 * It does not need the updater: either runs without the other.
 */

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/** The label of the mounter's own helper containers (never the updater's). */
const MOUNTER_HELPER_LABEL = "com.restow.mounter.helper";

const redactor = new Redactor();
const logger = consoleLogger(redactor, () => new Date(), "mounter");

async function main(): Promise<void> {
  let config: ReturnType<typeof loadMounterConfig>;
  try {
    config = loadMounterConfig(process.env);
  } catch (error) {
    if (error instanceof MounterConfigError) {
      console.error(`restow mounter: ${error.message}`);
      process.exit(64);
    }
    throw error;
  }

  const store = await FileOperationStore.open(config.stateDir, logger);
  const secret = await loadOrCreateSecret(config.sharedDir);
  redactor.add(secret);

  const hostname = process.env.HOSTNAME ?? os.hostname();
  const engineClient = new EngineClient({ socketPath: config.dockerSocket, redactor });
  const ownContainer = await engineClient.inspectContainer(hostname).catch(() => null);
  const ownLabels = ownContainer?.Config?.Labels ?? {};
  const projectName = config.projectName ?? ownLabels[COMPOSE_PROJECT_LABEL] ?? "restow";

  const location = resolveProjectLocation(
    config.projectDir,
    ownContainer ? { mounts: ownContainer.Mounts ?? [] } : null,
    "RESTOW_MOUNTER_PROJECT_DIR",
  );
  if ("problem" in location) {
    console.error(`restow mounter: ${location.problem}`);
    process.exit(64);
  }
  const { hostDir, localDir } = location;

  const local = new LocalRunner({ redactor, cwd: hostDir });
  let runner: CommandRunner;
  if (local.available && hostDir === localDir) {
    runner = local;
  } else {
    const helper = new HelperRunner({
      engine: engineClient,
      redactor,
      logger,
      cliImage: config.cliImage,
      projectDir: hostDir,
      stateDir: config.stateDir,
      dockerSocket: config.dockerSocket,
      selfId: hostname,
      helperLabel: MOUNTER_HELPER_LABEL,
      namePrefix: "restow-mounter-helper",
    });
    await helper.removeStaleHelpers();
    void helper.prepare().catch(() => undefined);
    runner = helper;
  }

  // First start without RESTOW_MOUNTER_IMAGE: pin the image this container runs, by
  // digest, so a later rewrite of RESTOW_IMAGE does not reach the mounter's image.
  const envFile = new EnvFile(path.join(localDir, ".env"));
  const ownImage = async (): Promise<OwnImage | null> => {
    const configured = ownContainer?.Config?.Image;
    if (!configured) {
      return null;
    }
    const digests = await engineClient.imageRepoDigests(ownContainer?.Image ?? configured);
    return { configured, repoDigests: digests ?? [] };
  };
  await pinOwnImage({ envFile, ownImage, logger, key: MOUNTER_IMAGE_KEY, role: "mounter" });

  const ops = new DockerMountOps({
    runner,
    engine: engineClient,
    redactor,
    logger,
    projectDir: localDir,
    projectName,
    probeImage: config.cliImage,
  });
  await ops.removeStaleProbes();

  const engine = new MountEngine({
    ops,
    store,
    clock: systemClock,
    logger,
    redactor,
    healthTimeoutMs: config.healthTimeoutSeconds * 1000,
    probeTimeoutMs: config.probeTimeoutSeconds * 1000,
  });
  await engine.init();

  const app = buildMounterServer({
    engine,
    secret,
    clock: systemClock,
    version: config.version,
    logger,
    redactor,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    logger.info(
      `Mounter ${config.version ?? "(unversioned)"} listening on port ${info.port}; project ${projectName} in ${hostDir}${localDir === hostDir ? "" : ` (mounted at ${localDir})`}; runner ${runner.kind}.`,
    );
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info(`Received ${signal}; shutting down.`);
    server.close();
    if (engine.isBusy) {
      logger.warn("An operation is running; it is recorded as interrupted on the next start.");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on("uncaughtException", (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  process.exit(1);
});

main().catch((error: Error) => {
  logger.error(`The mounter could not start: ${error.message}`);
  process.exit(1);
});
