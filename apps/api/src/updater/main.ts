import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { HttpApiClient } from "./api-client.js";
import { loadOrCreateSecret } from "./auth.js";
import { ConfigError, loadConfig, resolveProjectLocation } from "./config.js";
import { DumpStore } from "./dumps.js";
import { EngineClient } from "./engine-api.js";
import { UpdateEngine } from "./engine.js";
import { EnvFile, postgresSettings } from "./env-file.js";
import { consoleLogger } from "./logger.js";
import { MounterEnabler } from "./mounter-enable.js";
import { HttpMounterStatus } from "./mounter-status.js";
import { CliDockerOps } from "./ops-cli.js";
import { type CommandRunner, type SelfContainer, systemClock } from "./ops.js";
import { Preflight } from "./preflight.js";
import { Redactor } from "./redact.js";
import { HelperRunner } from "./runner-helper.js";
import { LocalRunner } from "./runner-local.js";
import { EngineSelfRecreateLauncher, MOUNTER_RECREATE_TARGET } from "./self-recreate.js";
import { type OwnImage, SelfUpdater, pinOwnImage } from "./self-update.js";
import { buildServer } from "./server.js";
import { formatAllowEntry } from "./source-policy.js";
import { ArchiveSourceProvider } from "./source.js";
import { StatusStore } from "./store.js";

/**
 * Entry point of the `updater` role (`ROLE=updater`, compose profile `updater`).
 *
 * The process is deliberately small: it holds the Docker socket, so it holds no
 * application credential (no database URL, no master key) and imports nothing from
 * the application (boundary.test.ts). It serves a tiny HTTP API to the api over the
 * internal network, keeps its state in a volume and applies updates to the compose
 * project it runs next to (engine.ts).
 */

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_WORKDIR_LABEL = "com.docker.compose.project.working_dir";

const redactor = new Redactor();
const logger = consoleLogger(redactor);

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`restow updater: ${error.message}`);
      process.exit(64);
    }
    throw error;
  }

  const store = await StatusStore.open(config.stateDir, logger, () => new Date());
  const secret = await loadOrCreateSecret(config.sharedDir);
  redactor.add(secret);

  // The container this process runs in: its compose labels name the project and its
  // mounts locate the project directory and the state volume for helper containers.
  const hostname = process.env.HOSTNAME ?? os.hostname();
  const engineClient = new EngineClient({ socketPath: config.dockerSocket, redactor });
  const inspectOwn = async () => {
    try {
      return await engineClient.inspectContainer(hostname);
    } catch {
      return null;
    }
  };
  const selfInspect = async (): Promise<SelfContainer | null> => {
    const info = await inspectOwn();
    if (!info) {
      return null;
    }
    const labels = info.Config?.Labels ?? {};
    return {
      id: info.Id,
      projectName: labels[COMPOSE_PROJECT_LABEL] ?? null,
      workingDir: labels[COMPOSE_WORKDIR_LABEL] ?? null,
    };
  };
  const ownContainer = await inspectOwn();
  const ownLabels = ownContainer?.Config?.Labels ?? {};
  const projectName = config.projectName ?? ownLabels[COMPOSE_PROJECT_LABEL] ?? "restow";

  // RESTOW_PROJECT_DIR is optional: without it the compose file mounts the project at
  // /project and the bind's source names the host path (config.ts, resolveProjectLocation).
  const location = resolveProjectLocation(
    config.projectDir,
    ownContainer ? { mounts: ownContainer.Mounts ?? [] } : null,
  );
  if ("problem" in location) {
    console.error(`restow updater: ${location.problem}`);
    process.exit(64);
  }
  const { hostDir, localDir } = location;

  // The `docker` binary in this image can run Compose only where the project has the
  // same path inside and outside the container.
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
    });
    await helper.removeStaleHelpers();
    // Pull the CLI image in the background; the capabilities report "not ready" until it is there.
    void helper.prepare().catch(() => undefined);
    runner = helper;
  }

  const envFile = new EnvFile(path.join(localDir, ".env"));

  // First start without RESTOW_UPDATER_IMAGE: pin the image this container runs, by
  // digest, before anything is checked (self-update.ts). It changes nothing that runs.
  const ownImage = async (): Promise<OwnImage | null> => {
    const configured = ownContainer?.Config?.Image;
    if (!configured) {
      return null;
    }
    const digests = await engineClient.imageRepoDigests(ownContainer?.Image ?? configured);
    return { configured, repoDigests: digests ?? [] };
  };
  await pinOwnImage({ envFile, ownImage, logger });

  const dumps = new DumpStore(path.join(config.stateDir, "dumps"));
  const ops = new CliDockerOps({
    runner,
    redactor,
    projectDir: localDir,
    projectName,
    composeFile: config.composeFile,
    dumpsDir: dumps.directory,
    postgres: async () => postgresSettings(await envFile.read()),
    selfInspect,
  });
  const api = new HttpApiClient({ apiUrl: config.apiUrl, secret, redactor });
  const source = new ArchiveSourceProvider({
    stateDir: config.stateDir,
    redactor,
    allowlist: config.sourceAllowlist,
  });
  const preflight = new Preflight({
    ops,
    envFile,
    dumps,
    clock: systemClock,
    redactor,
    projectDir: hostDir,
    stateDir: config.stateDir,
    minFreeMb: config.minFreeMb,
    imageRepository: config.imageRepository,
    webImageRepository: config.webImageRepository,
    sourceAllowlist: config.sourceAllowlist.map(formatAllowEntry),
    verifySignatures: config.verifySignatures,
  });
  const launcher = new EngineSelfRecreateLauncher({
    engine: engineClient,
    redactor,
    logger,
    cliImage: config.cliImage,
    hostProjectDir: hostDir,
    dockerSocket: config.dockerSocket,
    projectName,
    composeFile: config.composeFile,
  });
  await launcher.removeFinished();
  // The mounter follows the updater to a verified release image (docs/MOUNTS.md).
  const mounterLauncher = new EngineSelfRecreateLauncher({
    engine: engineClient,
    redactor,
    logger,
    cliImage: config.cliImage,
    hostProjectDir: hostDir,
    dockerSocket: config.dockerSocket,
    projectName,
    composeFile: config.composeFile,
    target: MOUNTER_RECREATE_TARGET,
  });
  await mounterLauncher.removeFinished();
  const selfUpdater = new SelfUpdater({
    enabled: config.selfUpdate,
    verifySignatures: config.verifySignatures,
    updaterVersion: config.version,
    imageRepository: config.imageRepository,
    envFile,
    ops,
    launcher,
    store,
    clock: systemClock,
    logger,
    redactor,
    mounter: {
      ops,
      launcher: mounterLauncher,
      status: new HttpMounterStatus({ url: config.mounterUrl }),
    },
  });
  await selfUpdater.reconcile();

  const engine = new UpdateEngine({
    config: {
      projectDir: hostDir,
      imageVariant: config.imageVariant,
      imageRepository: config.imageRepository,
      webImageRepository: config.webImageRepository,
      healthTimeoutSeconds: config.healthTimeoutSeconds,
      verifySignatures: config.verifySignatures,
      cosignImage: config.cosignImage,
    },
    store,
    ops,
    api,
    source,
    clock: systemClock,
    redactor,
    logger,
    envFile,
    dumps,
    preflight,
    selfUpdater,
  });
  await engine.init();

  // "Enable network shares" in the web interface (docs/FILESHARES.md 3.9): the same helper
  // that moves the mounter after an update starts it.
  const mounterEnabler = new MounterEnabler({
    envFile,
    ops,
    launcher: mounterLauncher,
    store,
    phase: () => engine.view().phase,
    clock: systemClock,
    logger,
    redactor,
  });
  await mounterEnabler.reconcile();

  const app = buildServer({
    engine,
    preflight,
    secret,
    clock: systemClock,
    updaterVersion: config.version,
    logger,
    redactor,
    selfUpdate: () => selfUpdater.view(),
    mounterEnable: mounterEnabler,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    logger.info(
      `Updater ${config.version ?? "(unversioned)"} listening on port ${info.port}; project ${projectName} in ${hostDir}${localDir === hostDir ? "" : ` (mounted at ${localDir})`}; runner ${runner.kind}.`,
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
    engine
      .shutdown()
      .catch((error: Error) => logger.error(`Shutdown failed: ${error.message}`))
      .finally(() => process.exit(0));
    // Docker's stop grace period is short; do not hang.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on("uncaughtException", (error) => {
  logger.error(`Uncaught exception: ${error.message}`);
  // The state on disk is consistent (atomic writes); the restart policy brings the updater back.
  process.exit(1);
});

main().catch((error: Error) => {
  logger.error(`The updater could not start: ${error.message}`);
  process.exit(1);
});
