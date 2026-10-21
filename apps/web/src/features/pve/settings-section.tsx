import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import { fetchPveSettings, savePveSettings } from "./api.js";
import { PVE_NAMESPACE } from "./i18n.js";

const PVE_SETTINGS_KEY = ["installation", "pve-settings"] as const;

/**
 * The installation's Proxmox VE settings (docs/PVE.md, "Restore check"): whether every new
 * restore point is checked right after its backup (default on). Every provider admin reads
 * them; the owner changes them.
 */
export function PveSettingsSection() {
  const { t } = useTranslation(PVE_NAMESPACE);
  const session = useSession();
  const canChange = providerMay(session, "owner");
  const queryClient = useQueryClient();
  const id = React.useId();
  const query = useQuery({ queryKey: PVE_SETTINGS_KEY, queryFn: fetchPveSettings });
  const save = useMutation({
    mutationFn: savePveSettings,
    onSuccess: (data) => {
      queryClient.setQueryData(PVE_SETTINGS_KEY, data);
      toast.success(t("settings.saved"));
    },
    onError: (error) => toast.error((error as Error).message),
  });
  return (
    <Card data-slot="pve-settings">
      <CardHeader>
        <CardTitle className="text-base">{t("settings.title")}</CardTitle>
        <CardDescription>{t("settings.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <ErrorState
            title={t("settings.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : !query.data ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <label htmlFor={`${id}-after-backup`} className="text-sm font-medium">
                {t("settings.verifyAfterBackup")}
              </label>
              <p className="max-w-prose text-sm text-muted-foreground">
                {t("settings.verifyAfterBackupHint")}
              </p>
            </div>
            <Switch
              id={`${id}-after-backup`}
              checked={query.data.settings.verifyAfterBackup}
              disabled={!canChange || save.isPending}
              onCheckedChange={(checked) => save.mutate({ verifyAfterBackup: checked })}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
