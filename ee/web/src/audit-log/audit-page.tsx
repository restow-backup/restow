import { Building, ScrollText, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { ChainBrokenAlert, ChainDialog, ChainStatusButton } from "./components/chain-status";
import { AuditEntriesTable } from "./components/entries-table";
import { AuditEntrySheet } from "./components/entry-sheet";
import { AuditFilters } from "./components/filters";
import {
  type AuditAccess,
  useAuditAccess,
  useAuditActions,
  useAuditEntries,
  useAuditEntry,
  useAuditFormat,
  useAuditSearch,
  useChainVerification,
} from "./hooks";
import { AUDIT_NAMESPACE } from "./i18n";
import { hasFilters } from "./search";

/** Roles that may open the audit log (the API enforces the same). */
export const AUDIT_ROLES = ["provider_admin", "tenant_admin"] as const;

/**
 * The audit log: every recorded action, filterable and linkable, with the
 * integrity of the hash chain stated up front and each entry's details and
 * hashes one click away.
 */
export function AuditPage() {
  return (
    <RequireRole roles={AUDIT_ROLES}>
      <AuditPageContent />
    </RequireRole>
  );
}

function AuditPageContent() {
  const { t } = useTranslation(AUDIT_NAMESPACE);
  const access = useAuditAccess();

  switch (access.kind) {
    case "loading":
      return (
        <div className="space-y-6">
          <PageHeader title={t("title")} />
          <ListSkeleton />
        </div>
      );
    case "noTenant":
      return (
        <div className="space-y-6">
          <PageHeader title={t("title")} />
          <Alert variant="info">
            <Building />
            <AlertTitle>{t("noTenant.title")}</AlertTitle>
            <AlertDescription>{t("noTenant.description")}</AlertDescription>
          </Alert>
        </div>
      );
    case "notAdmin":
      return (
        <div className="space-y-6">
          <PageHeader title={t("title")} />
          <Alert variant="warning">
            <ShieldAlert />
            <AlertTitle>{t("notAdmin.title")}</AlertTitle>
            <AlertDescription>
              {t("notAdmin.description", { tenant: access.tenantName })}
            </AlertDescription>
          </Alert>
        </div>
      );
    default:
      return <AuditLog access={access} />;
  }
}

function ListSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </CardContent>
    </Card>
  );
}

function AuditLog({ access }: { access: Extract<AuditAccess, { kind: "provider" | "tenant" }> }) {
  const format = useAuditFormat();
  const { t } = format;
  const { tenants } = useSession();
  const { search, update, clearFilters } = useAuditSearch();
  const isProvider = access.kind === "provider";
  const chainFilter = isProvider ? search.tenant : undefined;

  const { list, entries } = useAuditEntries(access, search);
  const actions = useAuditActions(access, chainFilter);
  const verification = useChainVerification(access, chainFilter);
  const listed = search.entry ? entries.find((entry) => entry.id === search.entry) : undefined;
  const lookup = useAuditEntry(access, search.entry, listed !== undefined);

  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const filtered = hasFilters(search, isProvider);
  // The tenant column only helps while several chains are listed together.
  const showTenant = isProvider && search.tenant === undefined;
  const openEntry = React.useCallback((entryId: string) => update({ entry: entryId }), [update]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={
          access.kind === "provider"
            ? t("subtitle.provider")
            : t("subtitle.tenant", { tenant: access.tenantName })
        }
      >
        <ChainStatusButton
          verification={verification}
          format={format}
          onOpen={() => setDetailsOpen(true)}
        />
        <Button
          variant="outline"
          onClick={() => void verification.refetch()}
          loading={verification.isFetching}
        >
          {t("chain.verifyNow")}
        </Button>
      </PageHeader>

      {verification.data?.status === "broken" && !verification.isFetching ? (
        <ChainBrokenAlert
          verification={verification.data}
          format={format}
          onShowEntry={openEntry}
          onOpenDetails={() => setDetailsOpen(true)}
        />
      ) : null}

      <AuditFilters
        search={search}
        showTenantFilter={isProvider}
        tenants={tenants}
        actions={actions.data ?? []}
        filtered={filtered}
        format={format}
        onChange={update}
        onClear={clearFilters}
      />

      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError ? (
        <ErrorState
          title={t("table.loadError")}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : entries.length === 0 ? (
        <Card className="py-0">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <ScrollText className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium">
              {filtered ? t("table.emptyFiltered.title") : t("table.empty.title")}
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              {filtered ? t("table.emptyFiltered.description") : t("table.empty.description")}
            </p>
            {filtered ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                {t("filters.clear")}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <AuditEntriesTable
            entries={entries}
            showTenant={showTenant}
            selectedId={search.entry}
            format={format}
            onOpen={openEntry}
          />
        </Card>
      )}

      {list.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => void list.fetchNextPage()}
            loading={list.isFetchingNextPage}
          >
            {t("table.loadMore")}
          </Button>
        </div>
      ) : null}

      <AuditEntrySheet
        open={search.entry !== undefined}
        entry={listed ?? lookup.data}
        lookup={lookup}
        showTenant={isProvider}
        format={format}
        onClose={() => update({ entry: undefined })}
      />

      <ChainDialog
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        verification={verification}
        format={format}
        onShowEntry={(entryId) => {
          setDetailsOpen(false);
          openEntry(entryId);
        }}
      />
    </div>
  );
}
