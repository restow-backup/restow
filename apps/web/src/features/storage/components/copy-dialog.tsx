import { ArrowUpToLine, CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
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
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { formatBytes, formatInteger } from "@/lib/format";
import { storageErrorKey } from "../presenters";
import type {
  CompletenessCount,
  CopyCompleteness,
  PromotionBlocker,
  PromotionReadiness,
  PromotionRepository,
  StorageTargetDto,
} from "../types";
import {
  useCompleteness,
  usePromoteTarget,
  usePromotionReadiness,
  useStartCatchUp,
} from "../use-storage";

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
 * "Check copy" compares the listings of the copy and the primary (packs, manifests, keys,
 * archive records) as soon as the dialog opens. "Make primary" asks the server whether the copy
 * can become the primary (docs/STORAGE.md, "Promoting a copy"): every reason it cannot yet is
 * shown before the click, each with what to do, and "Catch up now" copies what is missing while
 * the dialog follows the progress. The promotion itself stays a click of its own.
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
        {mode === "promote" ? (
          <PromotionCheck
            target={target}
            fromInstallationDefault={fromInstallationDefault}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("completeness.title", { name: target.name })}</DialogTitle>
              <DialogDescription>{t("completeness.description")}</DialogDescription>
            </DialogHeader>
            <CopyCheck target={target} onDone={() => onOpenChange(false)} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CopyCheck({ target, onDone }: { target: StorageTargetDto; onDone: () => void }) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const check = useCompleteness(target.id);
  const { mutate: runCheck } = check;
  const started = React.useRef(false);

  // Check once when the dialog opens (the ref keeps a strict-mode double effect from checking twice).
  React.useEffect(() => {
    if (!started.current) {
      started.current = true;
      runCheck();
    }
  }, [runCheck]);

  return (
    <>
      <div className="space-y-4">
        {check.isPending ? (
          <Checking label={t("completeness.checking")} />
        ) : check.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(storageErrorKey(check.error))}</AlertDescription>
          </Alert>
        ) : check.data ? (
          <CompletenessReport completeness={check.data.completeness} />
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          {tc("actions.close")}
        </Button>
        <Button variant="outline" onClick={() => check.mutate()} loading={check.isPending}>
          {t("completeness.again")}
        </Button>
      </DialogFooter>
    </>
  );
}

function Checking({ label }: { label: string }) {
  return (
    <div className="space-y-2" aria-busy="true">
      <p className="text-sm text-muted-foreground">{label}</p>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-3/5" />
    </div>
  );
}

/** What the server says about promoting this copy, the catch-up, and the promotion itself. */
function PromotionCheck({
  target,
  fromInstallationDefault,
  onDone,
}: {
  target: StorageTargetDto;
  fromInstallationDefault: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const { query, followCatchUp } = usePromotionReadiness(target.id);
  const catchUp = useStartCatchUp(target.id);
  const promote = usePromoteTarget(target.id);
  const readiness = query.data;

  const startCatchUp = () => {
    catchUp.mutate(undefined, {
      onSuccess: () => {
        followCatchUp();
        toast.success(t("toasts.catchUpStarted", { name: target.name }));
      },
    });
  };
  const confirm = () => {
    promote.mutate(undefined, {
      onSuccess: (result) => {
        toast.success(t("toasts.promoted", { name: target.name }));
        if ((result.primaryUnreadable ?? []).length > 0) {
          toast.warning(
            t("toasts.promotedPrimaryUnreadable", { count: result.primaryUnreadable.length }),
          );
        }
        onDone();
      },
      // The server knows better now (a run started, a copy fell behind): ask it again.
      onError: () => void query.refetch(),
    });
  };
  const description =
    readiness?.currentPrimaryBecomes === "previous"
      ? "promote.descriptionWithRepositories"
      : fromInstallationDefault
        ? "promote.descriptionFromDefault"
        : "promote.description";
  const running = readiness?.catchUp.running === true;
  const offerCatchUp = readiness !== undefined && !readiness.ready && readiness.canCatchUp;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("promote.title", { name: target.name })}</DialogTitle>
        <DialogDescription>{t(description)}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4" data-slot="promotion-check">
        {query.isPending ? (
          <Checking label={t("promote.checking")} />
        ) : query.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(storageErrorKey(query.error))}</AlertDescription>
          </Alert>
        ) : readiness ? (
          <>
            {readiness.blockers.length > 0 ? <Blockers blockers={readiness.blockers} /> : null}
            {readiness.repositories.total > 0 ? <RepositoryCopies readiness={readiness} /> : null}
            {readiness.completeness ? (
              <CompletenessReport completeness={readiness.completeness} />
            ) : null}
            {running ? (
              <CatchUpProgress readiness={readiness} />
            ) : offerCatchUp ? (
              <p className="text-sm text-muted-foreground">{t("promote.catchUp.description")}</p>
            ) : null}
            {readiness.ready ? (
              <Alert variant="info" data-ready="true">
                <CircleCheck />
                <AlertDescription>{t("promote.ready")}</AlertDescription>
              </Alert>
            ) : null}
          </>
        ) : null}
        {catchUp.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(storageErrorKey(catchUp.error))}</AlertDescription>
          </Alert>
        ) : null}
        {promote.error ? (
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
        {offerCatchUp || running ? (
          <Button
            variant="outline"
            onClick={startCatchUp}
            loading={catchUp.isPending}
            disabled={running || promote.isPending}
            data-action="catch-up"
          >
            {catchUp.isPending ? null : <RefreshCw />}
            {running ? t("promote.catchUp.running") : t("promote.catchUp.action")}
          </Button>
        ) : null}
        <Button
          onClick={confirm}
          loading={promote.isPending}
          disabled={readiness?.ready !== true || running}
          data-action="promote"
        >
          {promote.isPending ? null : <ArrowUpToLine />}
          {t("promote.confirm")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Every reason the copy cannot become the primary yet, each with what to do. */
function Blockers({ blockers }: { blockers: readonly PromotionBlocker[] }) {
  const { t } = useTranslation("storage");
  return (
    <div className="space-y-2" data-slot="promotion-blockers">
      <p className="text-sm font-medium">{t("promote.blockersTitle")}</p>
      {blockers.map((blocker) => (
        <Alert key={blocker.code} variant="warning" data-blocker={blocker.code}>
          <TriangleAlert />
          <AlertTitle>
            {t(`promote.blockers.${blocker.code}.title`, { count: blocker.repositories ?? 0 })}
          </AlertTitle>
          <AlertDescription>
            {t(`promote.blockers.${blocker.code}.remedy`, {
              queues: (blocker.queues ?? [])
                .map((queue) => t(`promote.queues.${queue}`))
                .join(", "),
            })}
          </AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

/** The restic repositories on the copy: how many are current, and what each other one lacks. */
function RepositoryCopies({ readiness }: { readiness: PromotionReadiness }) {
  const { t, i18n } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { total, current, items, itemsOmitted } = readiness.repositories;
  return (
    <div className="space-y-2" data-slot="promotion-repositories">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="text-muted-foreground">{t("promote.repositories.title")}</span>
        <span className="tabular-nums">
          {t("promote.repositories.summary", {
            current: formatInteger(current, language),
            total: formatInteger(total, language),
          })}
        </span>
      </div>
      <Progress value={total > 0 ? (current / total) * 100 : 0} />
      {items.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {items.map((item) => (
            <RepositoryLine key={item.prefix} item={item} />
          ))}
          {itemsOmitted > 0 ? (
            <li className="text-muted-foreground">
              {t("promote.repositories.omitted", { count: itemsOmitted })}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function RepositoryLine({ item }: { item: PromotionRepository }) {
  const { t } = useTranslation("storage");
  return (
    <li className="flex flex-wrap justify-between gap-x-4" data-slot="promotion-repository">
      <span>
        {t(`promote.repositories.kind.${item.kind}`)} {item.name ?? item.ownerId}
      </span>
      <span className="text-muted-foreground" title={item.lastError ?? undefined}>
        {t(`promote.repositories.readiness.${item.readiness}`, { count: item.missingSnapshots })}
      </span>
    </li>
  );
}

/** What the catch-up is doing: the storage check, and the repositories still waiting. */
function CatchUpProgress({ readiness }: { readiness: PromotionReadiness }) {
  const { t } = useTranslation("storage");
  const { scrub, waiting } = readiness.catchUp;
  return (
    <div className="space-y-1 text-sm" aria-live="polite" data-slot="catch-up-progress">
      {scrub ? <p>{t(`promote.catchUp.scrub.${scrub.status}`)}</p> : null}
      {waiting > 0 ? <p>{t("promote.catchUp.waiting", { count: waiting })}</p> : null}
    </div>
  );
}

function CompletenessReport({ completeness }: { completeness: CopyCompleteness }) {
  const { t, i18n } = useTranslation("storage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const rows: [string, CompletenessCount][] = [
    ["packs", completeness.packs],
    ["manifests", completeness.manifests],
    ["keys", completeness.keys],
    ["archive", completeness.archive],
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
            {completeness.packs.bytesMissing > 0
              ? t("completeness.incomplete.description", {
                  bytes: formatBytes(completeness.packs.bytesMissing, language),
                })
              : t("completeness.incomplete.objects")}
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
