import type { RestoreModeGuard } from "@restow/core";
import { providerDb } from "../../db.js";
import { createApiRestoreModeGuard } from "./guard.js";

let guard: RestoreModeGuard | null = null;

/** The process-wide deletion guard of the api, on the installation pool (server.ts installs it). */
export function apiRestoreModeGuard(): RestoreModeGuard {
  guard ??= createApiRestoreModeGuard(providerDb);
  return guard;
}
