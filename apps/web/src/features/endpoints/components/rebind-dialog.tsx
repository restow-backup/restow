import { Link2, ShieldAlert, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { RelativeTime } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { CreatedRebindToken, EndpointSummary, RebindPurpose } from "../api.js";
import { useCreateRebindToken, useEndpointFormat } from "../hooks.js";
import { endpointErrorKey, endpointName } from "../presenters.js";
import { CommandBox } from "./enroll-dialog.js";

/** The validities a rebind token offers: an hour by default, a day at most (docs/BAREMETAL.md 11). */
export const REBIND_VALIDITY_CHOICES = [1, 2, 4, 8, 12, 24] as const;

type RebindMachine = Pick<EndpointSummary, "id" | "hostname" | "displayName" | "os" | "status">;

export interface RebindDialogViewProps {
  machine: RebindMachine;
  purpose: RebindPurpose;
  validityHours: number;
  onValidityChange: (hours: number) => void;
  unrevoke: boolean;
  onUnrevokeChange: (unrevoke: boolean) => void;
  created: CreatedRebindToken | null;
  pending: boolean;
  error: unknown;
  onCreate: () => void;
  onClose: () => void;
}

/**
 * The rebind token, in its own dialog and never with a recovery code (docs/BAREMETAL.md 11): it
 * gives lasting access like an installed agent, and whoever redeems it becomes this machine. The
 * dialog says so first, offers an hour (at most a day), brings a revoked machine back only when
 * that is chosen, and then shows the token once with the install command of the machine's system.
 */
export function RebindDialogView(props: RebindDialogViewProps) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const { machine, created } = props;
  const revoked = machine.status === "revoked";
  return (
    <DialogContent className="sm:max-w-2xl" data-slot="rebind-dialog">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Link2 aria-hidden="true" className="size-4" />
          {t("rebind.title", { name: endpointName(machine) })}
        </DialogTitle>
        <DialogDescription>{t(`rebind.purpose.${props.purpose}`)}</DialogDescription>
      </DialogHeader>
      {created ? (
        <div className="grid gap-3" data-slot="rebind-created">
          <p className="text-sm">{t("rebind.created")}</p>
          <p className="text-sm text-muted-foreground">{t("rebind.commands")}</p>
          <CommandBox command={created.commands.install} label={t("enroll.command.copy")} />
          <p className="text-sm text-muted-foreground">{t("enroll.command.tokenIntro")}</p>
          <div data-slot="rebind-token">
            <CommandBox command={created.token} label={t("enroll.command.copyToken")} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("enroll.command.expiresAt", { time: format.dateTime(created.expiresAt) })}{" "}
            <span className="whitespace-nowrap">
              (<RelativeTime value={created.expiresAt} focusable={false} />)
            </span>
          </p>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            {t("enroll.command.secretNote")}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          <Alert variant="warning" data-slot="rebind-warning">
            <TriangleAlert />
            <AlertTitle>{t("rebind.warningTitle")}</AlertTitle>
            <AlertDescription>
              <p>{t("rebind.warning")}</p>
              <p>{t("rebind.oldDisconnects")}</p>
            </AlertDescription>
          </Alert>
          <div className="grid gap-1.5">
            <Label htmlFor="rebind-validity">{t("rebind.validity")}</Label>
            <Select
              value={String(props.validityHours)}
              onValueChange={(value) => props.onValidityChange(Number(value))}
            >
              <SelectTrigger id="rebind-validity" className="w-full sm:w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REBIND_VALIDITY_CHOICES.map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {t("recovery.validityHours", { count: hours })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {revoked ? (
            <div className="grid gap-1.5" data-slot="rebind-unrevoke">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="rebind-unrevoke"
                  checked={props.unrevoke}
                  onCheckedChange={(checked) => props.onUnrevokeChange(checked === true)}
                />
                <Label htmlFor="rebind-unrevoke" className="font-normal">
                  {t("rebind.unrevoke")}
                </Label>
              </div>
              <p className="text-sm text-muted-foreground">{t("rebind.unrevokeHint")}</p>
            </div>
          ) : null}
          {revoked && !props.unrevoke ? (
            <p className="text-sm text-muted-foreground" data-slot="rebind-revoked">
              {t("rebind.revokedHint")}
            </p>
          ) : null}
          {props.error ? (
            <p className="text-sm text-destructive-text" role="alert">
              {t(endpointErrorKey(props.error))}
            </p>
          ) : null}
        </div>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose}>
          {t(created ? "rebind.done" : "rebind.cancel")}
        </Button>
        {created ? null : (
          <Button onClick={props.onCreate} disabled={props.pending} data-action="create-rebind">
            <Link2 aria-hidden="true" />
            {t("rebind.create")}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

export function RebindDialog({
  machine,
  purpose,
  open,
  onOpenChange,
}: {
  machine: RebindMachine;
  purpose: RebindPurpose;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateRebindToken(machine.id);
  const identity = useConfirmIdentity();
  const [validityHours, setValidityHours] = React.useState(1);
  const [unrevoke, setUnrevoke] = React.useState(false);
  const { reset } = create;

  React.useEffect(() => {
    if (!open) {
      // The token is a secret: forgotten with the dialog.
      reset();
      setValidityHours(1);
      setUnrevoke(false);
    }
  }, [open, reset]);

  const submit = () => {
    create.mutate(
      { purpose, validityHours, unrevoke: machine.status === "revoked" && unrevoke },
      {
        onError: (error) => {
          if (isRecentSignInRequired(error)) {
            identity.ask(submit);
          }
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <RebindDialogView
          machine={machine}
          purpose={purpose}
          validityHours={validityHours}
          onValidityChange={setValidityHours}
          unrevoke={unrevoke}
          onUnrevokeChange={setUnrevoke}
          created={create.data ?? null}
          pending={create.isPending}
          error={create.error && !isRecentSignInRequired(create.error) ? create.error : null}
          onCreate={submit}
          onClose={() => onOpenChange(false)}
        />
      ) : null}
      {identity.dialog}
    </Dialog>
  );
}
