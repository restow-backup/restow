import * as React from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
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
import { formatDateTime } from "@/lib/format";

import "../i18n";
import { SIGNALS, type SignalState, type Suspicion, type SuspicionBreakdown } from "../api";
import { useMarkFalseAlarm, useRevokeFalseAlarm, useSuspicionScope } from "../hooks";
import { findingMessage } from "../presenters";

/** The longest note the server keeps. */
export const FALSE_ALARM_NOTE_MAX_LENGTH = 1000;

const SIGNAL_TONE: Readonly<Record<SignalState, "destructive" | "neutral" | "muted">> = {
  fired: "destructive",
  clear: "neutral",
  learning: "muted",
  unavailable: "muted",
  off: "muted",
};

/** The findings of a restore point, one line each with its numbers. */
export function FindingList({ judgement }: { judgement: Suspicion }) {
  const { t, i18n } = useTranslation("suspicion");
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm" data-slot="suspicion-findings">
      {judgement.findings.map((finding) => {
        const { key, values } = findingMessage(finding, i18n.language);
        return <li key={`${finding.code}-${finding.value}`}>{t(key, values)}</li>;
      })}
    </ul>
  );
}

/** What the run changed (0.5.4): new, changed, caught up, removed, renamed, and the samples. */
export function BreakdownList({ breakdown }: { breakdown: SuspicionBreakdown }) {
  const { t } = useTranslation("suspicion");
  const lines: string[] = [
    t("breakdown.added", { count: breakdown.added }),
    t("breakdown.modified", { count: breakdown.modified }),
  ];
  if (breakdown.caughtUp > 0) lines.push(t("breakdown.caughtUp", { count: breakdown.caughtUp }));
  if (breakdown.removed > 0) lines.push(t("breakdown.removed", { count: breakdown.removed }));
  if (breakdown.renamed > 0) lines.push(t("breakdown.renamed", { count: breakdown.renamed }));
  lines.push(
    breakdown.sampled > 0
      ? t("breakdown.sampled", { encrypted: breakdown.sampledEncrypted, count: breakdown.sampled })
      : t("breakdown.noSamples"),
  );
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm" data-slot="suspicion-breakdown">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * Why a restore point is suspicious or unusual (or was): its findings with their numbers, which signals
 * could be judged, the limits of the detection, and the false alarm: an administrator can mark
 * it (with a note, audited) or take a mark back.
 */
export function SuspicionDialog({
  judgement,
  objectName,
  open,
  onOpenChange,
}: {
  judgement: Suspicion;
  objectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation("suspicion");
  const { canMarkFalseAlarm } = useSuspicionScope();
  const mark = useMarkFalseAlarm();
  const revoke = useRevokeFalseAlarm();
  const [note, setNote] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const noteId = React.useId();
  const time = formatDateTime(judgement.restorePointAt, i18n.language) ?? judgement.restorePointAt;
  const unusual = judgement.verdict === "unusual";
  // Suspicious and not resolved, or unusual and not marked as normal: it can be marked.
  const markable = judgement.active || (unusual && judgement.falseAlarm === null);

  React.useEffect(() => {
    if (!open) {
      setNote("");
      setConfirming(false);
    }
  }, [open]);

  const submit = () =>
    mark.mutate(
      { id: judgement.id, note: note.trim().length > 0 ? note.trim() : null },
      {
        onSuccess: () => {
          toast.success(t("falseAlarm.done"));
          onOpenChange(false);
        },
        onError: () => toast.error(t("falseAlarm.failed")),
      },
    );

  const undo = () =>
    revoke.mutate(judgement.id, {
      onSuccess: () => {
        toast(t("falseAlarm.revoked"));
        onOpenChange(false);
      },
      onError: () => toast.error(t("falseAlarm.revokeFailed")),
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-slot="suspicion-dialog">
        <DialogHeader>
          <DialogTitle>{unusual ? t("details.unusualTitle") : t("details.title")}</DialogTitle>
          <DialogDescription>{t("details.restorePoint", { time })}</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          {unusual ? (
            <p className="text-sm" data-slot="unusual-intro">
              {t("details.unusualIntro")}
            </p>
          ) : null}
          {judgement.findings.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("details.findings")}</h3>
              <FindingList judgement={judgement} />
            </section>
          ) : null}
          {judgement.breakdown ? (
            <section className="space-y-2">
              <h3 className="text-sm font-medium">{t("details.breakdown")}</h3>
              <BreakdownList breakdown={judgement.breakdown} />
            </section>
          ) : null}
          {judgement.reclassifiedAt ? (
            <p className="text-sm text-muted-foreground" data-slot="reclassified-mark">
              {t("details.reclassified", {
                time: formatDateTime(judgement.reclassifiedAt, i18n.language) ?? "",
              })}
            </p>
          ) : null}
          {judgement.falseAlarm ? (
            <p className="text-sm text-muted-foreground" data-slot="false-alarm-mark">
              {t("falseAlarm.by", {
                who: judgement.falseAlarm.by ?? "?",
                time: formatDateTime(judgement.falseAlarm.at, i18n.language) ?? "",
              })}
              {judgement.falseAlarm.note ? ` (${judgement.falseAlarm.note})` : null}
            </p>
          ) : null}
          {judgement.holdReleased ? (
            <p className="text-sm text-muted-foreground" data-slot="hold-released-mark">
              {t("hold.releasedBy", {
                who: judgement.holdReleased.by ?? "?",
                time: formatDateTime(judgement.holdReleased.at, i18n.language) ?? "",
              })}
              {judgement.holdReleased.note ? ` (${judgement.holdReleased.note})` : null}
            </p>
          ) : null}
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("details.signals")}</h3>
            <ul className="space-y-1 text-sm">
              {SIGNALS.map((signal) => {
                const state = judgement.signals[signal] ?? "unavailable";
                return (
                  <li key={signal} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{t(`signals.${signal}`)}</span>
                    <StatusBadge tone={SIGNAL_TONE[state]}>
                      {t(`signals.state.${state}`)}
                    </StatusBadge>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              {t("details.version", { version: judgement.signaturesVersion })}
            </p>
          </section>
          <p className="text-xs text-muted-foreground">{t("details.limits")}</p>
          {confirming ? (
            <div className="space-y-2 rounded-md border p-3" data-slot="false-alarm-form">
              <p className="text-sm font-medium">
                {unusual ? t("falseAlarm.normalTitle") : t("falseAlarm.title")}
              </p>
              <p className="text-sm text-muted-foreground">
                {unusual
                  ? t("falseAlarm.normalDescription", { object: objectName })
                  : t("falseAlarm.description", { object: objectName })}
              </p>
              <Label htmlFor={noteId}>{t("falseAlarm.note")}</Label>
              <Textarea
                id={noteId}
                value={note}
                maxLength={FALSE_ALARM_NOTE_MAX_LENGTH}
                placeholder={t("falseAlarm.notePlaceholder")}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                {t("falseAlarm.cancel")}
              </Button>
              <Button onClick={submit} loading={mark.isPending}>
                {t("falseAlarm.confirm")}
              </Button>
            </>
          ) : (
            <>
              {canMarkFalseAlarm && markable ? (
                <Button variant="outline" onClick={() => setConfirming(true)}>
                  {unusual ? t("falseAlarm.normalAction") : t("falseAlarm.action")}
                </Button>
              ) : null}
              {canMarkFalseAlarm && judgement.falseAlarm ? (
                <Button variant="outline" onClick={undo} loading={revoke.isPending}>
                  {t("falseAlarm.revoke")}
                </Button>
              ) : null}
              <Button onClick={() => onOpenChange(false)}>{t("details.close")}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
