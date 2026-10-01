import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import type { ReadinessSummary } from "@/features/verify/api";
import type { VerifyFormat } from "@/features/verify/use-verify";
import { cn } from "@/lib/utils";

/** The tenant verdict in one sentence: what can be restored today. */
export function OverallBanner({ summary }: { summary: ReadinessSummary }) {
  const { t } = useTranslation("verify");
  if (summary.overall === null) {
    return (
      <Alert variant="info">
        <ShieldQuestion />
        <AlertTitle>{t("overall.empty.title")}</AlertTitle>
        <AlertDescription>{t("overall.empty.description")}</AlertDescription>
      </Alert>
    );
  }
  const unproven = summary.red + summary.unverified + summary.noBackup;
  const attention = summary.yellow + summary.overdue;
  const variant =
    summary.overall === "green"
      ? "success"
      : summary.overall === "yellow"
        ? "warning"
        : "destructive";
  const Icon =
    summary.overall === "green"
      ? ShieldCheck
      : summary.overall === "yellow"
        ? ShieldAlert
        : ShieldX;
  return (
    <Alert variant={variant}>
      <Icon />
      <AlertTitle>{t(`overall.${summary.overall}.title`)}</AlertTitle>
      <AlertDescription>
        {t(`overall.${summary.overall}.description`, {
          count: summary.overall === "red" ? unproven : attention,
          total: summary.total,
        })}
      </AlertDescription>
    </Alert>
  );
}

interface TileProps {
  label: string;
  hint: string;
  value: string;
  tone: "success" | "warning" | "destructive" | "muted";
  icon: React.ReactNode;
}

const TONE: Record<TileProps["tone"], string> = {
  success: "text-success",
  warning: "text-warning-foreground dark:text-warning",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

function Tile({ label, hint, value, tone, icon }: TileProps) {
  return (
    <Card className="py-0">
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-2xl font-semibold tabular-nums">{value}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className={cn("[&>svg]:size-5", TONE[tone])}>{icon}</span>
      </CardContent>
    </Card>
  );
}

/** Four counters: ready, attention, not restorable, not proven. */
export function SummaryTiles({
  summary,
  format,
}: { summary: ReadinessSummary; format: VerifyFormat }) {
  const { t } = format;
  const notProven = summary.unverified + summary.noBackup;
  return (
    <div className="grid grid-cols-1 gap-4 *:min-w-0 sm:grid-cols-2 xl:grid-cols-4">
      <Tile
        label={t("summary.ready")}
        hint={t("summary.readyHint")}
        value={format.integer(summary.green)}
        tone="success"
        icon={<ShieldCheck aria-hidden="true" />}
      />
      <Tile
        label={t("summary.attention")}
        hint={t("summary.attentionHint", { overdue: summary.overdue })}
        value={format.integer(summary.yellow)}
        tone={summary.yellow + summary.overdue > 0 ? "warning" : "muted"}
        icon={<ShieldAlert aria-hidden="true" />}
      />
      <Tile
        label={t("summary.failed")}
        hint={t("summary.failedHint")}
        value={format.integer(summary.red)}
        tone={summary.red > 0 ? "destructive" : "muted"}
        icon={<ShieldX aria-hidden="true" />}
      />
      <Tile
        label={t("summary.unproven")}
        hint={t("summary.unprovenHint", {
          unverified: summary.unverified,
          noBackup: summary.noBackup,
        })}
        value={format.integer(notProven)}
        tone={notProven > 0 ? "destructive" : "muted"}
        icon={<ShieldQuestion aria-hidden="true" />}
      />
    </div>
  );
}
