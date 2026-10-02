import { Link } from "@tanstack/react-router";
import {
  BellRing,
  Building,
  FileBarChart,
  Lock,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Send,
  Settings,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import {
  ConfirmDialog,
  EmptyState,
  RelativeTime,
  StatusBadge,
  type StatusTone,
} from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { activeTenantPageTo } from "@/lib/tenant-paths";

import type { DeliveryStatus, ReportRule, ReportTrigger } from "./api";
import {
  useDeleteRule,
  useReportCatalog,
  useReportDeliveries,
  useReportRules,
  useReportsScope,
  useTestRule,
  useUpdateRule,
} from "./hooks";
import { REPORTS_ROLES, channelSummary, presetOf } from "./presenters";
import { reportErrorMessage } from "./report-errors";
import { RuleFormDialog } from "./rule-form-dialog";

/**
 * Alerts: the log of everything the tenant was sent, newest first, and for
 * each entry what it was about, the rule behind it, the channel and the
 * outcome. The rules themselves (an event triggers an alert, a point in time a
 * summary report) and the recipients are settings of the tenant: they live on
 * the tenant page under Notifications, which this page points to.
 */
export function ReportsPage() {
  return (
    <RequireRole roles={REPORTS_ROLES}>
      <TooltipProvider delayDuration={200}>
        <AlertsContent />
      </TooltipProvider>
    </RequireRole>
  );
}

// A report that was sent is delivered, not proven: neutral, never green.
const STATUS_TONE: Record<DeliveryStatus, StatusTone> = {
  pending: "info",
  sent: "neutral",
  failed: "destructive",
  skipped: "muted",
};

function AlertsContent() {
  const { t } = useTranslation("reports");
  const scope = useReportsScope();

  if (scope.tenantId === null) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("page.title")} description={t("page.subtitle")} />
        <Alert variant="info">
          <Building />
          <AlertTitle>{t("page.noTenant.title")}</AlertTitle>
          <AlertDescription>{t("page.noTenant.description")}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("page.title")}
        description={
          scope.tenantName
            ? t("page.tenantScope", { tenant: scope.tenantName })
            : t("page.subtitle")
        }
        actions={
          <Link
            to={activeTenantPageTo("notifications")}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Settings aria-hidden="true" />
            {t("page.manageRules")}
          </Link>
        }
      />
      <DeliveryLog />
    </div>
  );
}

/**
 * The tenant's alert rules and report rules, with the buttons that add one:
 * the part of Alerts that is a setting, shown on the tenant page under
 * Notifications. Alerts are always offered; reports where the installation
 * enables them (the catalog's `scheduledAvailable`).
 */
export function AlertRulesPanel() {
  const { t } = useTranslation("reports");
  const catalog = useReportCatalog();
  const [creating, setCreating] = React.useState<ReportTrigger | null>(null);
  const scheduledAvailable = catalog.data?.scheduledAvailable ?? false;
  const periods = catalog.data?.periods ?? [1, 7, 30, 90];

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-6">
        <PageHeader
          title={t("rules.panelTitle")}
          description={t("rules.panelDescription")}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setCreating("event")}>
                <BellRing aria-hidden="true" />
                {t("page.newAlert")}
              </Button>
              {scheduledAvailable ? (
                <Button onClick={() => setCreating("schedule")}>
                  <Plus aria-hidden="true" />
                  {t("page.newReport")}
                </Button>
              ) : catalog.data ? (
                <StatusBadge tone="muted" icon={Lock} className="self-center">
                  {t("page.reportLocked")}
                </StatusBadge>
              ) : null}
            </div>
          }
        />
        <RuleTables periods={periods} />
        {creating ? (
          <RuleFormDialog
            open
            trigger={creating}
            periods={periods}
            onOpenChange={(open) => {
              if (!open) setCreating(null);
            }}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

function RuleTables({ periods }: { periods: readonly number[] }) {
  const { t } = useTranslation("reports");
  const query = useReportRules();
  const [editing, setEditing] = React.useState<ReportRule | null>(null);
  const [deleting, setDeleting] = React.useState<ReportRule | null>(null);
  const remove = useDeleteRule();

  if (query.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (query.error) {
    return (
      <ErrorState
        title={t("rules.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const rules = query.data ?? [];
  const alerts = rules.filter((rule) => rule.trigger === "event");
  const reports = rules.filter((rule) => rule.trigger === "schedule");

  return (
    <>
      <RuleCard
        title={t("rules.alerts.title")}
        description={t("rules.alerts.description")}
        empty={t("rules.alerts.empty")}
        icon={BellRing}
        rules={alerts}
        onEdit={setEditing}
        onDelete={setDeleting}
      />
      <RuleCard
        title={t("rules.reports.title")}
        description={t("rules.reports.description")}
        empty={t("rules.reports.empty")}
        icon={FileBarChart}
        rules={reports}
        onEdit={setEditing}
        onDelete={setDeleting}
      />
      {editing ? (
        <RuleFormDialog
          open
          rule={editing}
          periods={periods}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("rules.deleteConfirm.title")}
        description={t("rules.deleteConfirm.description", { name: deleting?.name ?? "" })}
        confirmLabel={t("rules.actions.delete")}
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success(t("toasts.deleted"));
              setDeleting(null);
            },
            onError: (error) => toast.error(reportErrorMessage(error, t)),
          });
        }}
      />
    </>
  );
}

function RuleCard({
  title,
  description,
  empty,
  icon,
  rules,
  onEdit,
  onDelete,
}: {
  title: string;
  description: string;
  empty: string;
  icon: typeof BellRing;
  rules: ReportRule[];
  onEdit: (rule: ReportRule) => void;
  onDelete: (rule: ReportRule) => void;
}) {
  const { t } = useTranslation("reports");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {rules.length === 0 ? (
          <EmptyState icon={icon} title={empty} />
        ) : (
          <Table className="min-w-[44rem]" scrollLabel={title}>
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST}>{t("rules.columns.rule")}</TableHead>
                <TableHead>{t("rules.columns.trigger")}</TableHead>
                <TableHead>{t("rules.columns.channels")}</TableHead>
                <TableHead>{t("rules.columns.lastDelivery")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("rules.columns.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <RuleRow key={rule.id} rule={rule} onEdit={onEdit} onDelete={onDelete} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function TriggerSummary({ rule }: { rule: ReportRule }) {
  const { t } = useTranslation("reports");
  if (rule.trigger === "event") {
    const shown = rule.events.slice(0, 2).map((event) => t(`events.${event}`));
    const more = rule.events.length - shown.length;
    return (
      <span className="text-sm">
        {shown.join(", ")}
        {more > 0 ? ` ${t("rules.moreEvents", { count: more })}` : ""}
      </span>
    );
  }
  const preset = presetOf(rule.cron);
  const cadence = preset
    ? t(`rules.cadence.${preset.frequency}`, {
        weekday: t(`weekdays.${preset.weekday}`),
        time: preset.time,
      })
    : (rule.cron ?? "");
  return (
    <span className="space-y-0.5">
      <span className="block text-sm">{cadence}</span>
      <span className="block text-xs text-muted-foreground">
        {rule.nextRunAt ? (
          <>
            {t("rules.next")} <RelativeTime value={rule.nextRunAt} focusable={false} />
          </>
        ) : (
          rule.timezone
        )}
      </span>
    </span>
  );
}

function RuleRow({
  rule,
  onEdit,
  onDelete,
}: {
  rule: ReportRule;
  onEdit: (rule: ReportRule) => void;
  onDelete: (rule: ReportRule) => void;
}) {
  const { t } = useTranslation("reports");
  const update = useUpdateRule();
  const test = useTestRule();
  const channels = channelSummary(rule);
  const parts = [
    channels.recipients > 0 ? t("rules.recipients", { count: channels.recipients }) : null,
    channels.inApp ? t("rules.bell") : null,
    channels.webhook ? t("rules.webhook") : null,
  ].filter((part): part is string => part !== null);

  return (
    <TableRow>
      <TableCell pin={PIN_FIRST} className="max-w-64">
        <span className="block truncate font-medium" title={rule.name}>
          {rule.name}
        </span>
        <span className="mt-1 flex flex-wrap gap-1">
          {rule.locked ? (
            <StatusBadge tone="muted" icon={Lock}>
              {t("rules.locked")}
            </StatusBadge>
          ) : rule.enabled ? null : (
            <StatusBadge tone="muted">{t("rules.paused")}</StatusBadge>
          )}
        </span>
      </TableCell>
      <TableCell>
        <TriggerSummary rule={rule} />
      </TableCell>
      <TableCell className="text-sm">{parts.join(" · ")}</TableCell>
      <TableCell>
        {rule.lastDelivery ? (
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[rule.lastDelivery.status]}>
              {t(`deliveries.status.${rule.lastDelivery.status}`)}
            </StatusBadge>
            <RelativeTime value={rule.lastDelivery.at} focusable={false} />
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">{t("rules.never")}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("rules.actions.menu", { name: rule.name })}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={rule.locked} onSelect={() => onEdit(rule)}>
              <Pencil aria-hidden="true" />
              {t("rules.actions.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={rule.locked || test.isPending}
              onSelect={() =>
                test.mutate(rule.id, {
                  onSuccess: (result) =>
                    toast.success(t("toasts.testQueued", { count: result.queued })),
                  onError: (error) => toast.error(reportErrorMessage(error, t)),
                })
              }
            >
              <Send aria-hidden="true" />
              {t("rules.actions.test")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={rule.locked && !rule.enabled}
              onSelect={() =>
                update.mutate(
                  { id: rule.id, patch: { enabled: !rule.enabled } },
                  {
                    onSuccess: () =>
                      toast.success(t(rule.enabled ? "toasts.paused" : "toasts.resumed")),
                    onError: (error) => toast.error(reportErrorMessage(error, t)),
                  },
                )
              }
            >
              {rule.enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {t(rule.enabled ? "rules.actions.pause" : "rules.actions.resume")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(rule)}>
              <Trash2 aria-hidden="true" />
              {t("rules.actions.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function DeliveryLog() {
  const { t } = useTranslation("reports");
  const query = useReportDeliveries(null);
  if (query.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (query.error) {
    return (
      <ErrorState
        title={t("deliveries.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const rows = query.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("deliveries.title")}</CardTitle>
        <CardDescription>{t("deliveries.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState icon={Send} title={t("deliveries.empty")} />
        ) : (
          <Table className="min-w-[48rem]" scrollLabel={t("deliveries.title")}>
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST}>{t("deliveries.columns.time")}</TableHead>
                <TableHead>{t("deliveries.columns.rule")}</TableHead>
                <TableHead>{t("deliveries.columns.what")}</TableHead>
                <TableHead>{t("deliveries.columns.channel")}</TableHead>
                <TableHead>{t("deliveries.columns.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell pin={PIN_FIRST} className="whitespace-nowrap">
                    <RelativeTime value={row.createdAt} />
                  </TableCell>
                  <TableCell className="max-w-48 truncate">{row.ruleName}</TableCell>
                  <TableCell className="max-w-64">
                    <span className="block truncate">
                      {row.kind === "summary"
                        ? t("deliveries.summary")
                        : row.event
                          ? t(`events.${row.event}`)
                          : "–"}
                    </span>
                    {row.target ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.target}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-56">
                    <span className="block">{t(`deliveries.channel.${row.channel}`)}</span>
                    {row.recipient ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.recipient}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-64">
                    <StatusBadge tone={STATUS_TONE[row.status]}>
                      {t(`deliveries.status.${row.status}`)}
                    </StatusBadge>
                    {row.lastError ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {t(`deliveries.reasons.${row.lastError}`, { defaultValue: row.lastError })}
                      </span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
