import { useTranslation } from "react-i18next";

import { StatusBadge, type StatusTone } from "@/components/kit";
import { ActivityOrb } from "@/components/kit";
import { statusKey, statusTone } from "../presenters";
import type { ImportSummary } from "../types";

const TONE: Record<ReturnType<typeof statusTone>, StatusTone> = {
  muted: "muted",
  default: "info",
  neutral: "neutral",
  warning: "warning",
  destructive: "destructive",
  secondary: "muted",
};

/**
 * The status of an import, including "completed with problems" when items
 * failed. A running import also gets the shared activity orb (decorative: the
 * badge text already names the state).
 */
export function ImportStatusBadge({ job }: { job: Pick<ImportSummary, "status" | "failed"> }) {
  const { t } = useTranslation("imports");
  return (
    <span className="inline-flex items-center gap-1.5">
      {job.status === "active" ? <ActivityOrb kind="backupRunning" size={20} decorative /> : null}
      <StatusBadge tone={TONE[statusTone(job)]} icon={job.status !== "active"}>
        {t(statusKey(job))}
      </StatusBadge>
    </span>
  );
}
