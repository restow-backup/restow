import { ChevronRight, Download, RefreshCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { downloadFile } from "@/features/stats/download";
import { errorMessageKey } from "@/lib/api";

import { useDeliveries } from "../hooks";
import {
  DELIVERY_FILTERS,
  type DeliveryFilter,
  deliveryErrorKey,
  deliveryStatusOf,
} from "../presenters";
import type { Delivery } from "../types";
import { useIntegrationsFormat } from "../use-format";
import { DeliverySheet } from "./delivery-sheet";
import { DeliveryStatusBadge, EventLabel } from "./webhook-status";

interface DeliveriesCardProps {
  webhookId: string;
  webhookActive: boolean;
}

/** The delivery log of one webhook: newest first, filterable, refreshing while retries run. */
export function DeliveriesCard({ webhookId, webhookActive }: DeliveriesCardProps) {
  const { t } = useTranslation("integrations");
  const { t: tc } = useTranslation();
  const [filter, setFilter] = React.useState<DeliveryFilter>("all");
  const [selected, setSelected] = React.useState<string | null>(null);
  const query = useDeliveries(webhookId, deliveryStatusOf(filter));
  const [exporting, setExporting] = React.useState(false);

  async function exportCsv() {
    setExporting(true);
    const toastId = toast.loading(t("deliveries.export.preparing"));
    try {
      const status = deliveryStatusOf(filter);
      const filename = await downloadFile({
        path: `/webhooks/${encodeURIComponent(webhookId)}/deliveries/export${status ? `?status=${status}` : ""}`,
        accept: "text/csv",
        fallbackName: "webhook-deliveries.csv",
      });
      toast.success(t("deliveries.export.done"), { id: toastId, description: filename });
    } catch (error) {
      toast.error(t("deliveries.export.failed"), {
        id: toastId,
        description: tc(errorMessageKey(error)),
      });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t("deliveries.title")}</CardTitle>
          <CardDescription>{t("deliveries.description")}</CardDescription>
        </div>
        <div className="flex shrink-0 items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="delivery-filter" className="text-xs text-muted-foreground">
              {t("deliveries.filter.label")}
            </Label>
            <Select value={filter} onValueChange={(value) => setFilter(value as DeliveryFilter)}>
              <SelectTrigger id="delivery-filter" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIVERY_FILTERS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`deliveries.filter.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            loading={exporting}
            onClick={() => void exportCsv()}
            data-slot="deliveries-export"
          >
            <Download aria-hidden="true" />
            {t("deliveries.export.action")}
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label={tc("actions.refresh")}
            title={tc("actions.refresh")}
          >
            <RefreshCw
              className={query.isFetching ? "animate-spin" : undefined}
              aria-hidden="true"
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.error ? (
          <ErrorState
            title={t("deliveries.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : query.items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-sm text-muted-foreground">
            {filter === "all" ? t("deliveries.empty") : t("deliveries.emptyFiltered")}
          </p>
        ) : (
          <Table className="min-w-[48rem]" scrollLabel={t("deliveries.title")}>
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST}>{t("deliveries.columns.event")}</TableHead>
                <TableHead>{t("deliveries.columns.status")}</TableHead>
                <TableHead>{t("deliveries.columns.attempts")}</TableHead>
                <TableHead>{t("deliveries.columns.created")}</TableHead>
                <TableHead>{t("deliveries.columns.result")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("deliveries.detailTitle")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.items.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  delivery={delivery}
                  onOpen={() => setSelected(delivery.id)}
                />
              ))}
            </TableBody>
          </Table>
        )}

        {query.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => void query.fetchNextPage()}
              loading={query.isFetchingNextPage}
            >
              {t("deliveries.loadMore")}
            </Button>
          </div>
        ) : null}
      </CardContent>

      <DeliverySheet
        webhookId={webhookId}
        deliveryId={selected}
        webhookActive={webhookActive}
        onClose={() => setSelected(null)}
      />
    </Card>
  );
}

function DeliveryRow({ delivery, onOpen }: { delivery: Delivery; onOpen: () => void }) {
  const { t, relative, dateTime } = useIntegrationsFormat();
  return (
    <TableRow className="cursor-pointer" onClick={onOpen}>
      <TableCell pin={PIN_FIRST}>
        <div className="font-medium">
          <EventLabel event={delivery.event} />
        </div>
        <code className="text-xs text-muted-foreground">{delivery.event}</code>
      </TableCell>
      <TableCell>
        <DeliveryStatusBadge status={delivery.status} />
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm tabular-nums">
        {t("deliveries.attempts", { attempts: delivery.attempts, max: delivery.maxAttempts })}
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">
        <span title={dateTime(delivery.createdAt) ?? undefined}>
          {relative(delivery.createdAt)}
        </span>
      </TableCell>
      <TableCell className="max-w-sm text-sm">
        <DeliveryResult delivery={delivery} />
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          aria-label={t("deliveries.open", { time: dateTime(delivery.createdAt) ?? "" })}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** One line on the outcome: when it arrived, when the next try is, or why it failed. */
function DeliveryResult({ delivery }: { delivery: Delivery }) {
  const { t, relative } = useIntegrationsFormat();
  if (delivery.status === "delivered") {
    return (
      <span className="text-muted-foreground">
        {t("deliveries.deliveredAt", { time: relative(delivery.deliveredAt) ?? "" })}
      </span>
    );
  }
  const error = delivery.lastError;
  const message = error ? t(deliveryErrorKey(error), { status: error.httpStatus ?? "" }) : null;
  if (delivery.status === "pending") {
    return (
      <span className="space-y-0.5">
        <span className="block text-muted-foreground">
          {delivery.attempts === 0
            ? t("deliveries.waiting")
            : t("deliveries.nextAttempt", { time: relative(delivery.nextAttemptAt) ?? "" })}
        </span>
        {message ? (
          <span className="block truncate text-xs text-muted-foreground">{message}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="line-clamp-2 text-destructive">
      {message ?? t("deliveries.status.failed")}
    </span>
  );
}
