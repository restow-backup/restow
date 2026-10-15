import { ShieldAlert, ShieldOff } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";

import "../i18n";
import type { Suspicion } from "../api";
import { SuspicionDialog } from "./suspicion-dialog";

/**
 * The mark of a judged restore point: "Suspicious" in red while the finding counts, "False
 * alarm" (muted) once an administrator called it one; nothing for a restore point without
 * findings (never green: no finding is no proof). A click opens the reasons. The badge keeps its
 * events from the row it sits in, so it does not also pick the restore point.
 */
export function SuspicionBadge({
  judgement,
  objectName,
}: {
  judgement: Suspicion | undefined;
  objectName: string;
}) {
  const { t } = useTranslation("suspicion");
  const [open, setOpen] = React.useState(false);
  if (judgement?.verdict !== "suspicious") {
    return null;
  }
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: only keeps the badge's events from reaching the row's own handlers
    <span onClick={stop} onKeyDown={stop} data-slot="suspicion-badge">
      <button
        type="button"
        className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
        title={judgement.active ? t("badge.hint") : undefined}
        aria-label={`${judgement.active ? t("badge.suspicious") : t("badge.falseAlarm")}: ${t("details.open")}`}
        onClick={() => setOpen(true)}
      >
        <StatusBadge
          tone={judgement.active ? "destructive" : "muted"}
          icon={judgement.active ? ShieldAlert : ShieldOff}
        >
          {judgement.active ? t("badge.suspicious") : t("badge.falseAlarm")}
        </StatusBadge>
      </button>
      <SuspicionDialog
        judgement={judgement}
        objectName={objectName}
        open={open}
        onOpenChange={setOpen}
      />
    </span>
  );
}
