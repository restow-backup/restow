import { db, providerDb } from "../../db.js";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import { RunSizeGuards } from "./guards.js";

/** The process-wide run size guards of the restic routes (guards.ts). */
export const runSizeGuards = new RunSizeGuards({
  db,
  installationTimeZone: async () => (await loadInstallationTimeZone(providerDb)).timeZone,
  log: (level, message, fields) =>
    (level === "warn" ? console.warn : console.log)(
      JSON.stringify({ level, component: "run-size", message, ...fields }),
    ),
});
