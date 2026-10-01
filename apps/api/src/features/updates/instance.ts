import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { UpdateService } from "./service.js";
import { updateState } from "./state-instance.js";
import { updaterClientFromEnv } from "./updater-client.js";

/** The process-wide update service, on the installation pool. */
export const updateService = new UpdateService({
  db: providerDb,
  state: updateState,
  updater: updaterClientFromEnv(process.env, config.demo.enabled),
  demo: config.demo.enabled,
  log: (level, message, fields) =>
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
      JSON.stringify({ level, component: "updates", message, ...fields }),
    ),
});
