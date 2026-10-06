import { Link, useNavigate } from "@tanstack/react-router";
import { Boxes, Building2, FolderSearch, Search, Server } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, PageHeader } from "@/components/kit";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import type { EndpointSummary } from "./api.js";
import { SnapshotsTab } from "./components/snapshots-tab.js";
import { type EndpointFormat, useEndpoint, useEndpointFormat, useEndpoints } from "./hooks.js";
import { type FileRestoreTarget, endpointDetailTo, fileRestoreTo, inventoryTo } from "./paths.js";
import { endpointHostLine, endpointName } from "./presenters.js";

/**
 * File restore of servers and clients: choose a machine, then one of its
 * restore points; the file browser and restore dialog of its own page (tab
 * Snapshots) sit next to the timeline. Machines only: mailboxes, OneDrives
 * and IMAP accounts are restored in the restore explorer (Mail & SaaS).
 * Side by side from the extra-large breakpoint on: the searchable list (a
 * quarter), then the restore points and what is in the chosen one. The choice
 * stays in the URL (`?machine=`); with a single machine it is chosen right away.
 */
export function FileRestorePage({ machineId }: { machineId: string | null }) {
  const { t } = useTranslation("endpoints");
  const { activeTenant } = useSession();
  const navigate = useNavigate();
  const machines = useEndpoints(undefined);
  const choose = (target: FileRestoreTarget) => {
    void navigate({ to: target.to, search: target.search as never, replace: true });
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
  const selectedMachine = machineId ?? (!machines.isPending ? onlyMachine(list) : null);

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
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <MachinePicker
          machines={list}
          machinesPending={machines.isPending}
          selectedMachine={selectedMachine}
          onSelect={choose}
        />
        {selectedMachine ? (
          <MachineRestorePoints key={selectedMachine} machineId={selectedMachine} />
        ) : (
          <EmptyState
            variant="plain"
            icon={FolderSearch}
            title={t("fileRestore.pick.title")}
            description={t("fileRestore.pick.description")}
          />
        )}
      </div>
    </div>
  );
}

/** The one machine to choose right away, when the tenant has exactly one. */
export function onlyMachine(machines: readonly Pick<EndpointSummary, "id">[]): string | null {
  return machines.length === 1 ? (machines[0]?.id ?? null) : null;
}

function matchesText(values: readonly (string | null | undefined)[], text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return values.some((value) => (value ?? "").toLowerCase().includes(needle));
}

/** Whether `machine` matches the search text: name, host name or label. */
export function machineMatches(machine: EndpointSummary, text: string): boolean {
  return matchesText([machine.displayName, machine.hostname], text);
}

const ROW_CLASS =
  "flex w-full flex-col gap-0.5 px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset";

/** The machines of the tenant in one searchable list; a click opens the restore points of the one clicked. */
function MachinePicker({
  machines,
  machinesPending,
  selectedMachine,
  onSelect,
}: {
  machines: readonly EndpointSummary[];
  machinesPending: boolean;
  selectedMachine: string | null;
  onSelect: (target: FileRestoreTarget) => void;
}) {
  const format = useEndpointFormat();
  const { t } = format;
  const [text, setText] = React.useState("");
  const shownMachines = machines.filter((machine) => machineMatches(machine, text));
  const nothing = text.trim().length > 0 && !machinesPending && shownMachines.length === 0;

  return (
    <Card className="gap-0 overflow-hidden py-0" data-slot="machine-picker">
      <CardHeader className="gap-3 border-b py-4">
        <CardTitle className="text-base">{t("fileRestore.sources")}</CardTitle>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("fileRestore.search")}
            aria-label={t("fileRestore.search")}
            className="pl-9"
          />
        </div>
      </CardHeader>
      <CardContent className="max-h-96 overflow-y-auto p-0 xl:max-h-[40rem]">
        {nothing ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t("fileRestore.noMatch")}</p>
        ) : (
          <PickerGroup
            icon={Server}
            title={t("fileRestore.machines")}
            pending={machinesPending}
            hidden={false}
            slot="machine-list"
          >
            {shownMachines.length === 0 ? (
              <li className="px-4 py-3 text-xs text-muted-foreground">
                {t("fileRestore.noMachines")}
              </li>
            ) : (
              shownMachines.map((machine) => (
                <MachineRow
                  key={machine.id}
                  machine={machine}
                  format={format}
                  selected={machine.id === selectedMachine}
                  onSelect={() => onSelect(fileRestoreTo(machine.id))}
                />
              ))
            )}
          </PickerGroup>
        )}
      </CardContent>
    </Card>
  );
}

function PickerGroup({
  icon: Icon,
  title,
  pending,
  hidden,
  slot,
  children,
}: {
  icon: typeof Server;
  title: string;
  pending: boolean;
  hidden: boolean;
  slot: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  if (hidden) {
    return null;
  }
  return (
    <section aria-labelledby={id}>
      <h3
        id={id}
        className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/95 px-4 py-1.5 text-xs font-medium text-muted-foreground"
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {title}
      </h3>
      {pending ? (
        <div className="space-y-2 p-4" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <ul className="divide-y border-b" data-slot={slot}>
          {children}
        </ul>
      )}
    </section>
  );
}

function MachineRow({
  machine,
  format,
  selected,
  onSelect,
}: {
  machine: EndpointSummary;
  format: EndpointFormat;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = format;
  const host = endpointHostLine(machine);
  const lastBackup = machine.lastBackupAt ? format.dateTime(machine.lastBackupAt) : null;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(ROW_CLASS, selected && "bg-accent")}
      >
        <span className="truncate font-medium">{endpointName(machine)}</span>
        {host ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{host}</span>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {lastBackup
            ? t("fileRestore.lastBackup", { time: lastBackup })
            : t("fileRestore.noBackup")}
        </span>
      </button>
    </li>
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
