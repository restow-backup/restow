import { Info, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";

import type { RestartsView } from "../api";
import { useRestartService } from "../hooks";
import {
  type RestartGroup,
  restartCommand,
  restartGroups,
  restartReasonKey,
  updatesErrorKey,
} from "../presenters";
import { CommandBlock } from "./command-block";

/**
 * "Restart required" on the Updates tab: which services need a restart and
 * why, a "Restart now" button that asks the updater to restart exactly that
 * service (only when it can, and only for the owner role, after a
 * confirmation), and always the command to run on the server instead. Shows
 * nothing while no service needs a restart.
 */
export function RestartCard({
  restarts,
  canChange,
}: {
  restarts: RestartsView;
  /** The viewer may restart (the owner role, not the demo). */
  canChange: boolean;
}) {
  const { t } = useTranslation("updates");
  const groups = restartGroups(restarts.requests);
  if (groups.length === 0) {
    return null;
  }
  const availability = restarts.updater;

  return (
    <Card data-slot="restart-required" data-updater={availability}>
      <CardHeader>
        <CardTitle>{t("restart.title")}</CardTitle>
        <CardDescription>{t("restart.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {availability === "ready" ? null : (
          <Alert variant="info" data-slot="restart-availability">
            <Info />
            <AlertDescription>{t(`restart.availability.${availability}`)}</AlertDescription>
          </Alert>
        )}
        {availability === "ready" && !canChange ? (
          <Alert variant="info" data-slot="restart-owner-only">
            <Info />
            <AlertDescription>{t("restart.ownerOnly")}</AlertDescription>
          </Alert>
        ) : null}
        {groups.map((group) => (
          <ServiceRestart
            key={group.service}
            group={group}
            restarts={restarts}
            canRestart={availability === "ready" && canChange}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ServiceRestart({
  group,
  restarts,
  canRestart,
}: {
  group: RestartGroup;
  restarts: RestartsView;
  canRestart: boolean;
}) {
  const { t } = useTranslation("updates");
  const restart = useRestartService();
  const [confirming, setConfirming] = React.useState(false);
  const service = group.service;
  const label = t(`restart.services.${service}`);
  const last = restarts.lastRestart?.service === service ? restarts.lastRestart : null;
  const command = restartCommand(service, restarts.projectDir);

  return (
    <section
      className="space-y-3"
      data-slot="restart-service"
      data-service={service}
      aria-labelledby={`restart-${service}`}
    >
      <h3 id={`restart-${service}`} className="font-medium">
        {t("restart.needs", { service: label })}
      </h3>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {group.reasons.map((reason) => (
          <li key={reason} data-reason={reason}>
            {t(restartReasonKey(reason), { defaultValue: t("restart.reasonUnknown") })}
          </li>
        ))}
      </ul>
      {last?.status === "running" || last?.status === "succeeded" ? (
        <Alert variant="info" data-slot="restart-progress">
          <Loader2 className="motion-safe:animate-spin" />
          <AlertDescription>{t("restart.restarting", { service: label })}</AlertDescription>
        </Alert>
      ) : null}
      {last?.status === "failed" ? (
        <Alert variant="warning" data-slot="restart-failed">
          <TriangleAlert />
          <AlertTitle>{t("restart.failed", { service: label })}</AlertTitle>
        </Alert>
      ) : null}
      {canRestart ? (
        <div>
          <Button onClick={() => setConfirming(true)} data-slot="restart-now">
            <RotateCw />
            {t("restart.restartNow")}
          </Button>
        </div>
      ) : null}
      <div className="space-y-2">
        <p className="text-sm">{canRestart ? t("restart.command") : t("restart.commandOnly")}</p>
        <CommandBlock command={command} copyLabel={t("commands.copy")} />
        {restarts.projectDir === null ? (
          <p className="text-sm text-muted-foreground" data-slot="restart-directory-note">
            {t("restart.directoryNote")}
          </p>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("restart.confirmTitle", { service: label })}
        description={<p>{t("restart.confirmBody", { service: label, name: service })}</p>}
        confirmLabel={t("restart.confirm")}
        cancelLabel={t("restart.keep")}
        pending={restart.isPending}
        error={restart.isError ? t(updatesErrorKey(restart.error)) : undefined}
        onConfirm={() =>
          restart.mutateAsync(service).then(() => {
            toast.info(t("toasts.restartRequested", { service: label }));
          })
        }
      />
    </section>
  );
}
