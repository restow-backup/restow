import {
  Building,
  ChevronDown,
  Cloud,
  CopyPlus,
  HardDrive,
  Plus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyDialog } from "./components/copy-dialog";
import { DefaultTargetCard } from "./components/default-target-card";
import { DeleteTargetDialog } from "./components/delete-target-dialog";
import { type TargetAction, TargetCard } from "./components/target-card";
import { TargetDialog } from "./components/target-dialog";
import { UsageCard } from "./components/usage-card";
import { hasSecondLocation, primaryBlockedReason } from "./presenters";
import type { EditableKind, StorageTargetDto, StorageTargetList } from "./types";
import { useTargetList } from "./use-storage";

/** Which dialog is open, and for which target. */
type DialogState =
  | { kind: "create"; storageKind: EditableKind }
  | { kind: "edit"; target: StorageTargetDto }
  | { kind: "delete"; target: StorageTargetDto }
  | { kind: "promote"; target: StorageTargetDto }
  | { kind: "completeness"; target: StorageTargetDto }
  | null;

/**
 * Storage of the active tenant: usage and growth, the installation default
 * while it is the primary, and every configured target with its health and
 * WORM capability. Adding, editing, promoting and removing happen in dialogs.
 */
export function StoragePage() {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const { query, tenantId, tenantName, canManage } = useTargetList();
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const close = (open: boolean) => {
    if (!open) {
      setDialog(null);
    }
  };

  const onAction = (action: TargetAction, target: StorageTargetDto) => {
    setDialog({ kind: action, target });
  };

  const header = (
    <PageHeader
      title={t("title")}
      description={tenantName ? t("tenantScope", { tenant: tenantName }) : t("subtitle")}
    >
      {tenantId && canManage ? (
        <>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label={tc("actions.refresh")}
            title={tc("actions.refresh")}
          >
            <RefreshCw className={query.isFetching ? "animate-spin" : undefined} />
          </Button>
          <AddTargetMenu
            canManageLocal={query.data?.canManageLocal ?? false}
            onSelect={(storageKind) => setDialog({ kind: "create", storageKind })}
          />
        </>
      ) : null}
    </PageHeader>
  );

  let body: React.ReactNode;
  if (!tenantId) {
    body = (
      <Alert variant="info">
        <Building />
        <AlertTitle>{t("noTenant.title")}</AlertTitle>
        <AlertDescription>{t("noTenant.description")}</AlertDescription>
      </Alert>
    );
  } else if (!canManage) {
    body = (
      <Alert variant="warning">
        <ShieldAlert />
        <AlertTitle>{tc("errors.title")}</AlertTitle>
        <AlertDescription>{tc("errors.forbidden")}</AlertDescription>
      </Alert>
    );
  } else {
    body = (
      <>
        <UsageCard />
        <section className="space-y-4" aria-labelledby="storage-targets-heading">
          <div className="space-y-1">
            <h2 id="storage-targets-heading" className="text-lg font-semibold tracking-tight">
              {t("targets.title")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("targets.description")}</p>
          </div>
          {query.isPending ? (
            <TargetGridSkeleton />
          ) : query.isError ? (
            <ErrorState
              title={t("error.title")}
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : (
            <Targets
              list={query.data}
              onAction={onAction}
              onAddCopy={() => setDialog({ kind: "create", storageKind: "s3" })}
            />
          )}
        </section>
      </>
    );
  }

  const list = query.data;
  return (
    <div className="space-y-6">
      {header}
      {body}
      {list && dialog?.kind === "create" ? (
        <TargetDialog
          open
          onOpenChange={close}
          kind={dialog.storageKind}
          primaryBlocked={primaryBlockedReason(list)}
        />
      ) : null}
      {list && dialog?.kind === "edit" && dialog.target.kind !== "installation_default" ? (
        <TargetDialog
          open
          onOpenChange={close}
          kind={dialog.target.kind}
          target={dialog.target}
          primaryBlocked={null}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteTargetDialog open onOpenChange={close} target={dialog.target} />
      ) : null}
      {list && (dialog?.kind === "promote" || dialog?.kind === "completeness") ? (
        <CopyDialog
          open
          onOpenChange={close}
          target={dialog.target}
          mode={dialog.kind}
          fromInstallationDefault={list.installationDefault.inUse}
        />
      ) : null}
    </div>
  );
}

function Targets({
  list,
  onAction,
  onAddCopy,
}: {
  list: StorageTargetList;
  onAction: (action: TargetAction, target: StorageTargetDto) => void;
  onAddCopy: () => void;
}) {
  const { t } = useTranslation("storage");
  return (
    <div className="space-y-4">
      {hasSecondLocation(list) ? null : (
        <Alert variant="warning">
          <CopyPlus />
          <AlertTitle>{t("targets.singleLocation.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("targets.singleLocation.description")}</span>
            <Button variant="outline" size="sm" onClick={onAddCopy} className="shrink-0">
              <Plus />
              {t("actions.addCopy")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-4 *:min-w-0 md:grid-cols-2 xl:grid-cols-3">
        {list.installationDefault.inUse ? (
          <DefaultTargetCard installationDefault={list.installationDefault} />
        ) : null}
        {list.items.map((target) => (
          <TargetCard key={target.id} target={target} onAction={onAction} />
        ))}
      </div>
    </div>
  );
}

function AddTargetMenu({
  canManageLocal,
  onSelect,
}: {
  canManageLocal: boolean;
  onSelect: (kind: EditableKind) => void;
}) {
  const { t } = useTranslation("storage");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus />
          {t("actions.add")}
          <ChevronDown className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={() => onSelect("s3")}>
          <Cloud />
          {t("actions.addS3")}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canManageLocal} onSelect={() => onSelect("local")}>
          <HardDrive />
          <span className="flex flex-col">
            <span>{t("actions.addLocal")}</span>
            {canManageLocal ? null : (
              <span className="text-xs text-muted-foreground">
                {t("actions.localProviderOnly")}
              </span>
            )}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TargetGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1].map((index) => (
        <Card key={index} className="gap-3">
          <CardHeader className="flex flex-row items-start gap-3">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
