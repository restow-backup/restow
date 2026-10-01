import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRightLeft,
  CirclePause,
  Clock,
  Ellipsis,
  KeyRound,
  Mail,
  Pause,
  Pencil,
  Play,
  SearchX,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { REPORTS_PATH } from "@/features/reports/paths";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";
import {
  HealthSummary,
  LastBackup,
  MailboxUsageText,
  TenantStatusBadge,
} from "./components/badges";
import { ConfirmDialog } from "./components/confirm-dialog";
import { CustomerDataPanel } from "./components/customer-data-panel";

import { DeleteTenantDialog } from "./components/delete-tenant-dialog";
import { EditTenantDialog } from "./components/edit-tenant-dialog";
import { MembersPanel } from "./components/members-panel";
import { useTenantDetail, useTenantHealth, useUpdateTenant, useUsageOverview } from "./hooks";
import { tenantsListTo } from "./paths";
import { canEnter, genericError, mailboxUsage } from "./presenters";
import type { TenantDetail } from "./types";
import { useEnterTenant } from "./use-enter-tenant";

type DialogName = "edit" | "suspend" | "resume" | "delete" | null;

/**
 * One tenant as the provider sees it: state, protection overview, members
 * and invitations, and the lifecycle actions (switch into it, edit, suspend,
 * delete).
 */
export function TenantDetailPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("tenants");
  const query = useTenantDetail(tenantId);

  let body: React.ReactNode;
  if (query.isPending) {
    body = <DetailSkeleton />;
  } else if (query.isError && !query.data) {
    body =
      query.error instanceof ApiError && query.error.status === 404 ? (
        <Alert variant="warning">
          <SearchX />
          <AlertTitle>{t("detail.notFound.title")}</AlertTitle>
          <AlertDescription>{t("detail.notFound.description")}</AlertDescription>
        </Alert>
      ) : (
        <ErrorState
          title={t("detail.error")}
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      );
  } else {
    body = <TenantDetailView tenant={query.data} />;
  }

  return (
    <div className="space-y-6">
      <Link
        to={tenantsListTo()}
        className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("actions.backToList")}
      </Link>
      {body}
    </div>
  );
}

function TenantDetailView({ tenant }: { tenant: TenantDetail }) {
  const { t, i18n } = useTranslation("tenants");
  const navigate = useNavigate();
  const { enter, activeTenantId } = useEnterTenant();
  const [dialog, setDialog] = React.useState<DialogName>(null);
  const session = useSession();
  const enterable = canEnter(tenant);
  const canDelete = providerMay(session, "owner");
  const created = formatDateTime(tenant.createdAt, i18n.language);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{tenant.name}</h1>
            <TenantStatusBadge status={tenant.status} />
            {tenant.id === activeTenantId ? (
              <Badge variant="secondary">{t("list.current")}</Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{tenant.slug}</span>
            {created ? ` · ${t("detail.created", { date: created })}` : null}
          </p>
        </div>
        {enterable ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button onClick={() => enter(tenant)}>
              <ArrowRightLeft />
              {t("actions.enter")}
            </Button>
            <ActionsMenu tenant={tenant} onSelect={setDialog} />
          </div>
        ) : null}
      </div>

      <StatusNotice tenant={tenant} onResume={() => setDialog("resume")} />

      <Overview tenant={tenant} />

      <CustomerDataPanel
        tenant={tenant}
        readOnly={!enterable}
        onOpenAlerts={
          enterable
            ? () => {
                if (activeTenantId !== tenant.id) {
                  session.setActiveTenant(tenant.id);
                }
                void navigate({ to: REPORTS_PATH as never });
              }
            : undefined
        }
      />

      <MembersPanel
        tenantId={tenant.id}
        tenantName={tenant.name}
        readOnly={!enterable}
        showProviderNote
      />

      {enterable && canDelete ? (
        <Card className="border-destructive/40">
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
            <div className="space-y-1.5">
              <CardTitle>{t("detail.danger.title")}</CardTitle>
              <CardDescription>{t("detail.danger.description")}</CardDescription>
            </div>
            <Button variant="destructive" onClick={() => setDialog("delete")}>
              <Trash2 />
              {t("actions.delete")}
            </Button>
          </CardHeader>
        </Card>
      ) : null}

      <EditTenantDialog
        open={dialog === "edit"}
        onOpenChange={(open) => !open && setDialog(null)}
        tenant={tenant}
      />
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

function ActionsMenu({
  tenant,
  onSelect,
}: {
  tenant: TenantDetail;
  onSelect: (dialog: DialogName) => void;
}) {
  const { t } = useTranslation("tenants");
  const label = t("actions.moreFor", { name: tenant.name });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" aria-label={label} title={label}>
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => onSelect("edit")}>
          <Pencil />
          {t("actions.edit")}
        </DropdownMenuItem>
        {tenant.status === "suspended" ? (
          <DropdownMenuItem onSelect={() => onSelect("resume")}>
            <Play />
            {t("actions.resume")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onSelect("suspend")}>
            <Pause />
            {t("actions.suspend")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSelect("delete")} variant="destructive">
          <Trash2 />
          {t("actions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StatusNotice({ tenant, onResume }: { tenant: TenantDetail; onResume: () => void }) {
  const { t } = useTranslation("tenants");
  if (tenant.status === "suspended") {
    return (
      <Alert variant="warning">
        <CirclePause />
        <AlertTitle>{t("detail.suspended.title")}</AlertTitle>
        <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>{t("detail.suspended.description")}</span>
          <Button variant="outline" size="sm" onClick={onResume}>
            <Play />
            {t("actions.resume")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (tenant.status === "deleting") {
    return (
      <Alert variant="destructive">
        <Trash2 />
        <AlertTitle>{t("detail.deleting.title")}</AlertTitle>
        <AlertDescription>{t("detail.deleting.description")}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

// --- Overview -----------------------------------------------------------------------

function Overview({ tenant }: { tenant: TenantDetail }) {
  const { t } = useTranslation("tenants");
  const deleting = !canEnter(tenant);
  const health = useTenantHealth(tenant);
  const usage = useUsageOverview();
  const state = deleting ? undefined : { status: health.status, data: health.data };

  return (
    <div className="grid grid-cols-1 gap-4 *:min-w-0 sm:grid-cols-2 xl:grid-cols-4">
      <Stat icon={ShieldCheck} title={t("detail.overview.readiness")}>
        <HealthSummary state={state} deleting={deleting} />
      </Stat>
      <Stat icon={Mail} title={t("detail.overview.mailboxes")}>
        {deleting ? (
          <span className="text-sm text-muted-foreground">{t("mailboxes.notTracked")}</span>
        ) : usage.isPending ? (
          <Skeleton className="h-5 w-16" />
        ) : (
          <MailboxUsageText usage={mailboxUsage(tenant, usage.data)} />
        )}
        {tenant.mailboxCap === null && !deleting ? (
          <span className="text-xs text-muted-foreground">{t("detail.overview.noCap")}</span>
        ) : null}
      </Stat>
      <Stat icon={Clock} title={t("detail.overview.lastBackup")}>
        <span className="font-medium">
          <LastBackup state={state} deleting={deleting} />
        </span>
      </Stat>
      <Stat icon={KeyRound} title={t("detail.overview.encryption")}>
        <span className="font-medium">
          {tenant.keyVersion === null
            ? t("detail.overview.noKey")
            : t("detail.overview.keyVersion", { version: tenant.keyVersion })}
        </span>
        <span className="text-xs text-muted-foreground">{t("detail.overview.keyHint")}</span>
      </Stat>
    </div>
  );
}

interface StatProps {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  children: React.ReactNode;
}

function Stat({ icon: Icon, title, children }: StatProps) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <Icon className="size-4 text-muted-foreground" aria-hidden={true} />
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-1">{children}</CardContent>
    </Card>
  );
}

// --- Suspend / resume ---------------------------------------------------------------

interface StatusDialogProps {
  tenant: TenantDetail;
  target: "suspended" | "active" | null;
  onClose: () => void;
}

function StatusDialog({ tenant, target, onClose }: StatusDialogProps) {
  const { t } = useTranslation("tenants");
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
          toast.success(
            t(suspending ? "toasts.suspended" : "toasts.resumed", { name: tenant.name }),
          );
          close();
        },
      },
    );
  };

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => !open && close()}
      title={t(suspending ? "suspend.title" : "resume.title", { name: tenant.name })}
      description={t(suspending ? "suspend.description" : "resume.description")}
      confirmLabel={t(suspending ? "suspend.confirm" : "resume.confirm")}
      destructive={suspending}
      pending={update.isPending}
      error={update.error ? genericError(update.error) : null}
      onConfirm={confirm}
    />
  );
}

function DetailSkeleton() {
  const { t } = useTranslation("tenants");
  return (
    <div aria-busy="true" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-64" />
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
      <Card>
        <CardContent className="space-y-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </CardContent>
      </Card>
      <span className="sr-only">{t("common:loading.label")}</span>
    </div>
  );
}
