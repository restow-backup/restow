import { useTranslation } from "react-i18next";

import { ActivityOrb } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import type { MailExport } from "@/features/exports/api";
import { statusKey, statusTone } from "@/features/exports/lib/exports";

/**
 * The status of an export, including "completed with issues" when messages
 * failed. A running export also gets the shared `ActivityOrb`, `decorative`
 * because the badge text ("Running") already names the activity.
 */
export function ExportStatusBadge({
  item,
}: {
  item: Pick<MailExport, "status" | "progress"> & { report?: { failed: number } | null };
}) {
  const { t } = useTranslation("exports");
  return (
    <span className="inline-flex items-center gap-1.5">
      {item.status === "active" ? <ActivityOrb kind="exporting" size={20} decorative /> : null}
      <Badge variant={statusTone(item)}>{t(statusKey(item))}</Badge>
    </span>
  );
}
