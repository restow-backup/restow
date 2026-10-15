import { PauseCircle, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";

import "../i18n";
import type { SuspicionTarget } from "../api";
import { useObjectSuspicions } from "../hooks";

/**
 * Beside an object's name (a machine, a file share, a VM or container, a mailbox or OneDrive):
 * "Suspicious" in red while its newest restore point shows signs of ransomware, and "Retention
 * paused" while a suspicious restore point nobody resolved holds its retention (also after a
 * clean restore point followed). Nothing otherwise, and nothing for a viewer who may not read the
 * judgements.
 */
export function ObjectSuspicionBadge({ target }: { target: SuspicionTarget }) {
  const { t } = useTranslation("suspicion");
  const { data } = useObjectSuspicions(target);
  if (!data?.open && !data?.hold) {
    return null;
  }
  return (
    <>
      {data.open ? (
        <StatusBadge
          tone="destructive"
          icon={ShieldAlert}
          title={t("object.hint")}
          data-slot="object-suspicion-badge"
        >
          {t("object.suspicious")}
        </StatusBadge>
      ) : null}
      {data.hold ? (
        <StatusBadge
          tone="warning"
          icon={PauseCircle}
          title={t("hold.badgeHint")}
          data-slot="retention-hold-badge"
        >
          {t("hold.badge")}
        </StatusBadge>
      ) : null}
    </>
  );
}
