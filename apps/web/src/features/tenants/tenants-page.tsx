import { useNavigate, useSearch } from "@tanstack/react-router";
import { Building2, Plus, RefreshCw, Search } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenTenantSetup } from "@/features/tenant-setup/setup-tabs";
import { providerMay } from "@/lib/provider-role";
import { hasFeature, useSession } from "@/lib/session";

import { CreateTenantDialog } from "./components/create-tenant-dialog";
import { DeleteTenantDialog } from "./components/delete-tenant-dialog";
import { InstallationPanel } from "./components/installation-panel";
import { TenantTable } from "./components/tenant-table";
import { useTenantHealths, useTenantList, useUsageOverview } from "./hooks";
import { tenantsListTo } from "./paths";
import { canCreateTenant, filterTenants, parseTenantsSearch } from "./presenters";
import type { TenantItem } from "./types";
import { useEnterTenant } from "./use-enter-tenant";

/** `?new=1`, validated by `tenantsRoute` (index.ts); read here without the static route types. */
function useOpenWizardFromSearch(): boolean {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  return React.useMemo(() => parseTenantsSearch(raw), [raw]).new === true;
}

/**
 * Provider view of all tenants: mailbox usage and tenant count on top, then
 * every tenant with its mailboxes, last backup and recovery readiness. From
 * here the operator creates tenants, switches into one or deletes one.
 */
export function TenantsPage() {
  const { t } = useTranslation("tenants");
  const session = useSession();
  const navigate = useNavigate();
  const list = useTenantList();
  const usage = useUsageOverview();
  const { enter, activeTenantId } = useEnterTenant();
  const openSetup = useOpenTenantSetup();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<TenantItem | null>(null);
  const [search, setSearch] = React.useState("");

  const tenants = list.data ?? [];
  const health = useTenantHealths(tenants);
  const visible = filterTenants(tenants, search);
  const creationAllowed = canCreateTenant({
    tenantCount: tenants.length,
    additionalTenants: hasFeature(session, "tenants.additional"),
  });
  // The provider team role (lib/provider-role.ts): creating a tenant needs an
  // administrator with every tenant, deleting one an owner. The API refuses
  // the same either way; this only keeps the buttons away.
  const canCreate = creationAllowed && providerMay(session, "administrator", { everyTenant: true });
  const canDelete = providerMay(session, "owner");
  const refreshing = list.isFetching || usage.isFetching;

  // A `?new=1` link (the command palette's "New tenant" action, or any other
  // link into this page) opens the wizard on arrival; the param is stripped
  // right away, through the router, so a refresh or the back button does not
  // reopen it. The wizard opens only once another tenant may actually be
  // created (the same check the header button's `disabled` uses): otherwise
  // the link would let someone fill in all six steps only to be refused at
  // "Create tenant". The installation panel below always states the reason.
  const openWizardFromSearch = useOpenWizardFromSearch();
  React.useEffect(() => {
    if (!openWizardFromSearch || list.isPending) {
      return;
    }
    if (canCreate) {
      setCreateOpen(true);
    }
    void navigate({ to: tenantsListTo(), search: {} as never, replace: true });
  }, [openWizardFromSearch, list.isPending, canCreate, navigate]);

  let body: React.ReactNode;
  if (list.isPending) {
    body = <TableSkeleton />;
  } else if (list.isError) {
    body = (
      <ErrorState
        title={t("list.error")}
        error={list.error}
        onRetry={() => void list.refetch()}
        retrying={list.isFetching}
      />
    );
  } else if (tenants.length === 0) {
    body = <EmptyTenants onCreate={() => setCreateOpen(true)} canCreate={canCreate} />;
  } else {
    body = (
      <Card className="py-0">
        <CardContent className="space-y-4 p-4 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full sm:max-w-xs">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("list.searchPlaceholder")}
                aria-label={t("list.searchLabel")}
                className="pl-9"
              />
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {search.trim()
                ? t("list.matches", { count: visible.length, total: tenants.length })
                : t("list.count", { count: tenants.length })}
            </p>
          </div>
          {visible.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("list.noMatches", { query: search.trim() })}
            </p>
          ) : (
            <TenantTable
              tenants={visible}
              health={health}
              usage={usage.data}
              activeTenantId={activeTenantId}
              onEnter={enter}
              onOpenSetup={openSetup}
              onDelete={canDelete ? setDeleting : undefined}
            />
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("list.title")} description={t("list.subtitle")}>
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            void list.refetch();
            void usage.refetch();
          }}
          disabled={refreshing}
          aria-label={t("common:actions.refresh")}
          title={t("common:actions.refresh")}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
        </Button>
        <Button onClick={() => setCreateOpen(true)} disabled={!canCreate || list.isPending}>
          <Plus />
          {t("actions.create")}
        </Button>
      </PageHeader>

      {list.isSuccess ? (
        <InstallationPanel
          tenantCount={tenants.length}
          creationAllowed={creationAllowed}
          usage={{ status: usage.status, data: usage.data }}
        />
      ) : null}

      {body}

      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />
      {deleting ? (
        <DeleteTenantDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          tenant={deleting}
        />
      ) : null}
    </div>
  );
}

function EmptyTenants({ onCreate, canCreate }: { onCreate: () => void; canCreate: boolean }) {
  const { t } = useTranslation("tenants");
  return (
    <Card className="border-dashed py-0">
      <CardContent className="flex flex-col items-center gap-4 px-6 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Building2 aria-hidden="true" className="size-5" />
        </div>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-base font-semibold">{t("list.empty.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("list.empty.description")}</p>
        </div>
        <Button onClick={onCreate} disabled={!canCreate}>
          <Plus />
          {t("actions.createFirst")}
        </Button>
      </CardContent>
    </Card>
  );
}

function TableSkeleton() {
  const { t } = useTranslation("tenants");
  return (
    <Card>
      <CardContent aria-busy="true" className="space-y-4">
        <Skeleton className="h-9 w-full sm:max-w-xs" />
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-6">
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="hidden h-4 w-16 sm:block" />
            <Skeleton className="hidden h-4 w-24 lg:block" />
            <Skeleton className="hidden h-5 w-20 md:block" />
            <Skeleton className="h-8 w-28" />
          </div>
        ))}
        <span className="sr-only">{t("common:loading.label")}</span>
      </CardContent>
    </Card>
  );
}
