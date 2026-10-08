import { Link } from "@tanstack/react-router";
import { ShieldAlert, TriangleAlert, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DisabledReason } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PasskeyImpact } from "../api";
import type { PasskeyLoss } from "../forms";
import { usePasskeyImpact } from "../hooks";
import { accountTo } from "../paths";

export interface PasskeyLossDialogProps {
  /** What the pending change does to passkeys; null while closed. */
  loss: PasskeyLoss | null;
  /** The stored and the new host name, for `host_change`. */
  fromHost: string | null;
  toHost: string | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Whether the requester would lock themselves out (then the change is refused). */
export function blocksSelf(impact: PasskeyImpact | undefined): boolean {
  return impact?.self.lockedOut === true;
}

/**
 * The question before a change that makes every registered passkey stop
 * working (local mode, or the public URL on another host). It names how many
 * accounts then cannot sign in at all, and refuses the change while the
 * requester's own account is one of them.
 */
export function PasskeyLossDialog({
  loss,
  fromHost,
  toHost,
  pending,
  onCancel,
  onConfirm,
}: PasskeyLossDialogProps) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const impact = usePasskeyImpact(loss !== null);
  const blocked = blocksSelf(impact.data);
  const host = loss === "host_change";

  return (
    <Dialog open={loss !== null} onOpenChange={(open) => !open && !pending && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {host ? t("general.passkeyLoss.titleHost") : t("general.passkeyLoss.titleLocal")}
          </DialogTitle>
          <DialogDescription>
            {host
              ? t("general.passkeyLoss.descriptionHost", { from: fromHost ?? "", to: toHost ?? "" })
              : t("general.passkeyLoss.descriptionLocal")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3" aria-live="polite">
          {impact.isPending ? (
            <p className="text-sm text-muted-foreground">{t("general.passkeyLoss.checking")}</p>
          ) : impact.isError ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>{t("general.passkeyLoss.loadError")}</AlertDescription>
            </Alert>
          ) : (
            <ImpactSummary impact={impact.data} />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {tc("actions.cancel")}
          </Button>
          <DisabledReason reason={blocked ? t("general.passkeyLoss.blocked") : null}>
            <Button
              variant="destructive"
              onClick={onConfirm}
              loading={pending}
              disabled={blocked || impact.isPending}
            >
              {host ? t("general.passkeyLoss.confirmHost") : t("general.passkeyLoss.confirmLocal")}
            </Button>
          </DisabledReason>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ImpactSummary({ impact }: { impact: PasskeyImpact }) {
  const { t } = useTranslation("settings");
  if (impact.accountsWithPasskeys === 0) {
    return <p className="text-sm text-muted-foreground">{t("general.passkeyLoss.none")}</p>;
  }
  if (impact.accountsLockedOut === 0) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Users className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("general.passkeyLoss.allCovered", { count: impact.accountsWithPasskeys })}
      </p>
    );
  }
  return (
    <>
      <Alert variant="warning">
        <TriangleAlert />
        <AlertDescription>
          {t("general.passkeyLoss.lockedOut", {
            locked: impact.accountsLockedOut,
            count: impact.accountsWithPasskeys,
          })}
        </AlertDescription>
      </Alert>
      {impact.self.lockedOut ? (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertDescription className="space-y-3">
            <p>
              {impact.self.hasPassword
                ? t("general.passkeyLoss.selfLocked")
                : t("general.passkeyLoss.selfNoPassword")}
            </p>
            {impact.self.hasPassword ? (
              <Button asChild variant="outline" size="sm">
                <Link to={accountTo()}>{t("general.passkeyLoss.setUpAuthenticator")}</Link>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
