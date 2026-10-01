import { KeyRound, ShieldAlert, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { CopyButton } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { RepositoryKey } from "../api.js";
import { useRevealRepositoryPassword } from "../hooks.js";
import { endpointErrorKey } from "../presenters.js";

/** The restic call an admin can run without Restow; the storage path is theirs to fill in. */
export function exampleRestoreCommand(storagePrefix: string): string {
  const prefix = storagePrefix.replace(/^\/+|\/+$/g, "");
  return `restic -r /path/to/storage/${prefix} restore latest --target /restore`;
}

function SecretBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/50 p-3">
      <code
        className="min-w-0 flex-1 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] select-all"
        tabIndex={0}
        aria-label={label}
      >
        {value}
      </code>
      <CopyButton value={value} label={label} className="shrink-0" />
    </div>
  );
}

export interface RepositoryKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Has the password been asked for and answered? */
  revealed: RepositoryKey | null;
  pending: boolean;
  error: unknown;
  onConfirm: () => void;
}

/** First the warning, then (once confirmed) the password, shown until the dialog closes. */
export function RepositoryKeyDialog({
  open,
  onOpenChange,
  revealed,
  pending,
  error,
  onConfirm,
}: RepositoryKeyDialogProps) {
  const { t } = useTranslation("endpoints");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl"
        // The password is shown once: a stray click beside the dialog must not throw it away.
        onInteractOutside={(event) => {
          if (revealed) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("repositoryKey.dialog.title")}</DialogTitle>
          <DialogDescription>
            {revealed
              ? t("repositoryKey.dialog.shownDescription")
              : t("repositoryKey.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        {revealed ? (
          <div className="grid gap-4" data-slot="repository-key-shown">
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t("repositoryKey.dialog.password")}</p>
              <SecretBox value={revealed.password} label={t("repositoryKey.dialog.copyPassword")} />
              <p className="text-xs text-muted-foreground">{t("repositoryKey.dialog.hideNote")}</p>
            </div>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t("repositoryKey.dialog.example")}</p>
              <SecretBox
                value={exampleRestoreCommand(revealed.storagePrefix)}
                label={t("repositoryKey.dialog.copyCommand")}
              />
              <p className="text-xs text-muted-foreground">
                {t("repositoryKey.dialog.exampleNote")}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t("repositoryKey.dialog.hide")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="grid gap-4">
            <Alert variant="warning">
              <ShieldAlert />
              <AlertTitle>{t("repositoryKey.dialog.warningTitle")}</AlertTitle>
              <AlertDescription>
                <p>{t("repositoryKey.dialog.audit")}</p>
                <p>{t("repositoryKey.dialog.power")}</p>
                <p>{t("repositoryKey.dialog.stepUp")}</p>
              </AlertDescription>
            </Alert>
            {error ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>
                  <p>{t(endpointErrorKey(error))}</p>
                </AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("repositoryKey.dialog.cancel")}
              </Button>
              <Button type="button" onClick={onConfirm} loading={pending}>
                {t("repositoryKey.dialog.confirm")}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Restore without Restow": the backup of a machine is a plain restic
 * repository, so whoever keeps its password can restore even when this server
 * is gone. Showing the password is a deliberate, audited act that needs a
 * recent sign-in (apps/api lib/recent-sign-in.ts: an older session confirms it
 * is them first, and the password is then asked for again); it is held in
 * memory while the dialog is open and dropped when it closes.
 */
export function RepositoryKeyCard({
  endpointId,
  disabled = false,
}: { endpointId: string; disabled?: boolean }) {
  const { t } = useTranslation("endpoints");
  const [open, setOpen] = React.useState(false);
  const reveal = useRevealRepositoryPassword(endpointId);
  const identity = useConfirmIdentity();
  const { reset } = reveal;

  const show = () => {
    reveal.mutate(undefined, {
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(show);
        }
      },
    });
  };

  React.useEffect(() => {
    if (!open) {
      reset();
    }
  }, [open, reset]);

  return (
    <Card data-slot="repository-key-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
          {t("repositoryKey.title")}
        </CardTitle>
        <CardDescription>{t("repositoryKey.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("repositoryKey.body")}</p>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
          <KeyRound aria-hidden="true" />
          {t("repositoryKey.show")}
        </Button>
      </CardContent>
      <RepositoryKeyDialog
        open={open}
        onOpenChange={setOpen}
        revealed={reveal.data ?? null}
        pending={reveal.isPending}
        error={reveal.error}
        onConfirm={show}
      />
      {identity.dialog}
    </Card>
  );
}
