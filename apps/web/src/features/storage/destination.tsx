import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Database, HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import { activeTenantPageTo, tenantPageTo } from "@/lib/tenant-paths";

import { storageKeys } from "./api";
import { STORAGE_NAMESPACE } from "./i18n";

/**
 * Where backups land right now (GET /api/v1/storage/destination, docs/STORAGE.md "Where
 * backups land"): the tenant's primary repository, or the installation default. Shown wherever
 * a backup of a container, machine or file share is started or configured, and as a warning
 * where backups would land on a disk of the server itself.
 */
export interface BackupDestination {
  targetId: string | null;
  name: string | null;
  installationDefault: boolean;
  kind: "local" | "s3" | null;
  /** A path or `s3://bucket/prefix (host)`; null for the installation default below provider admins. */
  location: string | null;
  onServerDisk: boolean;
  /**
   * A directory on the server's system disk, under the operating system, Docker and the
   * database (0.4.5): backups that fill it stop the whole server. Absent from an older server.
   */
  onSystemDisk?: boolean;
  misconfigured: boolean;
}

export function fetchBackupDestination(): Promise<BackupDestination> {
  return apiFetch<BackupDestination>("/storage/destination");
}

/**
 * The destination of the active tenant, for administrators (others see nothing, and nothing is
 * asked).
 */
export function useBackupDestination() {
  const session = useSession();
  const tenantId = session.activeTenant?.id ?? null;
  const canManage = session.isProviderAdmin || session.activeTenant?.role === "tenant_admin";
  const enabled = session.status === "authenticated" && tenantId !== null && canManage;
  return useQuery({
    queryKey: [...storageKeys.all(tenantId), "destination"] as const,
    queryFn: fetchBackupDestination,
    enabled,
    staleTime: 60_000,
  });
}

/** How the destination reads in one line: name, kind and where. */
export function destinationLabel(
  destination: BackupDestination,
  t: (key: string, options?: Record<string, unknown>) => string,
): { name: string; kind: string | null; location: string | null } {
  const name = destination.installationDefault
    ? destination.kind === "local"
      ? t("destination.installationDefaultLocal")
      : t("destination.installationDefault")
    : (destination.name ?? t("destination.unnamed"));
  return {
    name,
    kind: destination.kind ? t(`destination.kind.${destination.kind}`) : null,
    location: destination.location,
  };
}

/**
 * "Backups land in: …" — the repository a backup started or configured here writes to. The
 * installation default on the server's local disk is highlighted.
 */
export function BackupDestinationNote({
  className,
  destination: given,
}: {
  className?: string;
  /** Given by a caller that already loaded it (tests); else loaded here. */
  destination?: BackupDestination;
}) {
  const { t } = useTranslation(STORAGE_NAMESPACE);
  const query = useBackupDestination();
  const destination = given ?? query.data;
  if (!destination) {
    return null;
  }
  if (destination.misconfigured) {
    return (
      <p className={cn("text-sm text-destructive-text", className)} data-slot="backup-destination">
        {t("destination.misconfigured")}
      </p>
    );
  }
  const label = destinationLabel(destination, t);
  const highlighted = destination.installationDefault && destination.kind === "local";
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground",
        className,
      )}
      data-slot="backup-destination"
    >
      <Database aria-hidden="true" className="size-4 shrink-0" />
      <span>{t("destination.lead")}</span>
      {highlighted ? (
        <Badge variant="warning" data-slot="backup-destination-default">
          {label.name}
        </Badge>
      ) : (
        <span className="font-medium text-foreground">{label.name}</span>
      )}
      {label.kind ? <span>· {label.kind}</span> : null}
      {label.location ? (
        <span className="break-all font-mono text-xs" title={label.location}>
          · {label.location}
        </span>
      ) : null}
      {destination.onSystemDisk ? (
        <Badge
          variant="warning"
          data-slot="backup-destination-system-disk"
          title={t("destination.systemDisk.description")}
        >
          {t("destination.systemDisk.badge")}
        </Badge>
      ) : null}
    </p>
  );
}

/**
 * "Backups land on the server's own disk": the effective primary is a directory on a disk of
 * the server itself (the installation default in the app volume, say), so a failure of the
 * server takes the backups with it. Links to the repositories page to choose another one.
 */
export function ServerDiskWarning({
  className,
  destination: given,
}: {
  className?: string;
  destination?: BackupDestination;
}) {
  const { t } = useTranslation(STORAGE_NAMESPACE);
  const session = useSession();
  const query = useBackupDestination();
  const destination = given ?? query.data;
  if (!destination?.onServerDisk && !destination?.onSystemDisk) {
    return null;
  }
  const systemDisk = destination.onSystemDisk === true;
  // The Repositories section of the tenant whose backups these are.
  const repositories = session.activeTenant
    ? tenantPageTo(session.activeTenant.id, "storage")
    : activeTenantPageTo("storage");
  return (
    <Alert variant="warning" className={className} data-slot="server-disk-warning">
      <HardDrive />
      <AlertTitle>
        {t(systemDisk ? "destination.systemDisk.title" : "destination.serverDisk.title")}
      </AlertTitle>
      <AlertDescription className="space-y-1">
        <span className="block">
          {t(
            destination.installationDefault
              ? "destination.serverDisk.descriptionDefault"
              : "destination.serverDisk.description",
            { name: destination.name ?? "" },
          )}
        </span>
        {systemDisk ? (
          <span className="block" data-slot="system-disk-warning">
            {t("destination.systemDisk.description")}
          </span>
        ) : null}
        <Link to={repositories} className="font-medium underline">
          {t("destination.serverDisk.choose")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
