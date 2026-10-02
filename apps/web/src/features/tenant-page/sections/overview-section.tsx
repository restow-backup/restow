import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Boxes,
  ChevronDown,
  Circle,
  CircleCheck,
  CirclePause,
  Ellipsis,
  MinusCircle,
  Pause,
  Play,
  Plug,
  ShieldCheck,
  Shield as ShieldIcon,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import type { SetupItem } from "@/features/dashboard/api";
import { useDashboard } from "@/features/dashboard/use-dashboard";
import { useSourceList } from "@/features/sources/use-sources";
import { HealthSummary, TenantStatusBadge } from "@/features/tenants/components/badges";
import { ConfirmDialog } from "@/features/tenants/components/confirm-dialog";
import { DeleteTenantDialog } from "@/features/tenants/components/delete-tenant-dialog";
import { useTenantDetail, useTenantHealth, useUpdateTenant } from "@/features/tenants/hooks";
import { tenantsListTo } from "@/features/tenants/paths";
import { genericError } from "@/features/tenants/presenters";
import type { TenantDetail } from "@/features/tenants/types";
import type { TenantSectionProps } from "@/lib/extensions";
import { formatDateTime, formatInteger } from "@/lib/format";
import { providerMay } from "@/lib/provider-role";
import { hasFeature, useSession } from "@/lib/session";
import { tenantPageTo } from "@/lib/tenant-paths";
import { cn } from "@/lib/utils";

import { useWordingScope } from "@/features/installation/scope";
import { useTenantWriteBlock } from "../access";
import { TENANT_SECTION_META } from "../meta";

type DialogName = "suspend" | "resume" | "delete" | null;

/**
 * The overview of a tenant: the figures that matter at a glance (protected
 * objects, machines, whether the backups are proven restorable, the state of the
 * connections), the way into every other section, the setup steps as a plain
 * list, and, for the provider, the lifecycle of the tenant (rename, suspend,
 * delete). It replaces the provider's tenant detail page.
 */
export function OverviewSection({ tenant }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  const detail = useTenantDetail(tenant.id);

  if (detail.isPending) {
    return <OverviewSkeleton />;
  }
  if (detail.isError && !detail.data) {
    return (
      <ErrorState
        title={t("overview.error")}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
      />
    );
  }
  return <OverviewView tenant={detail.data as TenantDetail} />;
}

function OverviewView({ tenant }: { tenant: TenantDetail }) {
  const { t, i18n } = useTranslation("tenantpage");
  const navigate = useNavigate();
  const session = useSession();
  const block = useTenantWriteBlock();
  const scope = useWordingScope();
  const [dialog, setDialog] = React.useState<DialogName>(null);
  const managesTenants = hasFeature(session, "tenants.additional");
  // Renaming, suspending and deleting are the provider's, and only where tenants are managed at all.
  const lifecycle = session.isProviderAdmin && managesTenants && block === null;
  const canDelete = lifecycle && providerMay(session, "owner");
  const created = formatDateTime(tenant.createdAt, i18n.language);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight">{tenant.name}</h2>
            <TenantStatusBadge status={tenant.status} />
            {tenant.kind === "internal" && managesTenants ? (
              <Badge variant="outline">{t("overview.own")}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {tenant.customerNumber ? (
              <>
                <span className="sr-only">{t("overview.customerNumber")} </span>
                <span className="font-mono">{tenant.customerNumber}</span>
                {" · "}
              </>
            ) : null}
            <span className="font-mono">{tenant.slug}</span>
            {created ? ` · ${t("overview.created", { date: created })}` : null}
          </p>
        </div>
        {lifecycle ? <ActionsMenu tenant={tenant} onSelect={setDialog} /> : null}
      </div>

      <StatusNotice tenant={tenant} canResume={lifecycle} onResume={() => setDialog("resume")} />

      <Figures tenant={tenant} />

      <SectionLinks scope={scope} />

      <SetupSteps />

      {canDelete && tenant.kind === "internal" ? (
        <Card>
          <CardHeader className="space-y-1.5">
            <CardTitle>{t("overview.danger.title")}</CardTitle>
            <CardDescription>{t("overview.danger.internal")}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}
      {canDelete && tenant.kind !== "internal" ? (
        <Card className="border-destructive/40">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
            <div className="space-y-1.5">
              <CardTitle>{t("overview.danger.title")}</CardTitle>
              <CardDescription>{t("overview.danger.description")}</CardDescription>
            </div>
            <Button variant="destructive" onClick={() => setDialog("delete")}>
              <Trash2 />
              {t("overview.actions.delete")}
            </Button>
          </CardHeader>
        </Card>
      ) : null}

      <StatusDialog
        tenant={tenant}
        target={dialog === "suspend" ? "suspended" : dialog === "resume" ? "active" : null}
        onClose={() => setDialog(null)}
      />
      {dialog === "delete" ? (
        <DeleteTenantDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          tenant={tenant}
          onDeleted={() => void navigate({ to: tenantsListTo(), replace: true })}
        />
      ) : null}
    </div>
  );
}

// --- Lifecycle --------------------------------------------------------------------

function ActionsMenu({
  tenant,
  onSelect,
}: {
  tenant: TenantDetail;
  onSelect: (dialog: DialogName) => void;
}) {
  const { t } = useTranslation("tenantpage");
  const label = t("overview.actions.moreFor", { name: tenant.name });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={label} title={label}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {tenant.status === "suspended" ? (
          <DropdownMenuItem onSelect={() => onSelect("resume")}>
            <Play />
            {t("overview.actions.resume")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onSelect("suspend")}>
            <Pause />
            {t("overview.actions.suspend")}
          </DropdownMenuItem>
        )}
        {tenant.kind === "internal" ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onSelect("delete")} variant="destructive">
              <Trash2 />
              {t("overview.actions.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusNotice({
  tenant,
  canResume,
  onResume,
}: {
  tenant: TenantDetail;
  canResume: boolean;
  onResume: () => void;
}) {
  const { t } = useTranslation("tenantpage");
  if (tenant.status === "suspended") {
    return (
      <Alert variant="warning">
        <CirclePause />
        <AlertTitle>{t("overview.suspended.title")}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>{t("overview.suspended.description")}</span>
          {canResume ? (
            <Button variant="outline" size="sm" onClick={onResume}>
              <Play />
              {t("overview.actions.resume")}
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (tenant.status === "deleting") {
    return (
      <Alert variant="destructive">
        <Trash2 />
        <AlertTitle>{t("overview.deleting.title")}</AlertTitle>
        <AlertDescription>{t("overview.deleting.description")}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

function StatusDialog({
  tenant,
  target,
  onClose,
}: {
  tenant: TenantDetail;
  target: "suspended" | "active" | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("tenantpage");
  const update = useUpdateTenant(tenant.id);
  // Keep the wording of the last request while the dialog fades out.
  const lastTarget = React.useRef(target);
  if (target) {
    lastTarget.current = target;
  }
  const suspending = (target ?? lastTarget.current) === "suspended";

  const close = () => {
    update.reset();
    onClose();
  };

  const confirm = () => {
    if (!target) {
      return;
    }
    update.mutate(
      { status: target },
      {
        onSuccess: () => {
          toast.success(t(suspending ? "overview.toasts.suspended" : "overview.toasts.resumed"));
          close();
        },
      },
    );
  };

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && close()}
      title={t(suspending ? "overview.suspend.title" : "overview.resume.title", {
        name: tenant.name,
      })}
      description={t(suspending ? "overview.suspend.description" : "overview.resume.description")}
      confirmLabel={t(suspending ? "overview.suspend.confirm" : "overview.resume.confirm")}
      destructive={suspending}
      pending={update.isPending}
      error={update.error ? genericError(update.error) : null}
      onConfirm={confirm}
    />
  );
}

// --- Figures ----------------------------------------------------------------------

/** Four figures: protected objects, machines, readiness, connections. */
function Figures({ tenant }: { tenant: TenantDetail }) {
  const { t, i18n } = useTranslation("tenantpage");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const dashboard = useDashboard("tenant");
  const widgets = dashboard.query.data?.widgets;
  const loading = dashboard.query.isPending;
  const health = useTenantHealth(tenant);
  const sources = useSourceList();

  const objects = widgets?.protectedObjects?.state === "ok" ? widgets.protectedObjects.data : null;
  const kinds = widgets?.lastBackup?.state === "ok" ? widgets.lastBackup.data.protectedKinds : null;
  const machines = widgets?.endpoints?.state === "ok" ? widgets.endpoints.data : null;

  const objectParts = kinds
    ? ([
        kinds.mailbox > 0 ? t("overview.figures.kinds.mailbox", { count: kinds.mailbox }) : null,
        kinds.onedrive > 0 ? t("overview.figures.kinds.onedrive", { count: kinds.onedrive }) : null,
        kinds.imap > 0 ? t("overview.figures.kinds.imap", { count: kinds.imap }) : null,
      ].filter(Boolean) as string[])
    : [];

  const connected = (sources.query.data ?? []).filter((source) => source.status === "active");
  const failing = (sources.query.data ?? []).filter((source) => source.status === "error");
  const total = (sources.query.data ?? []).filter((source) => source.kind !== "import").length;

  return (
    <div className="grid grid-cols-1 gap-4 *:min-w-0 sm:grid-cols-2 xl:grid-cols-4">
      <Stat
        icon={ShieldIcon}
        title={t("overview.figures.objects")}
        to={tenantPageTo(tenant.id, "protection")}
        linkLabel={t("overview.figures.objectsLink")}
      >
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : objects ? (
          <>
            <span className="text-2xl font-semibold tabular-nums">
              {formatInteger(objects.total, language)}
            </span>
            <span className="text-xs text-muted-foreground">
              {objectParts.length > 0 ? objectParts.join(" · ") : t("overview.figures.noneYet")}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{t("overview.figures.unavailable")}</span>
        )}
      </Stat>
      <Stat
        icon={Boxes}
        title={t("overview.figures.machines")}
        to={tenantPageTo(tenant.id, "agents")}
        linkLabel={t("overview.figures.machinesLink")}
      >
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : machines ? (
          <>
            <span className="text-2xl font-semibold tabular-nums">
              {formatInteger(machines.protected, language)}
            </span>
            <span className="text-xs text-muted-foreground">
              {machines.protected > 0
                ? t("overview.figures.machinesSplit", {
                    servers: machines.servers,
                    clients: machines.clients,
                  })
                : t("overview.figures.noneYet")}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{t("overview.figures.unavailable")}</span>
        )}
      </Stat>
      <Stat
        icon={ShieldCheck}
        title={t("overview.figures.readiness")}
        to="/verify"
        linkLabel={t("overview.figures.readinessLink")}
      >
        <HealthSummary state={{ status: health.status, data: health.data }} />
      </Stat>
      <Stat
        icon={Plug}
        title={t("overview.figures.connections")}
        to={tenantPageTo(tenant.id, "connections")}
        linkLabel={t("overview.figures.connectionsLink")}
      >
        {sources.query.isPending ? (
          <Skeleton className="h-6 w-16" />
        ) : sources.query.isError ? (
          <span className="text-sm text-muted-foreground">{t("overview.figures.unavailable")}</span>
        ) : total === 0 ? (
          <span className="text-sm text-muted-foreground">
            {t("overview.figures.noConnection")}
          </span>
        ) : (
          <>
            <span className="text-2xl font-semibold tabular-nums">
              {t("overview.figures.connected", { connected: connected.length, total })}
            </span>
            <span
              className={cn(
                "text-xs",
                failing.length > 0 ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {failing.length > 0
                ? t("overview.figures.failing", { count: failing.length })
                : t("overview.figures.allWell")}
            </span>
          </>
        )}
      </Stat>
    </div>
  );
}

function Stat({
  icon: Icon,
  title,
  to,
  linkLabel,
  children,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  to: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Icon className="size-4 text-muted-foreground" aria-hidden={true} />
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-1">
        {children}
        <Link
          to={to as never}
          className="mt-1 inline-flex items-center gap-1 rounded-sm text-xs text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {linkLabel}
          <ArrowRight aria-hidden="true" className="size-3" />
        </Link>
      </CardContent>
    </Card>
  );
}

// --- Links into the sections ----------------------------------------------------------

/** One card per other section: what it holds, and the way in. */
function SectionLinks({ scope }: { scope: "organisation" | "tenants" }) {
  const { t } = useTranslation();
  const { activeTenant } = useSession();
  if (!activeTenant) {
    return null;
  }
  const sections = TENANT_SECTION_META.filter((meta) => meta.id !== "overview");
  return (
    <section aria-labelledby="overview-sections" className="space-y-3">
      <h3 id="overview-sections" className="text-sm font-medium">
        {t("tenantpage:overview.sectionsTitle", { scope })}
      </h3>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {sections.map((meta) => {
          const Icon = meta.icon;
          return (
            <li key={meta.id}>
              <Link
                to={tenantPageTo(activeTenant.id, meta.id)}
                className="flex h-full items-start gap-3 rounded-lg border bg-card p-3 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-sm font-medium">{t(meta.labelKey)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t(meta.descriptionKey, { scope })}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// --- Setup steps ------------------------------------------------------------------

const STEP_ICON: Readonly<Record<SetupItem["state"], React.ComponentType<{ className?: string }>>> =
  {
    done: CircleCheck,
    open: Circle,
    attention: TriangleAlert,
    not_needed: MinusCircle,
  };

// A step that is done is in order, not proven: the check mark takes the text colour, never green.
const STEP_CLASS: Readonly<Record<SetupItem["state"], string>> = {
  done: "text-foreground",
  open: "text-muted-foreground",
  attention: "text-warning-text",
  not_needed: "text-muted-foreground",
};

/**
 * "Show setup steps": the steps from a new tenant to backups that are proven
 * restorable, as a plain list of what is done and what is not. The overview of
 * the daily work no longer carries them once everything is set up; they stay
 * here to look up.
 */
function SetupSteps() {
  const { t } = useTranslation("tenantpage");
  const { t: td } = useTranslation("dashboard");
  const [open, setOpen] = React.useState(false);
  const dashboard = useDashboard("tenant");
  const setup = dashboard.query.data?.widgets.setup;
  const data = setup?.state === "ok" ? setup.data : null;

  if (!dashboard.query.isPending && !data) {
    return null;
  }
  return (
    <Card data-widget="setup-steps" className="gap-0 py-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center justify-between gap-3 px-6">
          <p className="flex items-center gap-2 text-sm">
            <span className="font-medium">{td("setup.title")}</span>
            {data ? (
              <span className="text-muted-foreground">
                {td("setup.progress", { done: data.done, total: data.total })}
              </span>
            ) : null}
          </p>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" aria-expanded={open} disabled={!data}>
              {open ? t("overview.steps.hide") : t("overview.steps.show")}
              <ChevronDown
                aria-hidden="true"
                className={cn("transition-transform duration-200", open && "rotate-180")}
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="px-6 pt-4">
          {data ? (
            <ol className="space-y-3">
              {data.items.map((item) => {
                const Icon = STEP_ICON[item.state];
                const hint = item.reason
                  ? td(`setup.reasons.${item.reason}`, { defaultValue: "" })
                  : item.state === "done"
                    ? ""
                    : td(`setup.items.${item.id}.hint`);
                return (
                  <li
                    key={item.id}
                    data-item={item.id}
                    data-state={item.state}
                    className="flex items-start gap-3"
                  >
                    <Icon className={cn("mt-0.5 size-4 shrink-0", STEP_CLASS[item.state])} />
                    <div className="min-w-0 space-y-0.5">
                      <p className="text-sm font-medium">
                        {td(`setup.items.${item.id}.label`)}
                        <span className="sr-only"> ({td(`setup.state.${item.state}`)})</span>
                      </p>
                      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function OverviewSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} className="gap-3">
            <CardHeader>
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
      <span className="sr-only">{t("common:loading.label")}</span>
    </div>
  );
}
