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
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";

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
 * Alerts and reports: the tenant's notification rules (an event triggers an
 * alert) and report rules (a point in time triggers a summary), and the log
 * of everything sent. Alerts are always offered; reports where the
 * installation enables them (the catalog's `scheduledAvailable`).
 */
export function ReportsPage() {
  return (
    <RequireRole roles={REPORTS_ROLES}>
      <TooltipProvider delayDuration={200}>
        <ReportsContent />
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

function ReportsContent() {
  const { t } = useTranslation("reports");
  const scope = useReportsScope();
  const catalog = useReportCatalog();
  const [creating, setCreating] = React.useState<ReportTrigger | null>(null);

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

  const scheduledAvailable = catalog.data?.scheduledAvailable ?? false;

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
      <Tabs defaultValue="rules">
        <TabsList>
          <TabsTrigger value="rules">{t("page.tabs.rules")}</TabsTrigger>
          <TabsTrigger value="deliveries">{t("page.tabs.deliveries")}</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="mt-4 space-y-6">
          <RuleTables periods={catalog.data?.periods ?? [1, 7, 30, 90]} />
        </TabsContent>
        <TabsContent value="deliveries" className="mt-4">
          <DeliveryLog />
        </TabsContent>
      </Tabs>
      {creating ? (
        <RuleFormDialog
          open
          trigger={creating}
          periods={catalog.data?.periods ?? [1, 7, 30, 90]}
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
        />
      ) : null}
    </div>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("rules.columns.rule")}</TableHead>
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
      <TableCell className="max-w-64">
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("deliveries.columns.time")}</TableHead>
                <TableHead>{t("deliveries.columns.rule")}</TableHead>
                <TableHead>{t("deliveries.columns.what")}</TableHead>
                <TableHead>{t("deliveries.columns.channel")}</TableHead>
                <TableHead>{t("deliveries.columns.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">
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
