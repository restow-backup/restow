import { PauseCircle } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes, formatDateTime } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import "../i18n";
import type { SuspicionTarget } from "../api";
import {
  useMarkHoldFalseAlarm,
  useObjectSuspicions,
  useReleaseRetentionHold,
  useSuspicionScope,
} from "../hooks";
import { FALSE_ALARM_NOTE_MAX_LENGTH } from "./suspicion-dialog";

type Action = "release" | "falseAlarm";

/**
 * On an object (a machine, a file share, a VM or container, a mailbox or OneDrive) whose
 * retention is held on suspicion (docs/RANSOMWARE.md, "Retention hold"): "Retention paused:
 * suspicious restore point since ...", that backups go on and storage grows, and the two ways to
 * end it. "Release hold" is for administrators and asks for a recent sign-in (the identity dialog,
 * then the release runs again); "Mark as false alarm" calls every held finding one. Nothing while
 * retention is not held, or for a viewer who may not read the judgements.
 */
export function RetentionHoldNotice({
  target,
  objectName,
}: {
  target: SuspicionTarget | null;
  objectName: string;
}) {
  const { t, i18n } = useTranslation("suspicion");
  const { data } = useObjectSuspicions(target);
  const { canMarkFalseAlarm, canReleaseHold } = useSuspicionScope();
  const release = useReleaseRetentionHold();
  const falseAlarm = useMarkHoldFalseAlarm();
  const identity = useConfirmIdentity();
  const [action, setAction] = React.useState<Action | null>(null);
  const [note, setNote] = React.useState("");
  const noteId = React.useId();

  const hold = data?.hold;
  if (!target || !hold) {
    return identity.dialog;
  }
  const language = i18n.language;
  const since = formatDateTime(hold.since, language) ?? hold.since;
  const text = note.trim().length > 0 ? note.trim() : null;

  const close = () => {
    setAction(null);
    setNote("");
  };

  const runRelease = async (): Promise<void> => {
    try {
      await release.mutateAsync({ target, note: text });
      toast.success(t("hold.released"));
      close();
    } catch (error) {
      if (isRecentSignInRequired(error)) {
        // An older session confirms it is them first; the release then runs again.
        setAction(null);
        identity.ask(() => void runRelease());
        return;
      }
      toast.error(t("hold.releaseFailed"));
    }
  };

  const runFalseAlarm = () =>
    falseAlarm.mutate(
      { target, note: text },
      {
        onSuccess: () => {
          toast.success(t("hold.falseAlarmDone"));
          close();
        },
        onError: () => toast.error(t("hold.falseAlarmFailed")),
      },
    );

  return (
    <>
      <Alert variant="destructive" data-slot="retention-hold">
        <PauseCircle aria-hidden="true" />
        <AlertTitle>{t("hold.banner", { time: since })}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{t("hold.description", { object: objectName })}</p>
          <p>
            {t("hold.points", { count: hold.restorePoints })}{" "}
            {hold.storageBytes !== null
              ? t("hold.storage", { size: formatBytes(hold.storageBytes, language) })
              : null}{" "}
            {t("hold.reminder", { days: hold.reminderDays })}
          </p>
          {canReleaseHold || canMarkFalseAlarm ? (
            <div className="flex flex-wrap gap-2">
              {canMarkFalseAlarm ? (
                <Button size="sm" variant="outline" onClick={() => setAction("falseAlarm")}>
                  {t("hold.falseAlarm")}
                </Button>
              ) : null}
              {canReleaseHold ? (
                <Button size="sm" variant="outline" onClick={() => setAction("release")}>
                  {t("hold.release")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </AlertDescription>
      </Alert>
      <Dialog open={action !== null} onOpenChange={(open) => (open ? null : close())}>
        <DialogContent className="sm:max-w-lg" data-slot="retention-hold-dialog">
          <DialogHeader>
            <DialogTitle>
              {action === "release" ? t("hold.releaseTitle") : t("hold.falseAlarmTitle")}
            </DialogTitle>
            <DialogDescription>
              {action === "release"
                ? t("hold.releaseDescription", { object: objectName })
                : t("hold.falseAlarmDescription", { object: objectName })}
            </DialogDescription>
          </DialogHeader>
          <div className="min-w-0 space-y-2">
            <Label htmlFor={noteId}>{t("hold.note")}</Label>
            <Textarea
              id={noteId}
              value={note}
              maxLength={FALSE_ALARM_NOTE_MAX_LENGTH}
              placeholder={t("hold.notePlaceholder")}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t("hold.cancel")}
            </Button>
            {action === "release" ? (
              <Button
                variant="destructive"
                onClick={() => void runRelease()}
                loading={release.isPending}
              >
                {t("hold.releaseConfirm")}
              </Button>
            ) : (
              <Button onClick={runFalseAlarm} loading={falseAlarm.isPending}>
                {t("hold.falseAlarmConfirm")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {identity.dialog}
    </>
  );
}
