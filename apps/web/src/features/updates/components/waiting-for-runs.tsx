import { Hourglass } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { formatDateTime } from "@/lib/format";

import { ACTIVITY_GROUPS, type JobPauseView } from "../api";
import { useCancelMaintenance, useStartUpdateNow } from "../hooks";
import { updatesErrorKey } from "../presenters";

/**
 * The update that waits for the runs in progress before it is announced (#46): what
 * still runs, until when it waits at the latest, and the two ways out (start now,
 * cancel). No new run starts meanwhile; the server announces the update by itself
 * once nothing runs any more.
 */
export function WaitingForRuns({ pause, canChange }: { pause: JobPauseView; canChange: boolean }) {
  const { t, i18n } = useTranslation("updates");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const startNow = useStartUpdateNow();
  const cancel = useCancelMaintenance();
  const [confirming, setConfirming] = React.useState<"start" | "cancel" | null>(null);
  const activity = pause.activity;
  const running = activity ? ACTIVITY_GROUPS.filter((group) => activity[group].running > 0) : [];

  return (
    <div className="space-y-4" data-slot="updater-waiting" data-mode={pause.mode}>
      <Alert variant="info">
        <Hourglass />
        <AlertTitle>{t("updater.waiting.title", { version: pause.version })}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            {t("updater.waiting.body", {
              time: formatDateTime(pause.deadlineAt, language) ?? "",
            })}
          </p>
          {pause.mode === "drain" ? <p>{t("updater.waiting.draining")}</p> : null}
          {running.length > 0 ? (
            <ul className="list-disc pl-5" data-slot="waiting-runs">
              {running.map((group) => (
                <li key={group} data-group={group}>
                  {t("updater.waiting.running", {
                    group: t(`install.runs.groups.${group}`),
                    count: activity?.[group].running ?? 0,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={() => setConfirming("cancel")} disabled={!canChange}>
          {t("updater.busy.cancel")}
        </Button>
        <Button onClick={() => setConfirming("start")} disabled={!canChange}>
          {t("updater.waiting.startNow")}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming === "start"}
        onOpenChange={(open) => setConfirming(open ? "start" : null)}
        title={t("updater.waiting.startNowTitle")}
        description={<p>{t("updater.waiting.startNowBody")}</p>}
        confirmLabel={t("updater.waiting.startNowConfirm")}
        cancelLabel={t("updater.waiting.keepWaiting")}
        pending={startNow.isPending}
        error={startNow.isError ? t(updatesErrorKey(startNow.error)) : undefined}
        onConfirm={() =>
          startNow.mutateAsync().then(() => {
            toast.success(t("toasts.announced"));
          })
        }
      />
      <ConfirmDialog
        open={confirming === "cancel"}
        onOpenChange={(open) => setConfirming(open ? "cancel" : null)}
        title={t("updater.busy.cancelTitle")}
        description={<p>{t("updater.waiting.cancelBody")}</p>}
        confirmLabel={t("updater.busy.cancelConfirm")}
        cancelLabel={t("updater.waiting.keepWaiting")}
        pending={cancel.isPending}
        error={cancel.isError ? t(updatesErrorKey(cancel.error)) : undefined}
        onConfirm={() =>
          cancel.mutateAsync().then(() => {
            toast.success(t("toasts.cancelled"));
          })
        }
      />
    </div>
  );
}
