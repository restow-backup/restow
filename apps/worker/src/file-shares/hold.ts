import { buildCause } from "@restow/core";
import type { FileShareRun } from "@restow/db";
import { RESTORE_MODE_HOLD_MESSAGE } from "../restore-mode.js";
import type { FileShareDeps } from "./common.js";
import { endRun } from "./finish.js";

/**
 * Hold a file share run from before the database restore (restore mode, docs/STORAGE.md): it ends
 * as cancelled with the explanation and the failure `job.restore_mode_hold`, never started (the
 * dispatcher) or watched on (the monitor). True when this call ended it.
 */
export async function holdFileShareRun(
  deps: FileShareDeps,
  run: Pick<FileShareRun, "id" | "tenantId" | "kind">,
): Promise<boolean> {
  const ended = await endRun(deps, run, {
    status: "cancelled",
    message: RESTORE_MODE_HOLD_MESSAGE,
    cause: buildCause("job.restore_mode_hold", { queue: `file-share-${run.kind}` }),
  });
  if (ended) {
    deps.runtime.logger.warn("file share run held: it is from before the database restore", {
      runId: run.id,
      tenantId: run.tenantId,
      kind: run.kind,
    });
  }
  return ended;
}
