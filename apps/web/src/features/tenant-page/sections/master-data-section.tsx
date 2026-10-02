import { Pencil, Shield } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { SetInInstallation } from "@/components/kit/set-in-installation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { installationSectionPath } from "@/features/installation/paths";
import { useWordingScope } from "@/features/installation/scope";
import { useTargetList } from "@/features/storage/use-storage";
import { CustomerDataPanel } from "@/features/tenants/components/customer-data-panel";
import { EditTenantDialog } from "@/features/tenants/components/edit-tenant-dialog";
import { MarkOwnOrganisationDialog } from "@/features/tenants/components/own-organisation-dialogs";
import { useTenantDetail } from "@/features/tenants/hooks";
import type { TenantDetail } from "@/features/tenants/types";
import { setupStateQueryOptions } from "@/lib/api";
import type { TenantSectionProps } from "@/lib/extensions";
import { providerMay } from "@/lib/provider-role";
import { hasFeature, useSession } from "@/lib/session";
import { useQuery } from "@tanstack/react-query";

/**
 * Master data of the tenant: its name, customer number, language, time zone,
 * address and contacts, and whether it is the operator's own organisation.
 * They are the provider's to keep; a tenant's own administrator reads them and
 * is told whom to ask. What the installation decides for every tenant (the
 * public address, the default storage) is shown here read-only, with where it
 * is set.
 */
export function MasterDataSection({ tenant }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  const detail = useTenantDetail(tenant.id);

  if (detail.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (detail.isError || !detail.data) {
    return (
      <ErrorState
        title={t("masterData.loadError")}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
      />
    );
  }
  return <MasterData tenant={detail.data} />;
}

function MasterData({ tenant }: { tenant: TenantDetail }) {
  const { t } = useTranslation("tenantpage");
  const session = useSession();
  const scope = useWordingScope();
  // Changing master data is the provider's, at the Administrator role of the provider team.
  const mayChange = providerMay(session, "administrator") && tenant.status !== "deleting";
  const [editing, setEditing] = React.useState(false);

  return (
    <div className="space-y-6">
      {mayChange ? null : (
        <Alert variant="info" data-slot="master-data-hint">
          <Shield />
          <AlertDescription>
            {session.isProviderAdmin ? t("masterData.hint.role") : t("masterData.hint.tenantAdmin")}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle>{t("masterData.identity.title")}</CardTitle>
            <CardDescription>{t("masterData.identity.description", { scope })}</CardDescription>
          </div>
          {mayChange ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil />
              {t("masterData.identity.edit")}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <Fact label={t("masterData.identity.name")} value={tenant.name} />
            <Fact label={t("masterData.identity.slug")} value={tenant.slug} mono />
            <Fact
              label={t("masterData.identity.cap")}
              value={
                tenant.mailboxCap === null
                  ? t("masterData.identity.noCap")
                  : String(tenant.mailboxCap)
              }
            />
          </dl>
        </CardContent>
      </Card>

      <CustomerDataPanel tenant={tenant} readOnly={!mayChange} />

      <OwnOrganisationCard tenant={tenant} mayChange={mayChange} />

      <InstallationValues />

      <EditTenantDialog open={editing} onOpenChange={setEditing} tenant={tenant} />
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono" : undefined}>{value}</dd>
    </div>
  );
}

/**
 * Whether the tenant is the operator's own organisation. Where tenants are
 * managed, a customer can be marked as it (once, and only while no other tenant
 * is); the one organisation of an installation without tenant management has no
 * such question.
 */
function OwnOrganisationCard({
  tenant,
  mayChange,
}: {
  tenant: TenantDetail;
  mayChange: boolean;
}) {
  const { t } = useTranslation("tenantpage");
  const session = useSession();
  const [marking, setMarking] = React.useState(false);
  if (!hasFeature(session, "tenants.additional")) {
    return null;
  }
  const internal = tenant.kind === "internal";
  const taken = session.tenants.some((candidate) => candidate.kind === "internal");
  const canMark = mayChange && providerMay(session, "administrator", { everyTenant: true });
  if (!internal && (taken || !canMark)) {
    return null;
  }
  return (
    <Card data-slot="own-organisation">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            {t("masterData.own.title")}
            {internal ? <Badge variant="outline">{t("masterData.own.badge")}</Badge> : null}
          </CardTitle>
          <CardDescription>
            {internal ? t("masterData.own.isOwn") : t("masterData.own.markDescription")}
          </CardDescription>
        </div>
        {internal ? null : (
          <Button variant="outline" size="sm" onClick={() => setMarking(true)}>
            {t("masterData.own.mark")}
          </Button>
        )}
      </CardHeader>
      {internal ? null : (
        <MarkOwnOrganisationDialog
          open={marking}
          onOpenChange={setMarking}
          choices={[{ id: tenant.id, name: tenant.name, customerNumber: tenant.customerNumber }]}
        />
      )}
    </Card>
  );
}

/** What the installation decides for every tenant, read-only here. */
function InstallationValues() {
  const { t } = useTranslation("tenantpage");
  const scope = useWordingScope();
  const { t: ts } = useTranslation("installation");
  const { data: setup } = useQuery(setupStateQueryOptions);
  const { query: targets } = useTargetList();
  const defaultStorage = targets.data?.installationDefault;

  return (
    <Card data-slot="installation-values">
      <CardHeader>
        <CardTitle>{t("masterData.installation.title")}</CardTitle>
        <CardDescription>{t("masterData.installation.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("masterData.installation.publicUrl")}</p>
          <p className="break-all font-mono text-sm">
            {setup?.publicUrl ?? t("masterData.installation.publicUrlNone")}
          </p>
          <SetInInstallation
            to={installationSectionPath("server")}
            sectionLabel={ts("sections.server")}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {t("masterData.installation.defaultStorage")}
          </p>
          <p className="text-sm">
            {targets.isPending
              ? "…"
              : !defaultStorage || defaultStorage.kind === null
                ? t("masterData.installation.defaultStorageNone")
                : defaultStorage.inUse
                  ? t("masterData.installation.defaultStorageUsed", {
                      kind: defaultStorage.kind,
                      scope,
                    })
                  : t("masterData.installation.defaultStorageUnused", { scope })}
          </p>
          <SetInInstallation
            to={installationSectionPath("default-storage")}
            sectionLabel={ts("sections.defaultStorage")}
          />
        </div>
      </CardContent>
    </Card>
  );
}
