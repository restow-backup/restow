import { ChevronDown, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit/confirm-dialog";
import { CopyButton } from "@/components/kit/copy-button";
import { RelativeTime } from "@/components/kit/relative-time";
import { StatusBadge } from "@/components/kit/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "@/components/ui/sonner";
import { formatBytes } from "@/lib/format";

import type { RunView, UpdatesView } from "../api";
import { useDismissRun } from "../hooks";
import { StepsList } from "../maintenance/maintenance-modal";
import { useUpdateMessage } from "../messages";
import {
  canDismissRun,
  failureKey,
  isMaintenanceActive,
  recoveryPlan,
  recoveryScript,
  runStatusOf,
  stepLabelKey,
  switchKey,
  updatesErrorKey,
} from "../presenters";
import { ProgressBar } from "../progress-bar";
import { CommandBlock, CommandList } from "./command-block";

/** The current or last update run: outcome, steps, why it failed and, if it needs you, how to recover. */
export function RunCard({ view, canChange }: { view: UpdatesView; canChange: boolean }) {
  const { t } = useTranslation("updates");
  const describeMessage = useUpdateMessage();
  const run = view.run;
  const dismiss = useDismissRun();
  const [confirming, setConfirming] = React.useState(false);
  if (!run) {
    return null;
  }
  const phase = view.maintenance.phase;
  const active = isMaintenanceActive(phase);
  const status = runStatusOf(run, phase);
  const dismissable = canDismissRun(phase);
  const needsAttention = run.outcome === "needs_attention";
  const messageText = describeMessage(run.message, run.switchTo);

  const doDismiss = () =>
    dismiss.mutateAsync().then(() => {
      toast.success(t("toasts.dismissed"));
    });

  return (
    <Card data-slot="run" data-status={status.kind}>
      <CardHeader>
        <CardTitle>
          {t(switchKey(active ? "run.titleActive" : "run.title", run.switchTo))}
        </CardTitle>
        <CardDescription className="[overflow-wrap:anywhere]">
          {run.switchTo
            ? t("run.versionSwitch", { to: run.targetVersion })
            : run.fromVersion
              ? t("run.versions", { from: run.fromVersion, to: run.targetVersion })
              : t("run.versionTo", { to: run.targetVersion })}
        </CardDescription>
        <CardAction>
          <StatusBadge tone={status.tone} icon live={status.kind === "running"}>
            {t(`run.status.${status.kind}`)}
          </StatusBadge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="text-muted-foreground">{t("run.requestedBy")}</dt>
            <dd className="[overflow-wrap:anywhere]">{run.requestedBy.label}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-muted-foreground">{t("run.mode")}</dt>
            <dd>{t(`source.mode.${run.mode}.label`)}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-muted-foreground">
              {run.startedAt ? t("run.startedAt") : t("run.startsAt")}
            </dt>
            <dd>
              <RelativeTime value={run.startedAt ?? run.startsAt} />
            </dd>
          </div>
          {run.finishedAt ? (
            <div className="space-y-1">
              <dt className="text-muted-foreground">{t("run.finishedAt")}</dt>
              <dd>
                <RelativeTime value={run.finishedAt} />
              </dd>
            </div>
          ) : null}
          {run.mode === "image" && run.signatureVerified !== null ? (
            <div className="space-y-1" data-slot="run-signature">
              <dt className="text-muted-foreground">{t("run.signature.label")}</dt>
              <dd>
                {run.signatureVerified
                  ? t("run.signature.verified")
                  : run.failure?.code === "fetch.signature_invalid"
                    ? t("run.signature.invalid")
                    : t("run.signature.off")}
              </dd>
            </div>
          ) : null}
        </dl>

        {run.outcome && run.outcome !== "needs_attention" ? (
          <p className="text-sm text-muted-foreground" data-slot="outcome-note">
            {t(switchKey(`run.outcomeNote.${run.outcome}`, run.switchTo))}
          </p>
        ) : null}

        {run.cancelled ? (
          <p className="text-sm text-muted-foreground">{t("run.cancelledNote")}</p>
        ) : (
          <>
            {phase === "running" || (run.startedAt && !run.finishedAt) ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t("maintenance.modal.progress")}</span>
                  <span className="tabular-nums">
                    {t("maintenance.modal.percent", { value: Math.round(run.progress) })}
                  </span>
                </div>
                <ProgressBar value={run.progress} label={t("maintenance.modal.progress")} />
              </div>
            ) : null}
            <StepsList steps={run.steps} currentStep={run.step} mode={run.mode} />
            {messageText ? (
              <p className="text-sm text-muted-foreground" data-slot="run-message">
                {messageText}
              </p>
            ) : null}
          </>
        )}

        {run.failure ? (
          <Alert variant={needsAttention ? "destructive" : "warning"} data-slot="run-failure">
            <TriangleAlert />
            <AlertTitle>{t(failureKey(run.failure.code))}</AlertTitle>
            <AlertDescription>
              <p>{t("run.failure.step", { step: t(stepLabelKey(run.failure.step, run.mode)) })}</p>
              {run.failure.migrationsRan !== null ? (
                <p>
                  {run.failure.migrationsRan
                    ? t("run.failure.migrationsRan")
                    : t("run.failure.migrationsNotRun")}
                </p>
              ) : null}
              {run.failure.detail ? (
                <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {run.failure.detail}
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {needsAttention && run.recovery ? <Recovery run={run} /> : null}

        {run.log.length > 0 ? <LogTail lines={run.log} /> : null}
      </CardContent>
      {dismissable ? (
        <CardFooter className="flex flex-col items-start gap-2 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {needsAttention ? t("run.dismiss.attentionHint") : t("run.dismiss.hint")}
          </p>
          <Button
            variant="outline"
            disabled={!canChange}
            loading={dismiss.isPending && !needsAttention}
            onClick={() =>
              needsAttention
                ? setConfirming(true)
                : void doDismiss().catch((error) => toast.error(t(updatesErrorKey(error))))
            }
          >
            {t("run.dismiss.action")}
          </Button>
        </CardFooter>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("run.dismiss.confirmTitle")}
        description={<p>{t("run.dismiss.confirmBody")}</p>}
        confirmLabel={t("run.dismiss.action")}
        pending={dismiss.isPending}
        error={dismiss.isError ? t(updatesErrorKey(dismiss.error)) : undefined}
        onConfirm={doDismiss}
      />
    </Card>
  );
}

/** The way out of "needs attention", as the exact commands. */
function Recovery({ run }: { run: RunView }) {
  const { t, i18n } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const recovery = run.recovery;
  if (!recovery) {
    return null;
  }
  const language = i18n.resolvedLanguage ?? i18n.language;
  const plan = recoveryPlan(recovery);

  return (
    <Alert
      variant="destructive"
      data-slot="recovery"
      className="border-2 has-[>svg]:grid-cols-[calc(var(--spacing)*4)_minmax(0,1fr)]"
    >
      <TriangleAlert />
      <AlertTitle className="text-base">{t("recovery.title")}</AlertTitle>
      <AlertDescription className="w-full min-w-0 grid-cols-[minmax(0,1fr)] justify-items-stretch gap-4">
        <p>{t("recovery.body", { product: tc("app.name") })}</p>
        <p className="text-sm">
          {t("recovery.dump", {
            file: recovery.dumpFile,
            size: recovery.dumpBytes !== null ? formatBytes(recovery.dumpBytes, language) : "?",
            version: recovery.fromVersion ?? "?",
          })}
        </p>
        <ol className="w-full list-decimal space-y-4 pl-5">
          {plan.map((step) => (
            <li key={step.id} className="space-y-2" data-step={step.id}>
              <p className="font-medium">{t(`recovery.steps.${step.id}`)}</p>
              {step.id === "images" ? (
                <div className="space-y-2">
                  {step.commands.length > 0 ? (
                    <CommandList commands={step.commands} copyLabel={t("commands.copyLine")} />
                  ) : null}
                  {step.removeVariables.length > 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("recovery.removeLines", { names: step.removeVariables.join(", ") })}
                    </p>
                  ) : null}
                </div>
              ) : (
                <CommandBlock command={step.commands.join("\n")} copyLabel={t("commands.copy")} />
              )}
            </li>
          ))}
        </ol>
        <div className="flex items-center gap-2 text-sm">
          <CopyButton value={recoveryScript(recovery)} label={t("recovery.copyAll")} />
          <span className="text-muted-foreground">{t("recovery.copyAll")}</span>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function LogTail({ lines }: { lines: readonly string[] }) {
  const { t } = useTranslation("updates");
  const [open, setOpen] = React.useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="run-log">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="-ml-2.5">
          <ChevronDown className={open ? "rotate-180" : undefined} aria-hidden="true" />
          {open ? t("run.log.hide") : t("run.log.show")}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        <p className="text-xs text-muted-foreground">{t("run.log.note")}</p>
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed">
          {lines.join("\n")}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
