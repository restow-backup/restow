import { LockKeyhole, RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { formatDateTime } from "@/lib/format";
import { immutabilityDetails, immutabilityHeadline } from "../immutability";
import { storageErrorKey } from "../presenters";
import type { StorageTargetDto } from "../types";
import { useVerifyImmutability } from "../use-storage";
import { ImmutabilityDialog } from "./immutability-dialog";
import { ToneLine } from "./status";

/**
 * Immutable backups on a repository card: the setting in words (what it
 * protects, and for a directory that it is no immutability), what the worker
 * last found out (renewal, verification, deletions waiting for their lock),
 * warnings first, and the actions to change it and to verify it now.
 */
export function ImmutabilitySection({ target }: { target: StorageTargetDto }) {
  const { t, i18n } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const verify = useVerifyImmutability();
  const immutability = target.immutability;
  if (target.kind === "installation_default" || target.role === "previous") {
    return null;
  }
  const headline = immutabilityHeadline(
    immutability,
    target.kind,
    target.objectLock?.status === "enabled",
  );
  const details = immutabilityDetails(immutability, {
    date: (iso) => formatDateTime(iso, i18n.language) ?? iso,
  });
  const canVerify = immutability?.kind === "object_lock" && immutability.mode !== null;

  const runVerify = () => {
    verify.mutate(target.id, {
      onSuccess: (result) => {
        const unlocked = result.verification?.unlocked ?? 0;
        if (unlocked > 0) {
          toast.error(t("immutability.verifyFoundUnlocked", { count: unlocked }));
        } else {
          toast.success(t("immutability.verifyDone"));
        }
      },
      onError: (error) => toast.error(tc(storageErrorKey(error))),
    });
  };

  return (
    <section aria-label={t("immutability.title")} className="space-y-1.5" data-slot="immutability">
      <ToneLine tone={headline.tone}>
        <span className="font-medium">{t(headline.key, headline.values)}</span>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t(`${headline.key}Hint`, headline.values)}
        </p>
      </ToneLine>
      {details.map((line) => (
        <ToneLine key={line.key} tone={line.tone} className="text-xs">
          {t(line.key, line.values)}
        </ToneLine>
      ))}
      {target.canManage || canVerify ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {target.canManage ? (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              <LockKeyhole />
              {t("immutability.configure")}
            </Button>
          ) : null}
          {canVerify ? (
            <Button variant="ghost" size="sm" onClick={runVerify} loading={verify.isPending}>
              {verify.isPending ? null : <RefreshCw />}
              {t("immutability.verify")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {target.canManage && open ? (
        <ImmutabilityDialog open={open} onOpenChange={setOpen} target={target} />
      ) : null}
    </section>
  );
}
