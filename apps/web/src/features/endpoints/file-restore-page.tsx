import { Link, useNavigate } from "@tanstack/react-router";
import { Boxes, Building2, FolderSearch } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, PageHeader } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

import { SnapshotsTab } from "./components/snapshots-tab.js";
import { useEndpoint, useEndpoints } from "./hooks.js";
import { FILE_RESTORE_PATH, endpointDetailTo, inventoryTo } from "./paths.js";
import { endpointHostLine, endpointName } from "./presenters.js";

/**
 * File restore: choose a machine, then one of its restore points, browse it
 * and restore or download files. The same browser and restore dialog as on
 * the machine's own page (tab Snapshots), reachable in one step from the menu.
 * The chosen machine stays in the URL (`?machine=`).
 */
export function FileRestorePage({ machineId }: { machineId: string | null }) {
  const { t } = useTranslation("endpoints");
  const { activeTenant } = useSession();
  const navigate = useNavigate();
  const machines = useEndpoints(undefined);
  const selectId = React.useId();

  const choose = (id: string) => {
    void navigate({
      to: FILE_RESTORE_PATH as never,
      search: { machine: id } as never,
      replace: true,
    });
  };

  const header = (
    <PageHeader title={t("fileRestore.title")} description={t("fileRestore.subtitle")} />
  );

  if (activeTenant === null) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Building2}
          title={t("list.noTenant.title")}
          description={t("fileRestore.noTenant")}
        />
      </div>
    );
  }
  if (machines.isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title={t("list.errors.load")}
          error={machines.error}
          onRetry={() => void machines.refetch()}
          retrying={machines.isFetching}
        />
      </div>
    );
  }

  const list = machines.data ?? [];
  if (!machines.isPending && list.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={Boxes}
          title={t("fileRestore.empty.title")}
          description={t("fileRestore.empty.description")}
          actions={
            <Link to={inventoryTo()} className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t("fileRestore.empty.action")}
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      <div className="max-w-md space-y-1.5">
        <Label htmlFor={selectId}>{t("fileRestore.machine")}</Label>
        <Select value={machineId ?? ""} onValueChange={choose} disabled={machines.isPending}>
          <SelectTrigger id={selectId} className="w-full">
            <SelectValue placeholder={t("fileRestore.choose")} />
          </SelectTrigger>
          <SelectContent>
            {list.map((machine) => {
              const host = endpointHostLine(machine);
              return (
                <SelectItem key={machine.id} value={machine.id}>
                  {endpointName(machine)}
                  {host ? ` (${host})` : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      {machineId ? (
        <MachineRestorePoints key={machineId} machineId={machineId} />
      ) : (
        <EmptyState
          variant="plain"
          icon={FolderSearch}
          title={t("fileRestore.pick.title")}
          description={t("fileRestore.pick.description")}
        />
      )}
    </div>
  );
}

/** The restore points, file browser and restore of one machine. */
function MachineRestorePoints({ machineId }: { machineId: string }) {
  const { t } = useTranslation("endpoints");
  const navigate = useNavigate();
  const query = useEndpoint(machineId);

  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <ErrorState
        title={missing ? t("detail.notFound") : t("detail.loadError")}
        description={missing ? t("detail.notFoundDescription") : undefined}
        error={query.error}
        onRetry={missing ? undefined : () => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  if (!query.data) {
    return <Skeleton className="h-64 w-full" aria-busy="true" />;
  }
  return (
    <SnapshotsTab
      detail={query.data}
      onShowOverview={() => void navigate({ to: endpointDetailTo(machineId) })}
    />
  );
}
