/**
 * The online archive (In-Place Archive) of a mailbox is not backed up: Graph v1.0
 * reaches only the primary mailbox, and Restow does not read the archive through
 * beta APIs. Mail that a retention policy (MRM "move to archive after 2 years") or
 * the user moves there leaves the primary folders, the folder delta reports it as
 * removed, and it leaves the new restore points without anything going red.
 *
 * So every run asks once whether the mailbox has an archive (cached for a day in
 * the state) and, when it has one, records a warning with the cause
 * `graph.online_archive_not_covered`: the run completes with warnings, never
 * plain green. A probe Graph refuses (no User.Read.All, beta unavailable) is
 * logged as unknown and claims nothing (docs/MICROSOFT.md "Online-Archiv").
 */
import { buildCause } from "../../failures/classify.js";
import { probeOnlineArchive } from "../../graph/resources/users.js";
import type { BackupRun } from "./run.js";

/** The item ref of the warning (not an object path: the archive is not in the snapshot). */
export const ONLINE_ARCHIVE_ITEM_REF = "online-archive";

/** A known answer is asked again after this long. */
export const ONLINE_ARCHIVE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function checkOnlineArchive(run: BackupRun): Promise<void> {
  const now = run.ctx.now();
  const cached = run.state.onlineArchive;
  let status: "present" | "none" | "unknown";
  if (cached && now.getTime() - Date.parse(cached.checkedAt) < ONLINE_ARCHIVE_CHECK_INTERVAL_MS) {
    status = cached.status;
  } else {
    const probe = await probeOnlineArchive(run.client, run.userId);
    status = probe.status;
    if (probe.status === "unknown") {
      // No claim either way; the next run asks again.
      delete run.state.onlineArchive;
      run.logger.info("online archive of the mailbox unknown, Graph did not tell", {
        reason: probe.reason,
      });
    } else {
      run.state.onlineArchive = { status: probe.status, checkedAt: now.toISOString() };
    }
  }
  if (status !== "present") {
    return;
  }
  const reason =
    "the mailbox has an online archive (In-Place Archive), which is not backed up; mail moved there leaves new restore points";
  run.warn(
    ONLINE_ARCHIVE_ITEM_REF,
    reason,
    buildCause("graph.online_archive_not_covered", {}, { message: reason }),
  );
}
