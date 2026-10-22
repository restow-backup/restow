import { useNavigate } from "@tanstack/react-router";
import { Ban, Power, Trash2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Field } from "@/components/forms/field";
import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { formatDateTime } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { EndpointDetail, EndpointSummary, RemovalMode } from "../api.js";
import { useRemoveEndpoint, useRevokeEndpoint, useUninstallEndpoint } from "../hooks.js";
import { inventoryTo } from "../paths.js";
import { endpointErrorKey, endpointName } from "../presenters.js";

/**
 * Taking a machine out of {appName}: have the agent uninstall itself, or refuse it at once
 * (both leave its backups restorable), and, once it is revoked, remove it from every list with
 * its backups deleted now or when they expire (#65). An uninstall that waits for a machine that
 * is off offers to revoke it right away, and a machine without contact for long suggests it.
 */
export function DangerZone({ detail }: { detail: EndpointDetail }) {
  const { t } = useTranslation("endpoints");
  const uninstall = useUninstallEndpoint(detail.id);
  const revoke = useRevokeEndpoint(detail.id);
  const [uninstalling, setUninstalling] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const revoked = detail.status === "revoked";
  const name = endpointName(detail);
  const uninstallQueued = detail.tasks.some(
    (task) =>
      task.kind === "uninstall" && (task.status === "pending" || task.status === "delivered"),
  );
  const revokeSuggested = detail.attention?.includes("revoke_suggested") === true;
  const openRevoke = () => {
    revoke.reset();
    setRevoking(true);
  };

  return (
    <Card className="border-destructive/30" data-slot="danger-zone">
      <CardHeader>
        <CardTitle className="text-base text-destructive-text">{t("danger.title")}</CardTitle>
        <CardDescription>{t("danger.description")}</CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {revokeSuggested ? (
          <div className="pb-4" data-slot="revoke-suggested">
            <Alert variant="warning">
              <AlertDescription>
                {t("danger.revokeSuggested", { days: detail.settings.revokeHintAfterDays ?? 30 })}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        <div className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl space-y-1">
            <p className="text-sm font-medium">{t("danger.uninstall.title")}</p>
            <p className="text-sm text-muted-foreground">{t("danger.uninstall.description")}</p>
            {uninstallQueued && !revoked ? (
              <div className="space-y-2" data-slot="uninstall-waiting">
                <p className="text-sm text-warning-text">{t("danger.uninstall.queued")}</p>
                <p className="text-sm text-muted-foreground">
                  {t("danger.uninstall.revokeNowHint")}
                </p>
                <Button size="sm" variant="outline" onClick={openRevoke} data-action="revoke-now">
                  <Ban aria-hidden="true" />
                  {t("danger.uninstall.revokeNow")}
                </Button>
              </div>
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
        <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl space-y-1">
            <p className="text-sm font-medium">{t("danger.revoke.title")}</p>
            <p className="text-sm text-muted-foreground">{t("danger.revoke.description")}</p>
          </div>
          <Button
            variant="destructive"
            className="shrink-0"
            disabled={revoked}
            onClick={openRevoke}
          >
            <Ban aria-hidden="true" />
            {t("danger.revoke.action")}
          </Button>
        </div>
        <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="max-w-xl space-y-1">
            <p className="text-sm font-medium">{t("danger.remove.title")}</p>
            <p className="text-sm text-muted-foreground">
              {revoked ? t("danger.remove.description") : t("danger.remove.revokeFirst")}
            </p>
          </div>
          <Button
            variant="destructive"
            className="shrink-0"
            disabled={!revoked}
            onClick={() => setRemoving(true)}
            data-action="remove-machine"
          >
            <Trash2 aria-hidden="true" />
            {t("danger.remove.action")}
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
      <RevokeMachineDialog
        machine={detail}
        open={revoking}
        onOpenChange={setRevoking}
        revoke={revoke}
      />
      {removing ? (
        <RemoveMachineDialog machine={detail} onClose={() => setRemoving(false)} />
      ) : null}
    </Card>
  );
}

/** The machine a dialog of the danger zone acts on (its page's detail or an Inventory row). */
type DangerMachine = Pick<EndpointSummary, "id" | "hostname" | "displayName">;

/**
 * "Revoke": the hostname typed, irreversible. Used by the danger zone and by the machine's
 * detail panel on Inventory ("Revoke now").
 */
export function RevokeMachineDialog({
  machine,
  open,
  onOpenChange,
  revoke: given,
}: {
  machine: DangerMachine;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The danger zone's own mutation (it resets it when opening); otherwise one of its own. */
  revoke?: ReturnType<typeof useRevokeEndpoint>;
}) {
  const { t } = useTranslation("endpoints");
  const own = useRevokeEndpoint(machine.id);
  const revoke = given ?? own;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("danger.revoke.confirm.title", { name: endpointName(machine) })}
      description={
        <>
          <p>{t("danger.revoke.confirm.description")}</p>
          <p>{t("danger.revoke.confirm.irreversible")}</p>
        </>
      }
      confirmLabel={t("danger.revoke.confirm.action")}
      confirmationText={machine.hostname}
      destructive
      error={revoke.isError ? t(endpointErrorKey(revoke.error)) : undefined}
      onConfirm={async () => {
        await revoke.mutateAsync();
        toast.success(t("danger.revoke.toast"));
      }}
    />
  );
}

/**
 * "Remove from {appName}": how the backups go, the hostname typed, and a recent sign-in (asked
 * for when the API wants one, then the removal is repeated). Used by the danger zone and by the
 * machine's detail panel on Inventory.
 */
export function RemoveMachineDialog({
  machine,
  onClose,
  onRemoved,
}: {
  machine: DangerMachine;
  onClose: () => void;
  /** After the removal; without it the page goes to Inventory (the machine's page is gone). */
  onRemoved?: () => void;
}) {
  const { t, i18n } = useTranslation("endpoints");
  const navigate = useNavigate();
  const name = endpointName(machine);
  const remove = useRemoveEndpoint(machine.id);
  const identity = useConfirmIdentity();
  const [mode, setMode] = React.useState<RemovalMode>("expire");
  const [typed, setTyped] = React.useState("");
  const matches = typed.trim() === machine.hostname;

  const submit = () =>
    remove.mutate(
      { mode, confirmHostname: typed },
      {
        onSuccess: (result) => {
          const date =
            formatDateTime(result.expiresAt ?? result.dueAt, i18n.language) ?? result.dueAt;
          toast.success(
            t(
              result.mode === "delete"
                ? "danger.remove.toast.delete"
                : "danger.remove.toast.expire",
              {
                name,
                date,
              },
            ),
          );
          onClose();
          if (onRemoved) {
            onRemoved();
          } else {
            void navigate({ to: inventoryTo() });
          }
        },
        onError: (error) => {
          if (isRecentSignInRequired(error)) {
            identity.ask(submit);
          }
        },
      },
    );

  return (
    <>
      <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
        <DialogContent className="max-w-lg" data-slot="remove-machine-dialog">
          <DialogHeader>
            <DialogTitle>{t("danger.remove.confirm.title", { name })}</DialogTitle>
            <DialogDescription>{t("danger.remove.confirm.description")}</DialogDescription>
          </DialogHeader>
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as RemovalMode)}
            className="gap-3"
          >
            {(["expire", "delete"] as const).map((option) => (
              <div key={option} className="flex items-start gap-3">
                <RadioGroupItem id={`remove-mode-${option}`} value={option} className="mt-1" />
                <Label htmlFor={`remove-mode-${option}`} className="grid gap-1 font-normal">
                  <span className="font-medium">{t(`danger.remove.mode.${option}.label`)}</span>
                  <span className="text-sm text-muted-foreground">
                    {t(`danger.remove.mode.${option}.description`)}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
          <p className="text-sm text-muted-foreground">{t("danger.remove.confirm.locks")}</p>
          <Field
            id="remove-confirm-hostname"
            label={t("danger.remove.confirm.typeHostname", { hostname: machine.hostname })}
          >
            <Input
              id="remove-confirm-hostname"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </Field>
          {remove.isError && !isRecentSignInRequired(remove.error) ? (
            <Alert variant="destructive">
              <AlertDescription>{t(endpointErrorKey(remove.error))}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t("danger.remove.confirm.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={!matches}
              loading={remove.isPending}
              onClick={submit}
              data-action="confirm-remove"
            >
              {t(`danger.remove.confirm.action.${mode}`)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {identity.dialog}
    </>
  );
}
