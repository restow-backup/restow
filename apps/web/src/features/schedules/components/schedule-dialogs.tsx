import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";

import type { ScheduleItem } from "../api.js";
import { describeCadence, describeScope } from "../presenters.js";

interface ScheduleConfirmProps {
  /** The schedule asked about; the dialog is open while it is set. */
  schedule: ScheduleItem | null;
  onCancel: () => void;
  /** Runs the change; a rejected promise keeps the dialog open with the cause. */
  onConfirm: (schedule: ScheduleItem) => Promise<unknown>;
}

/** "Backup · Every 8 hours · All protected objects": which schedule the question is about. */
function Summary({ schedule }: { schedule: ScheduleItem }) {
  const { t, i18n } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <p className="font-medium text-foreground">
      {t("confirm.summary", {
        kind: t(`kinds.${schedule.kind}`),
        cadence: describeCadence(schedule, t, language),
        scope: describeScope(schedule, t),
      })}
    </p>
  );
}

/** Deleting a schedule is final: asked in an alert dialog. */
export function DeleteScheduleDialog({ schedule, onCancel, onConfirm }: ScheduleConfirmProps) {
  const { t } = useTranslation("schedules");
  return (
    <ConfirmDialog
      open={schedule !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t("confirm.delete.title")}
      description={
        schedule ? (
          <>
            <Summary schedule={schedule} />
            <p>{t("confirm.delete.description")}</p>
          </>
        ) : null
      }
      confirmLabel={t("confirm.delete.confirm")}
      destructive
      onConfirm={() => (schedule ? onConfirm(schedule) : undefined)}
    />
  );
}

/** Switching off backups or verification leaves data unprotected or unproven: asked first. */
export function DisableScheduleDialog({ schedule, onCancel, onConfirm }: ScheduleConfirmProps) {
  const { t } = useTranslation("schedules");
  const topic = schedule?.kind === "verify" ? "verify" : "backup";
  return (
    <ConfirmDialog
      open={schedule !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t(`confirm.disable.${topic}.title`)}
      description={
        schedule ? (
          <>
            <Summary schedule={schedule} />
            <p>{t(`confirm.disable.${topic}.description`)}</p>
          </>
        ) : null
      }
      confirmLabel={t("confirm.disable.confirm")}
      destructive
      onConfirm={() => (schedule ? onConfirm(schedule) : undefined)}
    />
  );
}
