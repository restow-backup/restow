import { Check, Copy, Info } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { copyToClipboard } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatInteger } from "@/lib/format";
import {
  type ItemFilter,
  countByFilter,
  initialFilter,
  isLive,
  itemCodeKey,
  itemsAsText,
  matchesFilter,
  orderItems,
} from "../presenters";
import type { ImportDetail, ImportReportItem } from "../types";

const FILTERS: readonly ItemFilter[] = ["failed", "skipped", "all"];

/**
 * The items that did not become messages: failed ones first, then skipped
 * ones, each with a plain-language reason for its code and the reader's own
 * English text as detail. While the import still runs, only the failures the
 * worker reports live are shown.
 */
export function ItemsCard({ detail }: { detail: ImportDetail }) {
  const { t } = useTranslation("imports");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("items.title")}</CardTitle>
        <CardDescription>{t("items.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {detail.report ? (
          <ReportItems
            items={detail.report.items}
            omitted={detail.report.itemsOmitted}
            reportedFailed={detail.report.totals.failed}
          />
        ) : detail.failures.length > 0 ? (
          <LiveFailures detail={detail} />
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="size-4 shrink-0" aria-hidden="true" />
            {t(isLive(detail) ? "items.pending" : "items.none")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ReportItems({
  items,
  omitted,
  reportedFailed,
}: {
  items: readonly ImportReportItem[];
  omitted: number;
  reportedFailed: number;
}) {
  const { t, i18n } = useTranslation("imports");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const ordered = React.useMemo(() => orderItems(items), [items]);
  const counts = countByFilter(ordered);
  const [filter, setFilter] = React.useState<ItemFilter>(() => initialFilter(ordered));
  const visible = ordered.filter((item) => matchesFilter(item, filter));
  const filters = FILTERS.filter((candidate) => candidate === "all" || counts[candidate] > 0);

  if (ordered.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Check className="size-4 shrink-0" aria-hidden="true" />
        {reportedFailed > 0 ? t("items.noneListed") : t("items.noneNeeded")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={filter} onValueChange={(value) => setFilter(value as ItemFilter)}>
          <TabsList className="flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto">
            {filters.map((candidate) => (
              <TabsTrigger key={candidate} value={candidate}>
                {t(`items.filters.${candidate}`)}
                <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                  {formatInteger(counts[candidate], language)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <CopyListButton items={visible} />
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t("items.columns.item")}</TableHead>
            <TableHead className="hidden sm:table-cell">{t("items.columns.reason")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((item, index) => (
            <TableRow key={`${item.file}:${item.ref}:${index}`}>
              <TableCell className="align-top sm:w-2/5">
                <p className="font-mono text-xs font-medium break-words">{item.ref}</p>
                <p className="text-xs break-words text-muted-foreground">{item.file}</p>
                {/* On a narrow screen the reason sits under the item instead of in a squeezed column. */}
                <div className="mt-2 sm:hidden">
                  <ItemReason item={item} />
                </div>
              </TableCell>
              <TableCell className="hidden align-top sm:table-cell">
                <ItemReason item={item} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {omitted > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("items.omitted", { count: omitted, listed: formatInteger(items.length, language) })}
        </p>
      ) : null}
    </div>
  );
}

/** The outcome, what the code means in the user's language, and the reader's own English text. */
function ItemReason({ item }: { item: ImportReportItem }) {
  const { t } = useTranslation("imports");
  return (
    <>
      <p className="text-sm">
        <Badge
          variant={item.outcome === "failed" ? "destructive" : "secondary"}
          className="mr-2 align-middle"
        >
          {t(`items.outcome.${item.outcome}`)}
        </Badge>
        {t(itemCodeKey(item.code))}
      </p>
      {item.reason ? (
        <p className="mt-1 break-words text-xs text-muted-foreground" lang="en">
          {item.reason}
        </p>
      ) : null}
    </>
  );
}

function CopyListButton({ items }: { items: readonly ImportReportItem[] }) {
  const { t } = useTranslation("imports");
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (button: HTMLElement) => {
    try {
      await copyToClipboard(itemsAsText(items), button);
      setCopied(true);
    } catch {
      toast.error(t("items.copyFailed"));
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={items.length === 0}
      onClick={(event) => void copy(event.currentTarget)}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? t("items.copied") : t("items.copy")}
    </Button>
  );
}

/** While an import runs: the items it already could not read. */
function LiveFailures({ detail }: { detail: ImportDetail }) {
  const { t } = useTranslation("imports");
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("items.liveFailures")}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {detail.failures.map((failure) => (
          <li key={failure.itemRef} className="space-y-0.5 px-3 py-2 text-sm">
            <p className="truncate font-mono text-xs">{failure.itemRef}</p>
            <p className="break-words text-xs text-muted-foreground" lang="en">
              {failure.reason}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
