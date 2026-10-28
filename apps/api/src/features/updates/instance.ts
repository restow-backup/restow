import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { currentInstallationDefault } from "../../lib/installation-default.js";
import { resolveEntraApp } from "../sources/entra.js";
import { DatabaseService, filesystemOf } from "./database.js";
import { DiskWatch } from "./disk-watch.js";
import { RestartService } from "./restarts.js";
import { SecretWatch } from "./secret-watch.js";
import { UpdateService } from "./service.js";
import { updateState } from "./state-instance.js";
import { updaterClientFromEnv } from "./updater-client.js";

/** The process-wide updater client (also used by Installation > Default repository & network shares). */
export const updaterClient = updaterClientFromEnv(process.env, config.demo.enabled);

/** The process-wide update service, on the installation pool. */
export const updateService = new UpdateService({
  db: providerDb,
  state: updateState,
  updater: updaterClient,
  demo: config.demo.enabled,
  log: (level, message, fields) =>
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
      JSON.stringify({ level, component: "updates", message, ...fields }),
    ),
});

/** The restart notices and "Restart now" (restarts.ts), sharing the updater client and its cache. */
export const restartService = new RestartService({
  db: providerDb,
  updater: updaterClient,
  demo: config.demo.enabled,
});

/** Installation > Database (database.ts), sharing the updater client and its cache. */
export const databaseService = new DatabaseService({
  db: providerDb,
  updater: updaterClient,
  demo: config.demo.enabled,
  // The disk under the installation's local default repository; an S3 default has none.
  repositoryDisk: async () => {
    const storage = await currentInstallationDefault();
    return storage?.primary.kind === "local" ? await filesystemOf(storage.primary.basePath) : null;
  },
});

/** The low disk space warning (disk-watch.ts), started next to the HTTP server (server.ts). */
export const diskWatch = new DiskWatch({
  db: providerDb,
  service: databaseService,
  // `/` of the api container: the disk under Docker's data directory (storage/system-disk.ts).
  systemDisk: () => filesystemOf("/"),
  log: (level, message, fields) =>
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
      JSON.stringify({ level, component: "disks", message, ...fields }),
    ),
});

/**
 * The expiry reminder of the central Microsoft 365 app registration (secret-watch.ts), started
 * next to the HTTP server (server.ts).
 */
export const secretWatch = new SecretWatch({
  db: providerDb,
  resolve: resolveEntraApp,
  log: (level, message, fields) =>
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
      JSON.stringify({ level, component: "app-secret", message, ...fields }),
    ),
});
