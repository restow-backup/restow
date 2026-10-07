import { Link, useNavigate } from "@tanstack/react-router";
import {
  BellRing,
  Building,
  Download,
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { endpointDetailTo } from "@/features/endpoints/paths";
import { webhookDetailTo } from "@/features/integrations/paths";
import { downloadFile } from "@/features/stats/download";
import { errorMessageKey } from "@/lib/api";
import { ExtensionSlot } from "@/lib/extensions";
import { useSession } from "@/lib/session";
import { activeTenantPageTo, tenantPageTo } from "@/lib/tenant-paths";

import {
  DELIVERIES_EXPORT_PATH,
  type DeliveryStatus,
  PROVIDER_DELIVERIES_EXPORT_PATH,
  type ReportDelivery,
  type ReportRule,
  type ReportTrigger,
  deliveryQuery,
} from "./api";
import {
  useDeleteRule,
  useReportCatalog,
  useReportDeliveries,
  useReportRules,
  useReportsScope,
  useTestRule,
  useUpdateRule,
} from "./hooks";
import { reportsTo } from "./paths";
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

  if (scope.allTenants) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("page.title")} description={t("page.allTenants")} />
        <DeliveryLog allTenants />
      </div>
    );
  }

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
      <DeliveryLog allTenants={false} />
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
                <ExtensionSlot
                  name="reports.scheduleLocked"
                  props={{}}
                  fallback={
                    <StatusBadge tone="muted" icon={Lock} className="self-center">
                      {t("page.reportLocked")}
                    </StatusBadge>
                  }
                />
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
  const navigate = useNavigate();
  const channels = channelSummary(rule);
  const parts = [
    channels.recipients > 0 ? t("rules.recipients", { count: channels.recipients }) : null,
    channels.inApp ? t("rules.bell") : null,
    channels.webhook ? t("rules.webhook") : null,
  ].filter((part): part is string => part !== null);
  // A rule whose only webhook was deleted keeps running but reaches nobody: say so.
  const silent = rule.enabled && parts.length === 0;

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
      <TableCell className="text-sm">
        {silent ? (
          <StatusBadge tone="warning" icon data-flag="no-channel">
            {t("rules.noChannel")}
          </StatusBadge>
        ) : (
          parts.join(" · ")
        )}
      </TableCell>
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
                    result.queued === 0
                      ? toast.warning(t("toasts.testNothing"))
                      : toast.success(t("toasts.testQueued", { count: result.queued }), {
                          action: {
                            label: t("toasts.openLog"),
                            onClick: () => void navigate({ to: reportsTo() }),
                          },
                        }),
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

/** The reason a delivery failed or was skipped, when the server named a known one. */
export const DELIVERY_REASONS = [
  "mail_not_configured",
  "not_available",
  "webhook_deleted",
  "webhook_inactive",
  "no_recipient",
  "no_webhook",
  "demo_mode",
  "send_failed",
] as const;

function isKnownReason(value: string): boolean {
  return (DELIVERY_REASONS as readonly string[]).includes(value);
}

/**
 * Why a delivery failed or was skipped: a known reason in words, anything else (an SMTP server's
 * or a receiver's own answer, in whatever language it speaks) folded away as technical detail.
 */
function DeliveryReason({ error }: { error: string }) {
  const { t } = useTranslation("reports");
  if (isKnownReason(error)) {
    return (
      <span className="mt-1 block text-xs text-muted-foreground">
        {t(`deliveries.reasons.${error}`)}
      </span>
    );
  }
  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{t("deliveries.technicalDetail")}</summary>
      <span className="mt-1 block break-words font-mono">{error}</span>
    </details>
  );
}

const STATUSES: readonly DeliveryStatus[] = ["pending", "sent", "failed", "skipped"];

/** Where the subject of a delivery lives, in the active tenant (null: no page for it). */
function subjectPath(row: ReportDelivery): string | null {
  const subject = row.subject;
  if (!subject) return null;
  if (subject.endpointId) return String(endpointDetailTo(subject.endpointId));
  if (subject.jobId) return `/history/${encodeURIComponent(subject.jobId)}`;
  return null;
}

function DeliveryLog({ allTenants }: { allTenants: boolean }) {
  const { t } = useTranslation("reports");
  const { t: tc } = useTranslation("common");
  const session = useSession();
  const [status, setStatus] = React.useState<DeliveryStatus | null>(null);
  const [ruleId, setRuleId] = React.useState<string | null>(null);
  const rules = useReportRules();
  const filters = { status, ruleId: allTenants ? null : ruleId };
  const query = useReportDeliveries(filters);
  const [exporting, setExporting] = React.useState(false);

  async function exportCsv() {
    setExporting(true);
    const toastId = toast.loading(t("deliveries.export.preparing"));
    try {
      const filename = await downloadFile({
        path: `${allTenants ? PROVIDER_DELIVERIES_EXPORT_PATH : DELIVERIES_EXPORT_PATH}${deliveryQuery(filters)}`,
        accept: "text/csv",
        fallbackName: "alert-deliveries.csv",
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

  const openInTenant = (tenantId: string | undefined) => {
    if (allTenants && tenantId) session.setActiveTenant(tenantId);
  };

  const rows = query.items;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("deliveries.title")}</CardTitle>
        <CardDescription>
          {allTenants ? t("deliveries.descriptionAllTenants") : t("deliveries.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={status ?? "all"}
            onValueChange={(value) => setStatus(value === "all" ? null : (value as DeliveryStatus))}
          >
            <SelectTrigger className="w-48" aria-label={t("deliveries.filters.status")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("deliveries.filters.allStatuses")}</SelectItem>
              {STATUSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`deliveries.status.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {allTenants ? null : (
            <Select
              value={ruleId ?? "all"}
              onValueChange={(value) => setRuleId(value === "all" ? null : value)}
            >
              <SelectTrigger className="w-64" aria-label={t("deliveries.filters.rule")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("deliveries.filters.allRules")}</SelectItem>
                {(rules.data ?? []).map((rule) => (
                  <SelectItem key={rule.id} value={rule.id}>
                    {rule.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            loading={exporting}
            onClick={() => void exportCsv()}
          >
            <Download aria-hidden="true" />
            {t("deliveries.export.action")}
          </Button>
        </div>
        {query.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : query.error ? (
          <ErrorState
            title={t("deliveries.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : rows.length === 0 ? (
          <EmptyState icon={Send} title={t("deliveries.empty")} />
        ) : (
          <Table className="min-w-[48rem]" scrollLabel={t("deliveries.title")}>
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST}>{t("deliveries.columns.time")}</TableHead>
                {allTenants ? <TableHead>{t("deliveries.columns.tenant")}</TableHead> : null}
                <TableHead>{t("deliveries.columns.rule")}</TableHead>
                <TableHead>{t("deliveries.columns.what")}</TableHead>
                <TableHead>{t("deliveries.columns.channel")}</TableHead>
                <TableHead>{t("deliveries.columns.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const tenantId = row.tenant?.id;
                const path = allTenants ? null : subjectPath(row);
                return (
                  <TableRow key={row.id} data-delivery={row.id}>
                    <TableCell pin={PIN_FIRST} className="whitespace-nowrap">
                      <RelativeTime value={row.createdAt} />
                    </TableCell>
                    {allTenants ? (
                      <TableCell className="max-w-48 truncate">
                        {tenantId ? (
                          <Link
                            to={tenantPageTo(tenantId, "overview")}
                            className="text-primary hover:underline"
                          >
                            {row.tenant?.name}
                          </Link>
                        ) : null}
                      </TableCell>
                    ) : null}
                    <TableCell className="max-w-48 truncate">
                      {row.ruleId ? (
                        <Link
                          to={
                            tenantId
                              ? tenantPageTo(tenantId, "notifications")
                              : activeTenantPageTo("notifications")
                          }
                          className="text-primary hover:underline"
                          title={t("deliveries.openRule")}
                        >
                          {row.ruleName}
                        </Link>
                      ) : (
                        row.ruleName
                      )}
                    </TableCell>
                    <TableCell className="max-w-64">
                      <span className="block truncate">
                        {row.kind === "summary"
                          ? t("deliveries.summary")
                          : row.event
                            ? t(`events.${row.event}`)
                            : "–"}
                      </span>
                      {row.target ? (
                        path ? (
                          <Link
                            to={path as never}
                            className="block truncate text-xs text-primary hover:underline"
                          >
                            {row.target}
                          </Link>
                        ) : (
                          <span className="block truncate text-xs text-muted-foreground">
                            {row.target}
                          </span>
                        )
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-56">
                      <span className="block">{t(`deliveries.channel.${row.channel}`)}</span>
                      {row.recipient ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.recipient}
                        </span>
                      ) : null}
                      {row.webhook && !allTenants ? (
                        <Link
                          to={webhookDetailTo(row.webhook.id)}
                          className="block text-xs text-primary hover:underline"
                          onClick={() => openInTenant(tenantId)}
                        >
                          {t("deliveries.openWebhook")}
                        </Link>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-w-64">
                      <StatusBadge tone={STATUS_TONE[row.status]}>
                        {row.channel === "webhook" && row.status === "pending"
                          ? t("deliveries.status.handedOver")
                          : t(`deliveries.status.${row.status}`)}
                      </StatusBadge>
                      {row.lastError ? <DeliveryReason error={row.lastError} /> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t("deliveries.loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
