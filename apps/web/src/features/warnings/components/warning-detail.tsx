import { Link } from "@tanstack/react-router";
import { ArrowRight, CheckCheck, Undo2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { DisabledReason, ErrorState, StatusBadge } from "@/components/kit";
import { ConfirmDialog } from "@/components/kit/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { CauseLine, FailureExplanation, useCauseTitle } from "@/features/failures";
import { jobDetailTo } from "@/features/jobs/paths";
import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";

import "../i18n";
import type { FailedItem, WarningDetail, WarningRef, WarningRun } from "../api";
import { useRevokeAcknowledgement, useWarning, useWarningsScope } from "../hooks";
import { acknowledgeBlock, itemFolder, itemTitle, outcomeTone, stateTone } from "../presenters";
import { AcknowledgeDialog } from "./acknowledge-dialog";

/**
 * Everything about the warning of one protected object or machine, in the order an operator
 * asks: what is the state, why (the causes with what happened, why and what to do, the raw
 * message in the technical details), which items exactly (folder, subject or file, date), what
 * the last runs did, and who acknowledged what. Acknowledging and revoking are here too.
 */
export function WarningDetailView({ target }: { target: WarningRef }) {
  const { t } = useTranslation("warnings");
  const query = useWarning(target);
  if (query.isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (query.error || !query.data) {
    return (
      <ErrorState
        title={t("detail.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <WarningDetailBody detail={query.data} />;
}

export function WarningDetailBody({ detail }: { detail: WarningDetail }) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const when = formatRelative(detail.latestRun?.finishedAt ?? null, language) ?? "";
  const count = detail.latestRun?.failedItems ?? 0;
  return (
    <div className="space-y-5" data-slot="warning-detail" data-state={detail.state}>
      <div className="space-y-2">
        <StatusBadge tone={stateTone(detail.state)} icon>
          {t(`state.${detail.state}`)}
        </StatusBadge>
        <p className="text-sm">{t(`explain.${detail.state}`, { when, count })}</p>
        {detail.newCauses.length > 0 && detail.acknowledgement ? (
          <NewCauses codes={detail.newCauses} />
        ) : null}
      </div>
      <AcknowledgementPanel detail={detail} />
      {detail.groups.length > 0 ? (
        <section className="space-y-3" data-section="causes">
          <h3 className="text-sm font-semibold">{t("detail.byCause")}</h3>
          {detail.groups.map((group) => (
            <div key={group.failure.code} className="space-y-1.5" data-cause={group.failure.code}>
              <p className="text-sm font-medium">{t("failedItems", { count: group.count })}</p>
              <FailureExplanation
                failure={group.failure}
                subject={{ kind: "none" }}
                hideWhat
                tone="warning"
                docsUrl={detail.docsUrl}
                affectedItems={group.count}
              />
            </div>
          ))}
        </section>
      ) : null}
      <ItemsSection detail={detail} />
      <RunsSection runs={detail.runs} focusRunId={detail.focusRunId} />
    </div>
  );
}

function NewCauses({ codes }: { codes: readonly string[] }) {
  const { t } = useTranslation("warnings");
  const title = useCauseTitle();
  return (
    <p className="text-sm font-medium text-warning-foreground dark:text-warning">
      {t("newCauses", { causes: codes.map((code) => title(code)).join(", ") })}
    </p>
  );
}

function AcknowledgementPanel({ detail }: { detail: WarningDetail }) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { canAcknowledge } = useWarningsScope();
  const title = useCauseTitle();
  const [open, setOpen] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const revoke = useRevokeAcknowledgement();
  const ack = detail.acknowledgement;
  const block = acknowledgeBlock(detail, canAcknowledge);
  const ref = { kind: detail.target.kind, id: detail.target.id };
  const acknowledgeLabel = ack ? t("actions.acknowledgeAgain") : t("actions.acknowledge");
  // Acknowledging again is only offered while the warning is open (a new cause, a failure since).
  const offerAcknowledge = detail.state !== "acknowledged";

  return (
    <section className="space-y-2" data-section="acknowledgement">
      {ack ? (
        <Alert variant={ack.superseded ? "warning" : "default"} data-superseded={ack.superseded}>
          <CheckCheck />
          <AlertTitle>
            {t("ackBy", {
              who: ack.acknowledgedBy,
              when: formatDateTime(ack.acknowledgedAt, language) ?? "",
            })}
          </AlertTitle>
          <AlertDescription className="space-y-1">
            {ack.superseded ? (
              <p>{t("superseded", { when: formatDateTime(ack.acknowledgedAt, language) ?? "" })}</p>
            ) : null}
            {ack.note ? (
              <p>
                <span className="font-medium">{t("detail.note")}:</span> {ack.note}
              </p>
            ) : null}
            {ack.causes.length > 0 ? (
              <p className="text-xs">
                {t("detail.covers", {
                  causes: ack.causes.map((code) => title(code)).join(", "),
                })}
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {offerAcknowledge ? (
          <DisabledReason reason={block ? t(`reasons.${block}`) : null}>
            <Button size="sm" disabled={block !== null} onClick={() => setOpen(true)}>
              <CheckCheck aria-hidden="true" />
              {acknowledgeLabel}
            </Button>
          </DisabledReason>
        ) : null}
        {ack ? (
          <DisabledReason reason={canAcknowledge ? null : t("reasons.notAllowed")}>
            <Button
              size="sm"
              variant="outline"
              disabled={!canAcknowledge}
              onClick={() => setRevoking(true)}
            >
              <Undo2 aria-hidden="true" />
              {t("actions.revoke")}
            </Button>
          </DisabledReason>
        ) : null}
      </div>
      <AcknowledgeDialog targets={[ref]} open={open} onOpenChange={setOpen} />
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title={t("revokeDialog.title")}
        description={t("revokeDialog.description", { name: detail.target.name })}
        confirmLabel={t("revokeDialog.confirm")}
        pending={revoke.isPending}
        onConfirm={() =>
          revoke.mutate(ref, {
            onSuccess: () => {
              toast.success(t("toast.revoked"));
              setRevoking(false);
            },
            onError: () => toast.error(t("toast.failed")),
          })
        }
      />
    </section>
  );
}

function ItemsSection({ detail }: { detail: WarningDetail }) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  if (!detail.focusRunId || (detail.items.length === 0 && detail.itemCount === 0)) {
    return null;
  }
  return (
    <section className="space-y-2" data-section="items">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("detail.items")}</h3>
        <Link
          to={jobDetailTo(detail.focusRunId)}
          className="inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
        >
          {t("actions.openRun")}
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </div>
      {detail.itemCount > detail.items.length && detail.items.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("detail.itemsCapped", {
            shown: formatInteger(detail.items.length, language),
            total: formatInteger(detail.itemCount, language),
          })}
        </p>
      ) : null}
      {detail.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("detail.noItems")}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {detail.items.map((item, index) => (
            <ItemRow key={`${index}-${item.ref}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemRow({ item }: { item: FailedItem }) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const folder = itemFolder(item.location);
  return (
    <li className="space-y-1 p-2.5" data-item={item.ref}>
      <p className="font-medium break-words">{itemTitle(item.location, item.ref)}</p>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          {t("detail.columns.folder")}: {folder ?? t("detail.noFolder")}
        </span>
        {item.location.itemId ? (
          <span className="font-mono">{t("detail.itemId", { id: item.location.itemId })}</span>
        ) : null}
        {item.itemDate ? (
          <span title={formatDateTime(item.itemDate, language) ?? undefined}>
            {t("detail.receivedAt", { when: formatDateTime(item.itemDate, language) ?? "" })}
          </span>
        ) : null}
        {item.failedAt ? (
          <span title={formatDateTime(item.failedAt, language) ?? undefined}>
            {t("detail.failedAt", { when: formatRelative(item.failedAt, language) ?? "" })}
          </span>
        ) : null}
        {item.attempts > 1 ? <span>{t("detail.attempts", { count: item.attempts })}</span> : null}
      </p>
      {item.failure ? <CauseLine failure={item.failure} className="block text-foreground" /> : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">{t("detail.rawMessage")}</summary>
        <p className="mt-1 font-mono break-all whitespace-pre-wrap">{item.message}</p>
        {item.ref !== item.location.name ? (
          <p className="mt-1 font-mono break-all text-muted-foreground">{item.ref}</p>
        ) : null}
      </details>
    </li>
  );
}

function RunsSection({ runs, focusRunId }: { runs: WarningRun[]; focusRunId: string | null }) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <section className="space-y-2" data-section="runs">
      <h3 className="text-sm font-semibold">{t("detail.runs")}</h3>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("detail.noRuns")}</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {runs.map((run) => (
            <li
              key={run.id}
              className="space-y-1.5 p-2.5"
              data-run={run.id}
              data-focus={run.id === focusRunId || undefined}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={outcomeTone(run.outcome)}>
                    {t(`outcome.${run.outcome}`)}
                  </StatusBadge>
                  <span
                    className="text-muted-foreground"
                    title={formatDateTime(run.finishedAt ?? run.startedAt, language) ?? undefined}
                  >
                    {formatRelative(run.finishedAt ?? run.startedAt, language) ?? "–"}
                  </span>
                  {run.failedItems > 0 ? (
                    <span className="text-xs text-warning-foreground dark:text-warning">
                      {t("failedItems", { count: run.failedItems })}
                    </span>
                  ) : null}
                </span>
                <Link
                  to={jobDetailTo(run.id)}
                  className="inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
                >
                  {t("actions.openRun")}
                  <ArrowRight className="size-3" aria-hidden="true" />
                </Link>
              </div>
              {run.failure ? (
                <FailureExplanation
                  failure={run.failure}
                  subject={{ kind: "none" }}
                  hideWhat
                  className="[&_*]:break-words"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
