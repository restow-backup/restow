/**
 * The recovery ISO of this installation's release (docs/BAREMETAL.md 26.13): one pass of
 * `fetchRecoveryIso` from @restow/core. The scheduler queues it every six hours for the whole
 * installation (never per person or tenant); the download lands in the store in the data volume
 * the api serves it from. A pass that failed for a reason worth another try soon (the network, a
 * cut-off transfer) throws, so the queue retries it; the next pass continues a cut-off download.
 */
import {
  fetchRecoveryIso,
  type RecoveryIsoFetchOptions,
  type RecoveryIsoFetchResult,
  recoveryIsoDropDirs,
  recoveryIsoFetchEnabled,
  recoveryIsoStoreDir,
} from "@restow/core";
import type { EndpointJobDeps } from "./common.js";

/** The pass failed for a reason worth a retry soon; the state file says which. */
export class RecoveryIsoRetryError extends Error {
  constructor(readonly result: RecoveryIsoFetchResult) {
    super(`recovery ISO: ${result.state.problem ?? "failed"}`);
    this.name = "RecoveryIsoRetryError";
  }
}

/** Where the pass looks and writes, from the worker's environment. */
export function recoveryIsoOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): RecoveryIsoFetchOptions {
  const storeDir = recoveryIsoStoreDir(env);
  return {
    storeDir,
    dropDirs: recoveryIsoDropDirs(storeDir, env.RESTOW_RECOVERY_ISO_DIR?.trim() || null),
    enabled: recoveryIsoFetchEnabled(env),
  };
}

export async function endpointRecoveryIso(
  deps: Pick<EndpointJobDeps, "runtime">,
  options: RecoveryIsoFetchOptions = recoveryIsoOptionsFromEnv(),
): Promise<RecoveryIsoFetchResult> {
  const { logger } = deps.runtime;
  const result = await fetchRecoveryIso(options);
  const { state } = result;
  const fields = {
    status: state.status,
    version: state.version,
    fileName: state.fileName,
    problem: state.problem,
    detail: state.detail,
  };
  if (result.busy) {
    logger.info("recovery ISO pass skipped, another pass holds the store", fields);
  } else if (state.status === "failed") {
    logger.warn("recovery ISO pass failed", fields);
  } else if (state.status === "verified" && state.problem) {
    logger.warn("recovery ISO verified, a rebuild was skipped", fields);
  } else if (state.status === "verified" && result.lookupProblem) {
    // A verified copy is here; the release page could not be asked for rebuilds (on an
    // installation without internet access, always). The next pass asks again.
    logger.info("recovery ISO verified, rebuilds could not be checked", {
      ...fields,
      lookupProblem: result.lookupProblem.problem,
      lookupDetail: result.lookupProblem.detail,
    });
  } else {
    logger.info("recovery ISO pass", fields);
  }
  if (result.transient) {
    throw new RecoveryIsoRetryError(result);
  }
  return result;
}
