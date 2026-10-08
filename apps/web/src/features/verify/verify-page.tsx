import { useNavigate, useSearch } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import * as React from "react";

import { ErrorState, PageHeader, RefreshButton, RelativeTime } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import type { ObjectReadiness, RunVerifyResult } from "@/features/verify/api";
import { AllTenantsReadiness } from "@/features/verify/components/all-tenants";
import { ObjectsTable } from "@/features/verify/components/objects-table";
import { StorageCard } from "@/features/verify/components/storage-card";
import { OverallBanner, SummaryTiles } from "@/features/verify/components/summary";
import { UnverifiedCallout } from "@/features/verify/components/unverified-callout";
import { VERIFY_ICON } from "@/features/verify/paths";
import {
  type Message,
  objectName,
  runResultMessage,
  startErrorMessage,
  unverifiedRunMessage,
} from "@/features/verify/presenters";
import { type ReadinessState, parseVerifySearch, verifyLink } from "@/features/verify/search";
import {
  useReadinessOverview,
  useStartVerify,
  useVerifyFormat,
} from "@/features/verify/use-verify";
import { sessionScope, useSession } from "@/lib/session";

function OverviewSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-16 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

/** What is about to be started: everything, the unverified backups, or one object. */
type Starting = { scope: "all" } | { scope: "unverified" } | { scope: "object"; objectId: string };

/**
 * Recovery readiness: can every protected object be restored today? The
 * weekly restore check rates each backup green, yellow or red with the date;
 * the storage check shows whether the pack files are intact. A backup no
 * check has read back yet, including one taken after a successful check, is
 * shown as not proven, never as fine.
 *
 * The address carries the filter: `?state=red` shows the objects in that state
 * (the chips set it), `?state=red&scope=all` the tenants that have objects in it,
 * which is also what the page is under "All tenants" (a link with `scope=all`
 * brings the session there).
 */
export function VerifyPage() {
  const session = useSession();
  const navigate = useNavigate();
  const search = parseVerifySearch(useSearch({ strict: false }) as Record<string, unknown>);
  const inAllTenants = sessionScope(session) === "all";
  const wantsAll = search.scope === "all" && session.canViewAllTenants === true;
  const { setScopeAll } = session;

  // An address made for "All tenants" brings the session into that scope.
  React.useEffect(() => {
    if (wantsAll && !inAllTenants) {
      setScopeAll?.();
    }
  }, [wantsAll, inAllTenants, setScopeAll]);

  // The state is part of the address; the scope stays while the session is under "All tenants".
  const setState = React.useCallback(
    (state: ReadinessState | undefined) =>
      void navigate({
        ...verifyLink(state, inAllTenants || wantsAll ? "all" : undefined),
        replace: true,
      } as never),
    [navigate, inAllTenants, wantsAll],
  );

  if (inAllTenants || wantsAll) {
    return <AllTenantsReadiness state={search.state} onStateChange={setState} />;
  }
  return <TenantReadiness state={search.state} onStateChange={setState} />;
}

function TenantReadiness({
  state,
  onStateChange,
}: {
  state: ReadinessState | undefined;
  onStateChange: (state: ReadinessState | undefined) => void;
}) {
  const format = useVerifyFormat();
  const { t } = format;
  const { activeTenant } = useSession();
  const overview = useReadinessOverview();
  const start = useStartVerify();
  const [starting, setStarting] = React.useState<Starting | null>(null);

  const showStartError = (error: unknown) => {
    const message = startErrorMessage(error);
    toast.error(t("toast.startFailed"), { description: t(message.key, message.values) });
  };

  const announce = (result: RunVerifyResult, message: Message) =>
    (result.queued.length > 0 ? toast.success : toast.info)(t(message.key, message.values));

  const checkAll = () => {
    setStarting({ scope: "all" });
    start.mutate(
      {},
      {
        onSuccess: (result) => announce(result, runResultMessage(result)),
        onError: showStartError,
        onSettled: () => setStarting(null),
      },
    );
  };

  const verifyUnverified = () => {
    setStarting({ scope: "unverified" });
    start.mutate(
      { unverifiedOnly: true },
      {
        onSuccess: (result) => announce(result, unverifiedRunMessage(result)),
        onError: showStartError,
        onSettled: () => setStarting(null),
      },
    );
  };

  const checkOne = (item: ObjectReadiness) => {
    setStarting({ scope: "object", objectId: item.object.id });
    start.mutate(
      { protectedObjectId: item.object.id },
      {
        onSuccess: () => toast.success(t("toast.checkStarted", { name: objectName(item.object) })),
        onError: showStartError,
        onSettled: () => setStarting(null),
      },
    );
  };

  const data = overview.data;
  const checkingAll = starting?.scope === "all";

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        icon={VERIFY_ICON}
        description={activeTenant ? t("tenantScope", { tenant: activeTenant.name }) : undefined}
      >
        <RefreshButton onRefresh={() => void overview.refetch()} fetching={overview.isFetching} />
        <Button
          size="sm"
          onClick={checkAll}
          loading={checkingAll}
          disabled={start.isPending || !data || data.summary.total === 0}
        >
          {checkingAll ? null : <ShieldCheck aria-hidden="true" />}
          {t("actions.checkAll")}
        </Button>
      </PageHeader>

      <p className="max-w-prose text-sm text-muted-foreground">{t("subtitle")}</p>

      {overview.isError ? (
        <ErrorState
          title={t("error.overview")}
          error={overview.error}
          onRetry={() => void overview.refetch()}
          retrying={overview.isFetching}
        />
      ) : !data ? (
        <OverviewSkeleton />
      ) : (
        <div className="space-y-6">
          <OverallBanner summary={data.summary} />
          <UnverifiedCallout
            items={data.objects}
            format={format}
            starting={starting?.scope === "unverified"}
            disabled={start.isPending}
            onVerify={verifyUnverified}
          />
          {data.summary.total > 0 ? <SummaryTiles summary={data.summary} format={format} /> : null}
          <StorageCard storage={data.storage} schedule={data.schedules.scrub} format={format} />
          <ObjectsTable
            items={data.objects}
            endpoints={data.endpoints ?? []}
            guests={data.guests ?? []}
            format={format}
            startingObjectId={starting?.scope === "object" ? starting.objectId : null}
            nextBackupAt={data.schedules.backup?.nextRunAt ?? null}
            onCheck={checkOne}
            state={state}
            onStateChange={onStateChange}
          />
          <p className="text-xs text-muted-foreground">
            {data.summary.lastCheckedAt ? (
              <>
                {t("footer.lastCheck")} <RelativeTime value={data.summary.lastCheckedAt} />.
              </>
            ) : (
              t("footer.neverChecked")
            )}{" "}
            {data.schedules.verify ? (
              data.schedules.verify.nextRunAt ? (
                <>
                  {t("footer.scheduleNext")}{" "}
                  <RelativeTime value={data.schedules.verify.nextRunAt} />.
                </>
              ) : (
                t("footer.scheduleEnabled")
              )
            ) : (
              t("footer.scheduleNone")
            )}
          </p>
        </div>
      )}
    </div>
  );
}
