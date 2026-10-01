import { Ban, Power } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";

import type { EndpointDetail } from "../api.js";
import { useRevokeEndpoint, useUninstallEndpoint } from "../hooks.js";
import { endpointErrorKey, endpointName } from "../presenters.js";

/**
 * Removing a machine from Restow: have the agent uninstall itself, or refuse it
 * at once. Both leave the backups that exist restorable.
 */
export function DangerZone({ detail }: { detail: EndpointDetail }) {
  const { t } = useTranslation("endpoints");
  const uninstall = useUninstallEndpoint(detail.id);
  const revoke = useRevokeEndpoint(detail.id);
  const [uninstalling, setUninstalling] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const revoked = detail.status === "revoked";
  const name = endpointName(detail);
  const uninstallQueued = detail.tasks.some(
    (task) =>
      task.kind === "uninstall" && (task.status === "pending" || task.status === "delivered"),
  );

  return (
    <Card className="border-destructive/30" data-slot="danger-zone">
      <CardHeader>
        <CardTitle className="text-base text-destructive-text">{t("danger.title")}</CardTitle>
        <CardDescription>{t("danger.description")}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl space-y-1">
            <p className="text-sm font-medium">{t("danger.uninstall.title")}</p>
            <p className="text-sm text-muted-foreground">{t("danger.uninstall.description")}</p>
            {uninstallQueued ? (
              <p className="text-sm text-warning-text">{t("danger.uninstall.queued")}</p>
            ) : null}
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={revoked || uninstallQueued}
            onClick={() => {
              uninstall.reset();
              setUninstalling(true);
            }}
          >
            <Power aria-hidden="true" />
            {t("danger.uninstall.action")}
          </Button>
        </div>
        <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl space-y-1">
            <p className="text-sm font-medium">{t("danger.revoke.title")}</p>
            <p className="text-sm text-muted-foreground">{t("danger.revoke.description")}</p>
          </div>
          <Button
            variant="destructive"
            className="shrink-0"
            disabled={revoked}
            onClick={() => {
              revoke.reset();
              setRevoking(true);
            }}
          >
            <Ban aria-hidden="true" />
            {t("danger.revoke.action")}
          </Button>
        </div>
      </CardContent>

      <ConfirmDialog
        open={uninstalling}
        onOpenChange={setUninstalling}
        title={t("danger.uninstall.confirm.title", { name })}
        description={
          <>
            <p>{t("danger.uninstall.confirm.description")}</p>
            <p>{t("danger.uninstall.confirm.offline")}</p>
          </>
        }
        confirmLabel={t("danger.uninstall.confirm.action")}
        destructive
        error={uninstall.isError ? t(endpointErrorKey(uninstall.error)) : undefined}
        onConfirm={async () => {
          const result = await uninstall.mutateAsync();
          (result.alreadyQueued ? toast.info : toast.success)(
            t(
              result.alreadyQueued
                ? "danger.uninstall.toast.already"
                : "danger.uninstall.toast.queued",
            ),
          );
        }}
      />
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t("danger.revoke.confirm.title", { name })}
        description={
          <>
            <p>{t("danger.revoke.confirm.description")}</p>
            <p>{t("danger.revoke.confirm.irreversible")}</p>
          </>
        }
        confirmLabel={t("danger.revoke.confirm.action")}
        confirmationText={detail.hostname}
        destructive
        error={revoke.isError ? t(endpointErrorKey(revoke.error)) : undefined}
        onConfirm={async () => {
          await revoke.mutateAsync();
          toast.success(t("danger.revoke.toast"));
        }}
      />
    </Card>
  );
}
