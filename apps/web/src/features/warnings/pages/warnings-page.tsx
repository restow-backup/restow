import { Link } from "@tanstack/react-router";
import { CheckCheck, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  DisabledReason,
  EmptyState,
  ErrorState,
  PageHeader,
  PageTabs,
  StatusBadge,
} from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCauseTitle } from "@/features/failures";
import { HISTORY_PATH } from "@/features/jobs/paths";
import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";

import "../i18n";
import type { WarningRef, WarningSummary } from "../api";
import { AcknowledgeDialog } from "../components/acknowledge-dialog";
import { WarningSheet } from "../components/warning-sheet";
import { useWarnings, useWarningsScope } from "../hooks";
import { WARNINGS_PATH } from "../paths";
import { acknowledgeableRefs, refKey, stateTone } from "../presenters";

/**
 * The warnings of the tenant: every protected object and machine whose newest backup went
 * through but left items behind. Open ones first; each row opens the reasons (failed items by
 * cause, what to do, the raw messages) and can be acknowledged, alone or with others. The
 * acknowledged ones have their own tab with who, when and the note, and can be revoked there.
 */
export function WarningsPage({ state }: { state: "open" | "acknowledged" }) {
  const { t, i18n } = useTranslation("warnings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { canAcknowledge } = useWarningsScope();
  const query = useWarnings(state);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = React.useState<{ ref: WarningRef; name: string } | null>(null);
  const [acknowledging, setAcknowledging] = React.useState<readonly WarningRef[] | null>(null);

  const items = query.data?.items ?? [];
  const selectable = state === "open" && canAcknowledge;
  const refs = acknowledgeableRefs(items, selected);
  const allSelected = items.length > 0 && items.every((item) => selected.has(refKey(item.target)));

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const bulkReason = !canAcknowledge
    ? t("reasons.notAllowed")
    : refs.length === 0
      ? t("reasons.nothingSelected")
      : null;

  return (
    <div className="space-y-6" data-slot="warnings-page">
      <PageTabs
        label={t("title")}
        current={state}
        tabs={[
          { id: "open", label: t("tabs.open"), to: WARNINGS_PATH, search: {} },
          {
            id: "acknowledged",
            label: t("tabs.acknowledged"),
            to: WARNINGS_PATH,
            search: { state: "acknowledged" },
          },
        ]}
      />
      <PageHeader
        icon={TriangleAlert}
        title={t("title")}
        description={t("description")}
        actions={
          state === "open" ? (
            <DisabledReason reason={bulkReason}>
              <Button disabled={bulkReason !== null} onClick={() => setAcknowledging(refs)}>
                <CheckCheck aria-hidden="true" />
                {t("actions.acknowledgeSelected", { count: refs.length })}
              </Button>
            </DisabledReason>
          ) : null
        }
      />
      {query.data && query.data.counts.failed > 0 ? (
        <Alert variant="destructive" data-slot="failed-hint">
          <TriangleAlert />
          <AlertDescription>
            <p>{t("failedHint", { count: query.data.counts.failed })}</p>
            <Link
              to={HISTORY_PATH as never}
              className="text-sm font-medium underline underline-offset-4"
            >
              {t("openHistory")}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      {query.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : query.error ? (
        <ErrorState
          title={t("loadError")}
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CheckCheck}
          title={t(`empty.${state}.title`)}
          description={t(`empty.${state}.description`)}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={t("columns.selectAll")}
                    checked={allSelected}
                    onCheckedChange={(checked) =>
                      setSelected(
                        checked === true
                          ? new Set(items.map((item) => refKey(item.target)))
                          : new Set(),
                      )
                    }
                  />
                </TableHead>
              ) : null}
              <TableHead>{t("columns.object")}</TableHead>
              <TableHead>{t("columns.lastRun")}</TableHead>
              <TableHead>{t("columns.causes")}</TableHead>
              <TableHead>{t("columns.acknowledgement")}</TableHead>
              <TableHead className="text-right">{t("columns.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <WarningRow
                key={refKey(item.target)}
                item={item}
                language={language}
                selectable={selectable}
                selected={selected.has(refKey(item.target))}
                onSelect={(on) => toggle(refKey(item.target), on)}
                onOpen={() =>
                  setOpened({
                    ref: { kind: item.target.kind, id: item.target.id },
                    name: item.target.name,
                  })
                }
              />
            ))}
          </TableBody>
        </Table>
      )}
      {query.data?.truncated ? (
        <p className="text-xs text-muted-foreground">{t("truncated", { count: items.length })}</p>
      ) : null}
      <WarningSheet
        target={opened?.ref ?? null}
        name={opened?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setOpened(null);
        }}
      />
      <AcknowledgeDialog
        targets={acknowledging ?? []}
        open={acknowledging !== null}
        onOpenChange={(open) => {
          if (!open) setAcknowledging(null);
        }}
        onDone={() => setSelected(new Set())}
      />
    </div>
  );
}

function WarningRow({
  item,
  language,
  selectable,
  selected,
  onSelect,
  onOpen,
}: {
  item: WarningSummary;
  language: string;
  selectable: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation("warnings");
  const title = useCauseTitle();
  const ack = item.acknowledgement;
  return (
    <TableRow data-state={item.state} data-selected={selected || undefined}>
      {selectable ? (
        <TableCell>
          <Checkbox
            aria-label={t("columns.select")}
            checked={selected}
            onCheckedChange={(checked) => onSelect(checked === true)}
          />
        </TableCell>
      ) : null}
      <TableCell className="min-w-0">
        <div className="font-medium break-words">{item.target.name}</div>
        <div className="text-xs text-muted-foreground">
          {t(`kind.${item.target.subjectKind}`)}
          {item.target.detail && item.target.detail !== item.target.name
            ? ` · ${item.target.detail}`
            : ""}
        </div>
      </TableCell>
      <TableCell>
        <div className="space-y-1">
          <StatusBadge tone={stateTone(item.state)} icon>
            {t(`state.${item.state}`)}
          </StatusBadge>
          {item.latestRun ? (
            <div
              className="text-xs text-muted-foreground"
              title={formatDateTime(item.latestRun.finishedAt, language) ?? undefined}
            >
              {formatRelative(item.latestRun.finishedAt, language)} ·{" "}
              {t("failedItems", { count: item.latestRun.failedItems })}
            </div>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="max-w-80">
        <ul className="space-y-0.5 text-xs">
          {item.causes.slice(0, 3).map((cause) => (
            <li key={cause.code} data-cause={cause.code} className="break-words">
              {formatInteger(cause.count, language)} × {title(cause.code)}
            </li>
          ))}
        </ul>
        {item.newCauses.length > 0 && ack ? (
          <p className="mt-1 text-xs font-medium text-warning-foreground dark:text-warning">
            {t("newCauses", { causes: item.newCauses.map((code) => title(code)).join(", ") })}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="max-w-72 text-xs">
        {ack ? (
          <div className="space-y-0.5">
            <p>
              {t("ackBy", {
                who: ack.acknowledgedBy,
                when: formatRelative(ack.acknowledgedAt, language) ?? "",
              })}
            </p>
            {ack.note ? <p className="text-muted-foreground break-words">{ack.note}</p> : null}
            {ack.superseded ? (
              <p className="text-warning-foreground dark:text-warning">
                {t("superseded", { when: formatDateTime(ack.acknowledgedAt, language) ?? "" })}
              </p>
            ) : null}
          </div>
        ) : (
          <span className="text-muted-foreground">–</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" variant="outline" onClick={onOpen}>
          {t("actions.details")}
        </Button>
      </TableCell>
    </TableRow>
  );
}
