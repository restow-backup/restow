import { endpoints, type RunSizeHistoryScope, type RunSizeTx } from "@restow/db";
import { eq } from "drizzle-orm";
import { config as appConfig } from "../../config.js";
import { wholeMachineSent } from "../endpoints/dto.js";

/**
 * Which earlier runs a machine's backup is compared with (#99, docs/BAREMETAL.md 5): its whole
 * machine runs while the agent backs the machine up as a whole (the switch of its job, sent only
 * while RESTOW_BAREMETAL_PREVIEW is on and to Linux machines), else its path runs. A whole machine
 * backup is a normal backup run; only its history is its own, so the first one after the switch
 * counts as a first run and not as ten times the machine's usual path runs.
 */
export async function endpointHistoryScope(
  tx: Pick<RunSizeTx, "select">,
  endpointId: string,
  baremetalPreview: boolean = appConfig.baremetalPreview,
): Promise<RunSizeHistoryScope> {
  const [row] = await tx
    .select({ os: endpoints.os, config: endpoints.config })
    .from(endpoints)
    .where(eq(endpoints.id, endpointId))
    .limit(1);
  return {
    wholeMachine: wholeMachineSent(row?.config.wholeMachine, row?.os, baremetalPreview),
  };
}
