import { Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import type { UpdatesView } from "./api";
import { ReleasesCard } from "./components/releases-card";
import { RunCard } from "./components/run-card";
import { SourceCard } from "./components/source-card";
import { UpdaterCard } from "./components/updater-card";
import { VersionCard } from "./components/version-card";
import { useUpdates } from "./hooks";
import "./i18n";
import { isMaintenanceActive } from "./presenters";

/**
 * The Updates tab of the settings page: the running version, what the update
 * check found, the release notes, installing an update (or why that is not
 * possible here) and the source settings.
 */
export function UpdatesSection() {
  const { t } = useTranslation("updates");
  const session = useSession();
  const query = useUpdates();

  if (query.isPending) {
    return <UpdatesSkeleton />;
  }
  if (query.isError && !query.data) {
    return (
      <ErrorState
        title={t("loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const view = query.data;
  if (!view) {
    return <UpdatesSkeleton />;
  }
  return (
    <UpdatesContent
      view={view}
      receivedAt={query.dataUpdatedAt}
      refreshFailed={query.isError}
      canManage={providerMay(session, "owner")}
    />
  );
}

/** The tab for a loaded view (the parts are pure functions of it). */
export function UpdatesContent({
  view,
  receivedAt,
  canManage,
  refreshFailed = false,
}: {
  view: UpdatesView;
  receivedAt: number;
  /** The viewer is the owner of the provider team, the role that may change updates. */
  canManage: boolean;
  /** The last refresh failed; the view shown is the last one that arrived. */
  refreshFailed?: boolean;
}) {
  const { t } = useTranslation("updates");
  // Everything that changes something needs the owner role, and nothing changes in the demo.
  const canChange = canManage && !view.demo;
  const active = isMaintenanceActive(view.maintenance.phase);

  return (
    <div className="space-y-6" data-slot="updates">
      {view.demo ? (
        <Alert variant="info" data-slot="access-note" data-reason="demo">
          <Info />
          <AlertDescription>{t("access.demo")}</AlertDescription>
        </Alert>
      ) : !canManage ? (
        <Alert variant="info" data-slot="access-note" data-reason="role">
          <Info />
          <AlertDescription>{t("access.role")}</AlertDescription>
        </Alert>
      ) : null}

      {refreshFailed ? (
        <Alert variant="warning" data-slot="refresh-failed">
          <TriangleAlert />
          <AlertDescription>
            {active ? t("refreshFailed.active") : t("refreshFailed.idle")}
          </AlertDescription>
        </Alert>
      ) : null}

      <VersionCard view={view} canChange={canChange} />
      <UpdaterCard view={view} canChange={canChange} receivedAt={receivedAt} />
      <RunCard view={view} canChange={canChange} />
      <ReleasesCard view={view} />
      <SourceCard view={view} canChange={canChange} />
    </div>
  );
}

function UpdatesSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" data-slot="updates-loading">
      {[0, 1, 2].map((index) => (
        <Card key={index}>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-9 w-1/2" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
