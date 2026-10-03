import { Link, useNavigate } from "@tanstack/react-router";
import {
  Boxes,
  Building2,
  Camera,
  FolderSearch,
  Mail,
  MailSearch,
  Search,
  Server,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, PageHeader, RestoreTimeline } from "@/components/kit";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ListedSnapshot, SnapshotObject } from "@/features/restore/api";
import { objectLabel } from "@/features/restore/explorer/entry-icon";
import { restorePointTime } from "@/features/restore/explorer/restore-point-label";
import { explorerAt } from "@/features/restore/navigation";
import { useSnapshotObjects, useSnapshots } from "@/features/restore/use-restore-data";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";
import { ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import type { EndpointSummary } from "./api.js";
import { SnapshotsTab } from "./components/snapshots-tab.js";
import { type EndpointFormat, useEndpoint, useEndpointFormat, useEndpoints } from "./hooks.js";
import {
  type FileRestoreSearch,
  type FileRestoreTarget,
  endpointDetailTo,
  fileRestoreMailboxTo,
  fileRestoreTo,
  inventoryTo,
} from "./paths.js";
import { endpointHostLine, endpointName } from "./presenters.js";

/**
 * File restore: choose a machine or a mailbox, then one of its restore
 * points. Both kinds show their restore points on the same timeline (newest
 * first, one separator per day, a jump to a date). For a machine the file
 * browser and restore dialog of its own page (tab Snapshots) sit next to it;
 * a mailbox's restore point opens in the restore explorer, which reads,
 * selects and restores mails, calendars and contacts. Side by side from the
 * extra-large breakpoint on: the searchable list (a quarter), then the
 * restore points and what is in the chosen one. The choice stays in the URL
 * (`?machine=` or `?mailbox=`); with a single machine or mailbox it is
 * chosen right away.
 */
export function FileRestorePage({
  machineId,
  mailboxId = null,
}: {
  machineId: string | null;
  mailboxId?: string | null;
}) {
  const { t } = useTranslation("endpoints");
  const { activeTenant } = useSession();
  const navigate = useNavigate();
  const machines = useEndpoints(undefined);
  const objects = useSnapshotObjects();
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
  // A mailbox list that cannot be loaded says so in its group; the machines still work.
  const mailboxes = mailboxesOf(objects.data ?? []);
  const settled = !machines.isPending && !objects.isPending;
  const only = settled ? onlyChoice(list, mailboxes) : null;
  const selectedMachine = machineId ?? (mailboxId === null ? (only?.machine ?? null) : null);
  const selectedMailbox = selectedMachine === null ? (mailboxId ?? only?.mailbox ?? null) : null;

  if (settled && list.length === 0 && mailboxes.length === 0 && !objects.isError) {
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

  const mailbox = mailboxes.find((candidate) => candidate.id === selectedMailbox) ?? null;

  return (
    <div className="space-y-6">
      {header}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,3fr)]">
        <SourcePicker
          machines={list}
          machinesPending={machines.isPending}
          mailboxes={mailboxes}
          mailboxesPending={objects.isPending}
          mailboxesError={objects.isError}
          onRetryMailboxes={() => void objects.refetch()}
          retryingMailboxes={objects.isFetching}
          selectedMachine={selectedMachine}
          selectedMailbox={selectedMailbox}
          onSelect={choose}
        />
        {selectedMachine ? (
          <MachineRestorePoints key={selectedMachine} machineId={selectedMachine} />
        ) : selectedMailbox && mailbox ? (
          <MailboxRestorePoints key={selectedMailbox} mailbox={mailbox} />
        ) : selectedMailbox && objects.isPending ? (
          <Skeleton className="h-64 w-full" aria-busy="true" />
        ) : selectedMailbox && !objects.isError ? (
          <EmptyState
            variant="plain"
            icon={MailSearch}
            title={t("fileRestore.mailbox.notFound.title")}
            description={t("fileRestore.mailbox.notFound.description")}
          />
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

/** Mailboxes among the protected objects of the tenant (not OneDrive), by name. */
export function mailboxesOf(objects: readonly SnapshotObject[]): SnapshotObject[] {
  return objects
    .filter((object) => object.kind === "mailbox" || object.kind === "imap")
    .sort((a, b) => objectLabel(a).localeCompare(objectLabel(b)));
}

/** The one machine or mailbox to choose right away, when there is exactly one of all. */
export function onlyChoice(
  machines: readonly Pick<EndpointSummary, "id">[],
  mailboxes: readonly Pick<SnapshotObject, "id">[],
): FileRestoreSearch | null {
  if (machines.length + mailboxes.length !== 1) {
    return null;
  }
  const machine = machines[0];
  if (machine) {
    return { machine: machine.id };
  }
  const mailbox = mailboxes[0];
  return mailbox ? { mailbox: mailbox.id } : null;
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

/** Whether `mailbox` matches the search text: name, address or owner. */
export function mailboxMatches(
  mailbox: Pick<SnapshotObject, "displayName" | "externalId" | "ownerEmail">,
  text: string,
): boolean {
  return matchesText([mailbox.displayName, mailbox.externalId, mailbox.ownerEmail], text);
}

const ROW_CLASS =
  "flex w-full flex-col gap-0.5 px-4 py-3 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset";

/**
 * The machines and the mailboxes of the tenant in one searchable list, in two
 * groups; a click opens the restore points of the one clicked.
 */
function SourcePicker({
  machines,
  machinesPending,
  mailboxes,
  mailboxesPending,
  mailboxesError,
  onRetryMailboxes,
  retryingMailboxes,
  selectedMachine,
  selectedMailbox,
  onSelect,
}: {
  machines: readonly EndpointSummary[];
  machinesPending: boolean;
  mailboxes: readonly SnapshotObject[];
  mailboxesPending: boolean;
  mailboxesError: boolean;
  onRetryMailboxes: () => void;
  retryingMailboxes: boolean;
  selectedMachine: string | null;
  selectedMailbox: string | null;
  onSelect: (target: FileRestoreTarget) => void;
}) {
  const format = useEndpointFormat();
  const { t } = format;
  const [text, setText] = React.useState("");
  const shownMachines = machines.filter((machine) => machineMatches(machine, text));
  const shownMailboxes = mailboxes.filter((mailbox) => mailboxMatches(mailbox, text));
  const searching = text.trim().length > 0;
  const nothing =
    searching &&
    !machinesPending &&
    !mailboxesPending &&
    shownMachines.length === 0 &&
    shownMailboxes.length === 0;

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
          <>
            <PickerGroup
              icon={Server}
              title={t("fileRestore.machines")}
              pending={machinesPending}
              hidden={searching && shownMachines.length === 0}
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
            <PickerGroup
              icon={Mail}
              title={t("fileRestore.mailboxes")}
              pending={mailboxesPending}
              hidden={searching && !mailboxesError && shownMailboxes.length === 0}
              slot="mailbox-list"
            >
              {mailboxesError ? (
                <li className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-muted-foreground">
                  <span>{t("fileRestore.mailboxesError")}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRetryMailboxes}
                    disabled={retryingMailboxes}
                  >
                    {t("common:actions.retry")}
                  </Button>
                </li>
              ) : shownMailboxes.length === 0 ? (
                <li className="px-4 py-3 text-xs text-muted-foreground">
                  {t("fileRestore.noMailboxes")}
                </li>
              ) : (
                shownMailboxes.map((mailbox) => (
                  <MailboxRow
                    key={mailbox.id}
                    mailbox={mailbox}
                    format={format}
                    selected={mailbox.id === selectedMailbox}
                    onSelect={() => onSelect(fileRestoreMailboxTo(mailbox.id))}
                  />
                ))
              )}
            </PickerGroup>
          </>
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

function MailboxRow({
  mailbox,
  format,
  selected,
  onSelect,
}: {
  mailbox: SnapshotObject;
  format: EndpointFormat;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = format;
  const name = objectLabel(mailbox);
  const address = mailbox.externalId !== name ? mailbox.externalId : null;
  const lastBackup = mailbox.latestSnapshotAt ? format.dateTime(mailbox.latestSnapshotAt) : null;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn(ROW_CLASS, selected && "bg-accent")}
      >
        <span className="truncate font-medium">{name}</span>
        {address ? <span className="truncate text-xs text-muted-foreground">{address}</span> : null}
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

const idOfRestorePoint = (point: ListedSnapshot) => point.id;
const timeOfRestorePoint = (point: ListedSnapshot) => restorePointTime(point);

/** What a mailbox's restore point shows below its time on the timeline. */
function MailboxPointDetails({ point }: { point: ListedSnapshot }) {
  const format = useEndpointFormat();
  const { t } = format;
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{t("fileRestore.mailbox.sequence", { sequence: point.sequence })}</span>
        <span>{t("fileRestore.mailbox.items", { count: point.itemCount })}</span>
        <span>{format.bytes(point.byteSize)}</span>
      </span>
      <span>
        <SnapshotVerificationBadge verification={point.verification} focusable={false} />
      </span>
    </>
  );
}

const renderRestorePoint = (point: ListedSnapshot) => <MailboxPointDetails point={point} />;

/**
 * The restore points of one mailbox on the timeline, and the chosen one with
 * the way into the restore explorer. The explorer is where mails, calendars
 * and contacts are browsed, read, selected and restored; duplicating it here
 * would give two places that do the same and drift apart, so the link opens
 * it at exactly this mailbox and restore point. The newest restore point is
 * chosen to begin with: unlike a machine's files, nothing is read before the
 * explorer opens.
 */
function MailboxRestorePoints({ mailbox }: { mailbox: SnapshotObject }) {
  const format = useEndpointFormat();
  const { t } = format;
  const points = useSnapshots(mailbox.id);
  const [pointId, setPointId] = React.useState<string | null>(null);
  const list = points.data ?? [];
  const point = list.find((item) => item.id === pointId) ?? list[0] ?? null;
  const name = objectLabel(mailbox);

  if (points.isError) {
    return (
      <ErrorState
        title={t("fileRestore.mailbox.loadError")}
        error={points.error}
        onRetry={() => void points.refetch()}
        retrying={points.isFetching}
      />
    );
  }
  if (points.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" aria-busy="true">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (list.length === 0 || point === null) {
    return (
      <EmptyState
        icon={Camera}
        title={t("fileRestore.mailbox.empty.title")}
        description={t("fileRestore.mailbox.empty.description")}
      />
    );
  }

  const explorer = explorerAt(mailbox.id, point.id);
  const time = format.dateTime(restorePointTime(point)) ?? restorePointTime(point);
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Card className="gap-0 overflow-hidden py-0" data-slot="mailbox-points-card">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-base">{t("snapshots.title")}</CardTitle>
          <CardDescription>
            {t("fileRestore.mailbox.description", { count: list.length })}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <RestoreTimeline
            items={list}
            idOf={idOfRestorePoint}
            timeOf={timeOfRestorePoint}
            selectedId={point.id}
            onSelect={(next) => setPointId(next.id)}
            renderDetails={renderRestorePoint}
            label={t("snapshots.timelineLabel", { name })}
            slot="mailbox-point-list"
          />
        </CardContent>
      </Card>

      <Card className="min-w-0 gap-0 py-0" data-slot="mailbox-point-card">
        <CardHeader className="gap-1 border-b py-4">
          <CardTitle className="text-base">
            {t("fileRestore.mailbox.chosen", { sequence: point.sequence, time })}
          </CardTitle>
          <CardDescription>{name}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 py-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t("fileRestore.mailbox.itemsLabel")}</dt>
            <dd>{format.integer(point.itemCount)}</dd>
            <dt className="text-muted-foreground">{t("fileRestore.mailbox.sizeLabel")}</dt>
            <dd>{format.bytes(point.byteSize)}</dd>
            <dt className="text-muted-foreground">{t("fileRestore.mailbox.verifiedLabel")}</dt>
            <dd>
              <SnapshotVerificationBadge verification={point.verification} />
            </dd>
          </dl>
          <p className="text-sm text-muted-foreground">{t("fileRestore.mailbox.explorerNote")}</p>
          <Link
            to={explorer.to}
            search={explorer.search as never}
            className={buttonVariants({ size: "sm" })}
            data-slot="open-explorer"
          >
            <MailSearch aria-hidden="true" />
            {t("fileRestore.mailbox.open")}
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
