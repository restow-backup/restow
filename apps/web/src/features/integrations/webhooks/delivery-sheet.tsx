import { AlertTriangle, RotateCcw } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";

import { useDelivery, useRedeliver } from "../hooks";
import { deliveryErrorKey, eventKey, integrationErrorKey, prettyJson } from "../presenters";
import type { DeliveryDetail } from "../types";
import { useIntegrationsFormat } from "../use-format";
import { DeliveryStatusBadge, EventLabel } from "./webhook-status";

interface DeliverySheetProps {
  webhookId: string;
  deliveryId: string | null;
  /** Redelivery needs an active webhook. */
  webhookActive: boolean;
  onClose: () => void;
}

/** One delivery in full: attempts, the last error with its evidence, the signed payload. */
export function DeliverySheet({
  webhookId,
  deliveryId,
  webhookActive,
  onClose,
}: DeliverySheetProps) {
  const { t } = useTranslation("integrations");
  const query = useDelivery(webhookId, deliveryId);
  return (
    <Sheet open={deliveryId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="w-full max-w-none gap-0 overflow-y-auto p-6 sm:max-w-xl"
      >
        {query.data ? (
          <DeliveryDetails
            delivery={query.data}
            webhookActive={webhookActive}
            onRedelivered={onClose}
          />
        ) : (
          <>
            <SheetHeader className="p-0">
              <SheetTitle className="text-lg">{t("deliveries.detailTitle")}</SheetTitle>
              <SheetDescription className="sr-only">{t("deliveries.description")}</SheetDescription>
            </SheetHeader>
            <div className="mt-6 space-y-3">
              {query.error ? (
                <ErrorState
                  error={query.error}
                  onRetry={() => void query.refetch()}
                  retrying={query.isFetching}
                />
              ) : (
                <>
                  <Skeleton className="h-6 w-1/2" />
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-48 w-full" />
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DeliveryDetails({
  delivery,
  webhookActive,
  onRedelivered,
}: {
  delivery: DeliveryDetail;
  webhookActive: boolean;
  onRedelivered: () => void;
}) {
  const { t, relative, dateTime } = useIntegrationsFormat();
  const redeliver = useRedeliver();
  const error = delivery.lastError;

  const sendAgain = () => {
    redeliver.mutate(
      { id: delivery.webhookId, deliveryId: delivery.id },
      {
        onSuccess: () => {
          toast.success(t("toasts.redelivered"));
          onRedelivered();
        },
        onError: (problem) => toast.error(t(integrationErrorKey(problem))),
      },
    );
  };

  return (
    <div className="space-y-6">
      <SheetHeader className="p-0">
        <SheetTitle className="flex flex-wrap items-center gap-2 pr-8 text-lg">
          {t("deliveries.detailTitle")}
          <DeliveryStatusBadge status={delivery.status} />
        </SheetTitle>
        <SheetDescription>
          {t("deliveries.detailDescription", {
            event: t(`events.${eventKey(delivery.event)}.label`),
            time: dateTime(delivery.createdAt) ?? "",
          })}
        </SheetDescription>
      </SheetHeader>

      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Fact label={t("deliveries.columns.event")}>
          <EventLabel event={delivery.event} />{" "}
          <code className="text-xs text-muted-foreground">{delivery.event}</code>
        </Fact>
        <Fact label={t("deliveries.columns.attempts")}>
          {t("deliveries.attempts", { attempts: delivery.attempts, max: delivery.maxAttempts })}
        </Fact>
        <Fact label={t("deliveries.columns.created")}>
          <span title={dateTime(delivery.createdAt) ?? undefined}>
            {relative(delivery.createdAt)}
          </span>
        </Fact>
        <Fact label={t("deliveries.columns.result")}>
          {delivery.status === "delivered" && delivery.deliveredAt
            ? t("deliveries.deliveredAt", { time: dateTime(delivery.deliveredAt) ?? "" })
            : delivery.status === "pending"
              ? delivery.attempts === 0
                ? t("deliveries.waiting")
                : t("deliveries.nextAttempt", { time: relative(delivery.nextAttemptAt) ?? "" })
              : t(`deliveries.status.${delivery.status}`)}
        </Fact>
        <Fact label={t("deliveries.deliveryId")} wide>
          <code className="break-all font-mono text-xs">{delivery.id}</code>
        </Fact>
        {delivery.eventId ? (
          <Fact label={t("deliveries.eventId")} wide>
            <code className="break-all font-mono text-xs">{delivery.eventId}</code>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {t("deliveries.eventIdHint")}
            </span>
          </Fact>
        ) : null}
      </dl>

      {error ? (
        <Alert variant={delivery.status === "failed" ? "destructive" : "warning"}>
          <AlertTriangle />
          <AlertTitle>{t("deliveries.lastError")}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t(deliveryErrorKey(error), { status: error.httpStatus ?? "" })}</p>
            {error.detail ? (
              <div>
                <p className="text-xs text-muted-foreground">{t("deliveries.technicalDetail")}</p>
                <code className="mt-1 block break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                  {error.detail}
                </code>
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">{t("deliveries.payload")}</h3>
          <p className="text-xs text-muted-foreground">{t("deliveries.payloadHint")}</p>
        </div>
        <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
          {prettyJson(delivery.payload)}
        </pre>
      </section>

      {delivery.status !== "pending" ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">{t("deliveries.redeliverHint")}</p>
          <Button
            variant="outline"
            onClick={sendAgain}
            loading={redeliver.isPending}
            disabled={!webhookActive}
            title={webhookActive ? undefined : t("problems.webhookPaused")}
          >
            <RotateCcw aria-hidden="true" />
            {t("deliveries.redeliver")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Fact({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "min-w-0 space-y-0.5 sm:col-span-2" : "min-w-0 space-y-0.5"}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}
