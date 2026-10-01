import { useTranslation } from "react-i18next";

import { ActivityOrb } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import type { RestoreJob } from "@/features/restore/api";
import { statusKey, statusTone } from "@/features/restore/lib/jobs";

/**
 * The status of a restore, including "completed with problems" when items
 * failed. A running restore also gets the shared `ActivityOrb` next to its
 * badge, `decorative` because the badge text ("Running") already names the
 * activity out loud.
 */
export function JobStatusBadge({ job }: { job: Pick<RestoreJob, "status" | "result"> }) {
  const { t } = useTranslation("restore");
  return (
    <span className="inline-flex items-center gap-1.5">
      {job.status === "active" ? <ActivityOrb kind="restoreRunning" size={20} decorative /> : null}
      <Badge variant={statusTone(job)}>{t(statusKey(job))}</Badge>
    </span>
  );
}
