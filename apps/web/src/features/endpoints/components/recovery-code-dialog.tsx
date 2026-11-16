import { KeyRound, Printer, ShieldAlert, TriangleAlert } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ConfirmDialog, CopyButton } from "@/components/kit";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { IssuedRecoveryCode } from "../api.js";
import { useEndpointFormat, useIssueRecoveryCode } from "../hooks.js";
import {
  endpointErrorKey,
  RECOVERY_VALIDITY_CHOICES,
  recoveryCodeGroups,
  suggestedValidityHours,
} from "../presenters.js";

export interface RecoveryCodeFormProps {
  validityHours: number;
  suggestedHours: number;
  onValidityChange: (hours: number) => void;
  requireApproval: boolean;
  onRequireApprovalChange: (value: boolean) => void;
}

/** The address as the ISO must reach it, without the scheme when it is https. */
export function typedAddress(origin: string): string {
  return origin.replace(/^https:\/\//, "");
}

/**
 * What the code dialog shows once (docs/BAREMETAL.md 9.2, 14.6): the code in large groups, the
 * address to type exactly so (ASCII), the instance check value, the expiry, copy and print, and
 * the reminders: the code reads every backup of the machine once released, an address that came
 * from the browser must be the one the ISO reaches, and without a check value the ISO needs a
 * certificate it trusts.
 */
export function IssuedCodeView({
  issued,
  machineName,
}: {
  issued: IssuedRecoveryCode;
  machineName: string;
}) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const [printing, setPrinting] = React.useState(false);
  const address = typedAddress(issued.instanceOrigin);
  React.useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    window.print();
    // Browsers that print synchronously have printed by now.
    const timer = window.setTimeout(done, 1000);
    return () => {
      window.removeEventListener("afterprint", done);
      window.clearTimeout(timer);
    };
  }, [printing]);
  return (
    <div className="grid gap-4" data-slot="recovery-code-issued">
      {!issued.instanceOriginConfigured ? (
        <Alert variant="warning" data-warning="browser-origin">
          <TriangleAlert />
          <AlertDescription>{t("recovery.browserOriginWarning")}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">{t("recovery.onceHint")}</p>
      <div className="grid gap-1">
        <span className="text-sm font-medium">{t("recovery.code")}</span>
        <div className="flex items-start gap-2">
          <p
            className="flex-1 font-mono text-2xl font-semibold tracking-wider break-all select-all"
            data-slot="recovery-code"
          >
            <span className="text-muted-foreground">RC</span>
            {recoveryCodeGroups(issued.code).map((group) => (
              <span key={group}>
                <span className="text-muted-foreground">-</span>
                {group}
              </span>
            ))}
          </p>
          <CopyButton value={issued.code} label={t("recovery.copy")} />
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">{t("recovery.address")}</dt>
        <dd>
          <span className="font-mono" data-slot="recovery-address">
            {address}
          </span>
          <p className="text-xs text-muted-foreground">{t("recovery.addressHint")}</p>
        </dd>
        <dt className="text-muted-foreground">{t("recovery.spkiCheck")}</dt>
        <dd data-slot="recovery-spki">
          {issued.spkiCheck ? (
            <span className="font-mono">{issued.spkiCheck}</span>
          ) : (
            <span className="text-muted-foreground">{t("recovery.spkiMissing")}</span>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("recovery.expiresAt")}</dt>
        <dd>{format.dateTime(issued.expiresAt)}</dd>
      </dl>
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("recovery.readAccessHint")}
      </p>
      <div>
        <Button variant="outline" size="sm" onClick={() => setPrinting(true)}>
          <Printer aria-hidden="true" />
          {t("recovery.print")}
        </Button>
      </div>
      {printing
        ? createPortal(
            <>
              <style>
                {
                  "@media print { body > *:not([data-recovery-print]) { display: none !important; } }"
                }
              </style>
              <div data-recovery-print="" className="hidden p-8 font-sans print:block">
                <h1 className="text-xl font-semibold">{t("recovery.printTitle")}</h1>
                <p className="mt-4 font-mono text-2xl tracking-wider">{issued.code}</p>
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                  <dt>{t("recovery.address")}</dt>
                  <dd className="font-mono">{address}</dd>
                  <dt>{t("recovery.spkiCheck")}</dt>
                  <dd className="font-mono">{issued.spkiCheck ?? "-"}</dd>
                  <dt>{t("recovery.machine")}</dt>
                  <dd>{machineName}</dd>
                  <dt>{t("recovery.expiresAt")}</dt>
                  <dd>{format.dateTime(issued.expiresAt)}</dd>
                </dl>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

export function RecoveryCodeForm(props: RecoveryCodeFormProps) {
  const { t } = useTranslation("endpoints");
  return (
    <div className="grid gap-4" data-slot="recovery-code-form">
      <div className="grid gap-1.5">
        <Label htmlFor="recovery-validity">{t("recovery.validity")}</Label>
        <Select
          value={String(props.validityHours)}
          onValueChange={(value) => props.onValidityChange(Number(value))}
        >
          <SelectTrigger id="recovery-validity" className="w-full sm:w-60">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RECOVERY_VALIDITY_CHOICES.map((hours) => (
              <SelectItem key={hours} value={String(hours)}>
                {t("recovery.validityHours", { count: hours })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground" data-slot="recovery-validity-suggestion">
          {t("recovery.validitySuggestion", { count: props.suggestedHours })}
        </p>
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center gap-2">
          <Switch
            id="recovery-require-approval"
            checked={props.requireApproval}
            onCheckedChange={props.onRequireApprovalChange}
          />
          <Label htmlFor="recovery-require-approval">{t("recovery.requireApproval")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t("recovery.requireApprovalHint")}</p>
      </div>
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("recovery.readAccessHint")}
      </p>
    </div>
  );
}

/**
 * The recovery code dialog (docs/BAREMETAL.md 9.2, 14.6): the validity (suggested from the data to
 * restore at an assumed 50 MB/s, at least 4 hours), the release after the exchange (on; switching
 * it off asks first), a recent sign-in, then the code once. No rebind token here: that is a
 * dialog of its own.
 */
export function RecoveryCodeDialog({
  endpointId,
  machineName,
  snapshotId,
  restoreBytes,
  open,
  onOpenChange,
  onIssued,
}: {
  endpointId: string;
  machineName: string;
  snapshotId?: string;
  restoreBytes?: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued?: (issued: IssuedRecoveryCode) => void;
}) {
  const { t } = useTranslation("endpoints");
  const issue = useIssueRecoveryCode(endpointId);
  const identity = useConfirmIdentity();
  const suggested = suggestedValidityHours(restoreBytes);
  const [validityHours, setValidityHours] = React.useState(suggested);
  const [requireApproval, setRequireApproval] = React.useState(true);
  const [confirmOff, setConfirmOff] = React.useState(false);
  const { reset } = issue;

  React.useEffect(() => {
    if (!open) {
      // The code is a secret: forgotten with the dialog.
      reset();
      setValidityHours(suggested);
      setRequireApproval(true);
    }
  }, [open, reset, suggested]);

  const submit = () => {
    issue.mutate(
      { validityHours, requireApproval, ...(snapshotId ? { snapshotId } : {}) },
      {
        onSuccess: (issued) => onIssued?.(issued),
        onError: (error) => {
          if (isRecentSignInRequired(error)) {
            identity.ask(submit);
          }
        },
      },
    );
  };

  const issued = issue.data ?? null;
  const error = issue.error && !isRecentSignInRequired(issue.error) ? issue.error : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="sm:max-w-2xl" data-slot="recovery-code-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound aria-hidden="true" className="size-4" />
              {t("recovery.title", { name: machineName })}
            </DialogTitle>
            <DialogDescription>{t("recovery.description")}</DialogDescription>
          </DialogHeader>
          {issued ? (
            <IssuedCodeView issued={issued} machineName={machineName} />
          ) : (
            <RecoveryCodeForm
              validityHours={validityHours}
              suggestedHours={suggested}
              onValidityChange={setValidityHours}
              requireApproval={requireApproval}
              onRequireApprovalChange={(value) => {
                if (value) {
                  setRequireApproval(true);
                } else {
                  setConfirmOff(true);
                }
              }}
            />
          )}
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{t("recovery.issueFailed")}</AlertTitle>
              <AlertDescription>{t(endpointErrorKey(error))}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t(issued ? "recovery.done" : "recovery.cancel")}
            </Button>
            {issued ? null : (
              <Button onClick={submit} disabled={issue.isPending} data-action="issue-code">
                <KeyRound aria-hidden="true" />
                {t("recovery.issue")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      ) : null}
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title={t("recovery.requireApprovalOffTitle")}
        description={<p>{t("recovery.requireApprovalOffConfirm")}</p>}
        confirmLabel={t("recovery.requireApprovalOffAction")}
        destructive
        onConfirm={async () => {
          setRequireApproval(false);
        }}
      />
      {identity.dialog}
    </Dialog>
  );
}
