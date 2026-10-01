import { ArrowUpToLine, CircleCheck, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

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
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { formatBytes, formatInteger } from "@/lib/format";
import { completenessOf, storageErrorKey } from "../presenters";
import type { CompletenessCount, CopyCompleteness, StorageTargetDto } from "../types";
import { useCompleteness, usePromoteTarget } from "../use-storage";

interface CopyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: StorageTargetDto;
  /** `promote` additionally offers to make the copy the primary once it is complete. */
  mode: "completeness" | "promote";
  /** Whether the tenant currently runs on the installation default. */
  fromInstallationDefault: boolean;
}

/**
 * Does this copy hold everything the primary holds? The check compares
 * listings (packs, manifests, keys) and runs as soon as the dialog opens. For
 * a promotion it is the gate: only a verified, complete copy becomes primary.
 */
export function CopyDialog({
  open,
  onOpenChange,
  target,
  mode,
  fromInstallationDefault,
}: CopyDialogProps) {
  const { t } = useTranslation("storage");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(mode === "promote" ? "promote.title" : "completeness.title", { name: target.name })}
          </DialogTitle>
          <DialogDescription>
            {mode === "promote"
              ? t(
                  fromInstallationDefault
                    ? "promote.descriptionFromDefault"
                    : "promote.description",
                )
              : t("completeness.description")}
          </DialogDescription>
        </DialogHeader>
        <CopyCheck target={target} mode={mode} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function CopyCheck({
  target,
  mode,
  onDone,
}: {
  target: StorageTargetDto;
  mode: "completeness" | "promote";
  onDone: () => void;
}) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const check = useCompleteness(target.id);
  const promote = usePromoteTarget(target.id);
  const { mutate: runCheck } = check;
  const started = React.useRef(false);

  // Check once when the dialog opens (the ref keeps a strict-mode double effect from checking twice).
  React.useEffect(() => {
    if (!started.current) {
      started.current = true;
      runCheck();
    }
  }, [runCheck]);

  const completeness = check.data?.completeness ?? completenessOf(promote.error);
  const verified = target.status === "ok";
  const canPromote = mode === "promote" && verified && completeness?.complete === true;

  const confirm = () => {
    promote.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("toasts.promoted", { name: target.name }));
        onDone();
      },
    });
  };

  return (
    <>
      <div className="space-y-4">
        {check.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <p className="text-sm text-muted-foreground">{t("completeness.checking")}</p>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : check.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(storageErrorKey(check.error))}</AlertDescription>
          </Alert>
        ) : completeness ? (
          <CompletenessReport completeness={completeness} />
        ) : null}

        {mode === "promote" && !verified ? (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertTitle>{t("promote.notVerified.title")}</AlertTitle>
            <AlertDescription>{t("promote.notVerified.description")}</AlertDescription>
          </Alert>
        ) : null}
        {mode === "promote" && canPromote ? (
          <p className="text-sm text-muted-foreground">{t("promote.effect")}</p>
        ) : null}
        {promote.error && !completenessOf(promote.error) ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(storageErrorKey(promote.error))}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={promote.isPending}>
          {tc("actions.close")}
        </Button>
        {mode === "completeness" ? (
          <Button variant="outline" onClick={() => check.mutate()} loading={check.isPending}>
            {t("completeness.again")}
          </Button>
        ) : (
          <Button onClick={confirm} loading={promote.isPending} disabled={!canPromote}>
            {promote.isPending ? null : <ArrowUpToLine />}
            {t("promote.confirm")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function CompletenessReport({ completeness }: { completeness: CopyCompleteness }) {
  const { t, i18n } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const rows: [string, CompletenessCount][] = [
    ["packs", completeness.packs],
    ["manifests", completeness.manifests],
    ["keys", completeness.keys],
  ];

  return (
    <div className="space-y-3">
      {completeness.complete ? (
        <Alert variant="info">
          <CircleCheck />
          <AlertTitle>{t("completeness.complete.title")}</AlertTitle>
          <AlertDescription>{t("completeness.complete.description")}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>{t("completeness.incomplete.title")}</AlertTitle>
          <AlertDescription>
            {t("completeness.incomplete.description", {
              bytes: formatBytes(completeness.packs.bytesMissing, language),
            })}
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([name, count]) => (
          <React.Fragment key={name}>
            <dt className="text-muted-foreground">{t(`completeness.${name}`)}</dt>
            <dd className="text-right tabular-nums">
              {t("completeness.count", {
                present: formatInteger(count.present, language),
                expected: formatInteger(count.expected, language),
              })}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("completeness.listingOnly")}</p>
    </div>
  );
}
