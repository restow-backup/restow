import { Building, KeyRound, Plus, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";

import { ConfirmDialog } from "../components/confirm-dialog";
import { useApiKeys, useIntegrationsScope, useProviderKeys, useRevokeApiKey } from "../hooks";
import { integrationErrorKey, visibleKeys } from "../presenters";
import type { ApiKey, ApiKeyKind } from "../types";
import { ApiKeyTable } from "./api-key-table";
import { CreateApiKeyDialog } from "./create-api-key-dialog";

/**
 * The API keys tab: the active tenant's keys and, for provider admins, the
 * installation's provider keys.
 */
export function ApiKeysPanel() {
  const { t } = useTranslation("integrations");
  const scope = useIntegrationsScope();
  return (
    <div className="space-y-6">
      {scope.tenantId === null ? (
        <Alert variant="info">
          <Building />
          <AlertTitle>{t("noTenant.title")}</AlertTitle>
          <AlertDescription>{t("noTenant.description")}</AlertDescription>
        </Alert>
      ) : scope.canManageTenant ? (
        <TenantKeys />
      ) : (
        <Alert variant="warning">
          <ShieldAlert />
          <AlertTitle>{t("noTenantAccess.title")}</AlertTitle>
          <AlertDescription>
            {t("noTenantAccess.description", { tenant: scope.tenantName ?? "" })}
          </AlertDescription>
        </Alert>
      )}
      {scope.isProviderAdmin ? <ProviderKeys /> : null}
      <p className="text-xs text-muted-foreground">{t("apiKeys.rateLimit")}</p>
    </div>
  );
}

function TenantKeys() {
  const { t } = useTranslation("integrations");
  const query = useApiKeys();
  return (
    <KeysCard
      kind="tenant"
      title={t("apiKeys.title")}
      description={t("apiKeys.description")}
      createLabel={t("apiKeys.create")}
      emptyTitle={t("apiKeys.empty.title")}
      emptyDescription={t("apiKeys.empty.description")}
      loadError={t("apiKeys.loadError")}
      keys={query.data}
      isLoading={query.isPending}
      error={query.error}
      retrying={query.isFetching}
      onRetry={() => void query.refetch()}
      canCreate
    />
  );
}

function ProviderKeys() {
  const { t } = useTranslation("integrations");
  const query = useProviderKeys();
  const available = query.data?.available ?? false;
  return (
    <KeysCard
      kind="provider"
      title={t("providerKeys.title")}
      description={t("providerKeys.description")}
      createLabel={t("providerKeys.create")}
      emptyTitle={t("providerKeys.empty.title")}
      emptyDescription={t("providerKeys.empty.description")}
      loadError={t("providerKeys.loadError")}
      keys={query.data?.items}
      isLoading={query.isPending}
      error={query.error}
      retrying={query.isFetching}
      onRetry={() => void query.refetch()}
      canCreate={available}
      notice={
        query.data && !available ? (
          <Alert variant="info">
            <ShieldAlert />
            <AlertTitle>{t("providerKeys.unavailable.title")}</AlertTitle>
            <AlertDescription>{t("providerKeys.unavailable.description")}</AlertDescription>
          </Alert>
        ) : null
      }
    />
  );
}

interface KeysCardProps {
  kind: ApiKeyKind;
  title: string;
  description: string;
  createLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  loadError: string;
  keys: ApiKey[] | undefined;
  isLoading: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  canCreate: boolean;
  notice?: React.ReactNode;
}

function KeysCard(props: KeysCardProps) {
  const { t } = useTranslation("integrations");
  const [creating, setCreating] = React.useState(false);
  const [revoking, setRevoking] = React.useState<ApiKey | null>(null);
  const [showRevoked, setShowRevoked] = React.useState(false);
  const revoke = useRevokeApiKey(props.kind);

  const all = props.keys ?? [];
  const keys = visibleKeys(all, showRevoked);
  const revokedCount = all.filter((key) => key.status === "revoked").length;
  const switchId = `show-revoked-${props.kind}`;

  const confirmRevoke = () => {
    if (!revoking) {
      return;
    }
    revoke.mutate(revoking.id, {
      onSuccess: () => {
        toast.success(t("toasts.keyRevoked"));
        setRevoking(null);
      },
      onError: (error) => {
        toast.error(t(integrationErrorKey(error)));
      },
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{props.description}</CardDescription>
        </div>
        <Button onClick={() => setCreating(true)} disabled={!props.canCreate} className="shrink-0">
          <Plus aria-hidden="true" />
          {props.createLabel}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.notice}
        {props.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : props.error ? (
          <ErrorState
            title={props.loadError}
            error={props.error}
            onRetry={props.onRetry}
            retrying={props.retrying}
          />
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <KeyRound className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium">{props.emptyTitle}</p>
            <p className="max-w-md text-sm text-muted-foreground">{props.emptyDescription}</p>
          </div>
        ) : (
          <ApiKeyTable keys={keys} onRevoke={setRevoking} />
        )}

        {revokedCount > 0 ? (
          <div className="flex items-center justify-end gap-2">
            <Switch id={switchId} checked={showRevoked} onCheckedChange={setShowRevoked} />
            <Label htmlFor={switchId} className="text-xs font-normal text-muted-foreground">
              {t("apiKeys.showRevoked")}
            </Label>
          </div>
        ) : null}
      </CardContent>

      <CreateApiKeyDialog kind={props.kind} open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
          }
        }}
        title={t("apiKeys.revokeConfirm.title")}
        description={t("apiKeys.revokeConfirm.description", {
          name: revoking?.name ?? "",
          prefix: revoking?.prefix ?? "",
        })}
        confirmLabel={t("apiKeys.revokeConfirm.confirm")}
        destructive
        pending={revoke.isPending}
        onConfirm={confirmRevoke}
      />
    </Card>
  );
}
