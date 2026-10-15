import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";

import "../i18n";
import type { SuspicionTarget } from "../api";
import { useObjectSuspicions } from "../hooks";

/**
 * Beside an object's name (a machine, a file share, a VM or container, a mailbox or OneDrive):
 * "Suspicious" in red while its newest restore point shows signs of ransomware. Nothing
 * otherwise, and nothing for a viewer who may not read the judgements.
 */
export function ObjectSuspicionBadge({ target }: { target: SuspicionTarget }) {
  const { t } = useTranslation("suspicion");
  const { data } = useObjectSuspicions(target);
  if (!data?.open) {
    return null;
  }
  return (
    <StatusBadge
      tone="destructive"
      icon={ShieldAlert}
      title={t("object.hint")}
      data-slot="object-suspicion-badge"
    >
      {t("object.suspicious")}
    </StatusBadge>
  );
}
