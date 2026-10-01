import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { HttpApiClient } from "./api-client.js";
import { loadOrCreateSecret } from "./auth.js";
import { ConfigError, loadConfig } from "./config.js";
import { DumpStore } from "./dumps.js";
import { EngineClient } from "./engine-api.js";
import { UpdateEngine } from "./engine.js";
import { EnvFile, postgresSettings } from "./env-file.js";
import { consoleLogger } from "./logger.js";
import { CliDockerOps } from "./ops-cli.js";
import { type CommandRunner, type SelfContainer, systemClock } from "./ops.js";
import { Preflight } from "./preflight.js";
import { Redactor } from "./redact.js";
import { HelperRunner } from "./runner-helper.js";
import { LocalRunner } from "./runner-local.js";
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
  // mounts locate the state volume for helper containers.
  const hostname = process.env.HOSTNAME ?? os.hostname();
  const engineClient = new EngineClient({ socketPath: config.dockerSocket, redactor });
  const selfInspect = async (): Promise<SelfContainer | null> => {
    try {
      const info = await engineClient.inspectContainer(hostname);
      if (!info) {
        return null;
      }
      const labels = info.Config?.Labels ?? {};
      return {
        id: info.Id,
        projectName: labels[COMPOSE_PROJECT_LABEL] ?? null,
        workingDir: labels[COMPOSE_WORKDIR_LABEL] ?? null,
      };
    } catch {
      return null;
    }
  };
  const self = await selfInspect();
  const projectName = config.projectName ?? self?.projectName ?? "restow";

  const local = new LocalRunner({ redactor, cwd: config.projectDir });
  let runner: CommandRunner;
  if (local.available) {
    runner = local;
  } else {
    const helper = new HelperRunner({
      engine: engineClient,
      redactor,
      logger,
      cliImage: config.cliImage,
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      dockerSocket: config.dockerSocket,
      selfId: hostname,
    });
    await helper.removeStaleHelpers();
    // Pull the CLI image in the background; the capabilities report "not ready" until it is there.
    void helper.prepare().catch(() => undefined);
    runner = helper;
  }

  const envFile = new EnvFile(path.join(config.projectDir, ".env"));
  const dumps = new DumpStore(path.join(config.stateDir, "dumps"));
  const ops = new CliDockerOps({
    runner,
    redactor,
    projectDir: config.projectDir,
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
    projectDir: config.projectDir,
    stateDir: config.stateDir,
    minFreeMb: config.minFreeMb,
    imageRepository: config.imageRepository,
    webImageRepository: config.webImageRepository,
    sourceAllowlist: config.sourceAllowlist.map(formatAllowEntry),
  });
  const engine = new UpdateEngine({
    config: {
      projectDir: config.projectDir,
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
  });
  await engine.init();

  const app = buildServer({
    engine,
    preflight,
    secret,
    clock: systemClock,
    updaterVersion: config.version,
    logger,
    redactor,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    logger.info(
      `Updater ${config.version ?? "(unversioned)"} listening on port ${info.port}; project ${projectName} in ${config.projectDir}; runner ${runner.kind}.`,
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
