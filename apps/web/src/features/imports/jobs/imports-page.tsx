import { Link } from "@tanstack/react-router";
import { ChevronRight, FileInput, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { EmptyState } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProgressBar } from "@/features/restore/components/progress-bar";
import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";
import { ImportsForbidden, NoTenantSelected } from "../components/access-states";
import { ImportStatusBadge } from "../components/status-badge";
import { importDetailTo, importWizardTo } from "../paths";
import { isLive, progressRatio } from "../presenters";
import type { ImportSummary } from "../types";
import { useImportList } from "../use-imports";

/** Every import of the tenant, newest first, with live status while one runs. */
export function ImportsPage() {
  const { t } = useTranslation("imports");
  const { t: tCommon } = useTranslation();
  const { query, tenantId, canManage } = useImportList();

  const start = (
    <Link to={importWizardTo()} className={buttonVariants({ size: "sm" })}>
      <FileInput />
      {t("list.new")}
    </Link>
  );

  let body: React.ReactNode;
  if (!tenantId) {
    body = <NoTenantSelected />;
  } else if (!canManage) {
    body = <ImportsForbidden />;
  } else if (query.isPending) {
    body = (
      <div className="space-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        title={t("list.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  } else if (query.data.length === 0) {
    body = (
      <EmptyState
        icon={FileInput}
        title={t("list.empty.title")}
        description={t("list.empty.description")}
        actions={start}
      />
    );
  } else {
    body = (
      <Card className="py-0">
        <ImportsTable imports={query.data} />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("list.title")} description={t("list.subtitle")}>
        {tenantId && canManage ? (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
              {tCommon("actions.refresh")}
            </Button>
            {start}
          </>
        ) : null}
      </PageHeader>
      {body}
    </div>
  );
}

function ImportsTable({ imports }: { imports: readonly ImportSummary[] }) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number | null) => (value === null ? "–" : formatInteger(value, language));

  return (
    <Table scrollLabel={t("title")}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead pin={PIN_FIRST}>{t("list.columns.created")}</TableHead>
          <TableHead>{t("list.columns.name")}</TableHead>
          <TableHead>{t("list.columns.status")}</TableHead>
          <TableHead className="hidden text-right md:table-cell">
            {t("list.columns.files")}
          </TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            {t("list.columns.messages")}
          </TableHead>
          <TableHead className="hidden text-right sm:table-cell">
            {t("list.columns.failed")}
          </TableHead>
          <TableHead className="w-8">
            <span className="sr-only">{t("list.columns.open")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {imports.map((entry) => (
          <ImportRow key={entry.id} entry={entry} language={language} number={number} />
        ))}
      </TableBody>
    </Table>
  );
}

function ImportRow({
  entry,
  language,
  number,
}: {
  entry: ImportSummary;
  language: string;
  number: (value: number | null) => string;
}) {
  const { t } = useTranslation("imports");
  const live = isLive(entry);
  const failed = entry.live?.failed ?? entry.failed;
  return (
    <TableRow>
      <TableCell pin={PIN_FIRST} className="whitespace-nowrap">
        <Link
          to={importDetailTo(entry.id)}
          className="font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={formatDateTime(entry.createdAt, language) ?? undefined}
        >
          {formatRelative(entry.createdAt, language)}
        </Link>
      </TableCell>
      <TableCell className="max-w-0 min-w-32 w-1/3">
        <p className="truncate font-medium" title={entry.name}>
          {entry.name}
        </p>
        {entry.archive ? (
          <p className="text-xs text-muted-foreground">{t("list.archive")}</p>
        ) : null}
      </TableCell>
      <TableCell className="min-w-36">
        <div className="space-y-1.5">
          <ImportStatusBadge job={entry} />
          {live ? (
            <ProgressBar
              ratio={entry.status === "queued" ? 0 : progressRatio(null)}
              label={t("job.progress.label")}
            />
          ) : null}
        </div>
      </TableCell>
      <TableCell className="hidden text-right tabular-nums md:table-cell">
        {number(entry.fileCount)}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">
        {number(entry.live?.messages ?? entry.messages)}
      </TableCell>
      <TableCell
        className={
          (failed ?? 0) > 0
            ? "hidden text-right font-medium tabular-nums text-destructive sm:table-cell"
            : "hidden text-right tabular-nums sm:table-cell"
        }
      >
        {number(failed)}
      </TableCell>
      <TableCell className="w-8">
        <Link
          to={importDetailTo(entry.id)}
          aria-label={t("list.open", { name: entry.name })}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      </TableCell>
    </TableRow>
  );
}
