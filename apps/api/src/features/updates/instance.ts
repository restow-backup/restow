import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { RestartService } from "./restarts.js";
import { UpdateService } from "./service.js";
import { updateState } from "./state-instance.js";
import { updaterClientFromEnv } from "./updater-client.js";

/** The process-wide client of the opt-in updater (also asked by the Mounts section). */
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
