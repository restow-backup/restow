import type * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { InstallationSettings } from "@/features/settings/api";
import { useInstallationSettings } from "@/features/settings/hooks";

/**
 * Loads the installation settings (`GET /api/v1/settings`) for the sections
 * that edit them and renders `children` with the loaded settings, with honest
 * loading and error states. The settings stay cached between sections.
 */
export function SettingsLoader({
  children,
}: {
  children: (settings: InstallationSettings) => React.ReactNode;
}) {
  const { t } = useTranslation("settings");
  const query = useInstallationSettings();
  if (query.isPending) {
    return <SettingsSkeleton />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title={t("loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <>{children(query.data)}</>;
}

export function SettingsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      {[0, 1].map((index) => (
        <Card key={index}>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-9 w-1/2" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
