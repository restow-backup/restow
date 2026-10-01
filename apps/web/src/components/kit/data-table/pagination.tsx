import type { Table } from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatInteger } from "@/lib/format";

import { UI_NAMESPACE } from "../i18n.js";
import { pageRange } from "./state.js";

export const DEFAULT_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];

/** Range, page size and page buttons under a paginated table. */
export function DataTablePagination<TData>({
  table,
  pageSizes = DEFAULT_PAGE_SIZES,
}: {
  table: Table<TData>;
  pageSizes?: readonly number[];
}) {
  const { t, i18n } = useTranslation(UI_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { pageIndex, pageSize } = table.getState().pagination;
  const total = table.getRowCount();
  const pages = Math.max(1, table.getPageCount());
  const { from, to } = pageRange(pageIndex, pageSize, total);
  const sizes = pageSizes.includes(pageSize)
    ? pageSizes
    : [...pageSizes, pageSize].sort((a, b) => a - b);

  return (
    <nav
      aria-label={t("table.pagination.label")}
      className="flex flex-col-reverse gap-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-muted-foreground tabular-nums" aria-live="polite">
        {t("table.pagination.range", {
          from: formatInteger(from, language),
          to: formatInteger(to, language),
          total: formatInteger(total, language),
        })}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 sm:justify-end">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{t("table.pagination.pageSize")}</span>
          <Select
            value={String(pageSize)}
            onValueChange={(value) => table.setPageSize(Number(value))}
          >
            <SelectTrigger size="sm" className="w-20" aria-label={t("table.pagination.pageSize")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sizes.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {formatInteger(size, language)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-2 text-muted-foreground tabular-nums">
            {t("table.pagination.page", {
              page: formatInteger(pageIndex + 1, language),
              pages: formatInteger(pages, language),
            })}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            className="hidden sm:inline-flex"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.firstPage()}
            aria-label={t("table.pagination.first")}
          >
            <ChevronsLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
            aria-label={t("table.pagination.previous")}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
            aria-label={t("table.pagination.next")}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="hidden sm:inline-flex"
            disabled={!table.getCanNextPage()}
            onClick={() => table.lastPage()}
            aria-label={t("table.pagination.last")}
          >
            <ChevronsRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </nav>
  );
}

/** "50 entries shown" and a "Load more" button for cursor-paginated lists. */
export function DataTableLoadMore({
  count,
  hasMore,
  loadingMore = false,
  onLoadMore,
}: {
  count: number;
  hasMore: boolean;
  loadingMore?: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <div className="flex flex-col items-center gap-3 text-sm sm:flex-row sm:justify-between">
      <p className="text-muted-foreground" aria-live="polite">
        {hasMore ? t("table.loadMore.shown", { count }) : t("table.loadMore.all", { count })}
      </p>
      {hasMore ? (
        <Button variant="outline" size="sm" loading={loadingMore} onClick={onLoadMore}>
          {t("table.loadMore.action")}
        </Button>
      ) : null}
    </div>
  );
}
