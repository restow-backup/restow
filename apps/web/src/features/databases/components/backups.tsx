import { Download, FileText, History, KeyRound, Play, RotateCcw } from "lucide-react";
import * as React from "react";

import { EmptyState, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

import { downloadFile } from "../../stats/download.js";
import {
  backupDownloadPath,
  type DbBackup,
  type DbConnection,
  globalsDownloadPath,
  restoreGuidePath,
} from "../api.js";
import {
  type DbFormat,
  useConnectionGlobals,
  useConnections,
  useDatabaseBackups,
  useRequestBackup,
  useRequestRestore,
} from "../hooks.js";
import { problemKey } from "./add-connection-dialog.js";

/** The engines with backups and restores (D3 PostgreSQL, D4 MySQL and MariaDB). */
const BACKUP_ENGINES = new Set(["postgresql", "mysql", "mariadb"]);

/**
 * A new database's name (docs/DATABASES.md 16 "D3" O3, "D4" M3): no control characters, no outer
 * blanks; PostgreSQL at most 63 bytes, MySQL and MariaDB 1 to 64 characters of the BMP.
 */
export function restoreNameValid(name: string, engine = "postgresql"): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  if (name.length === 0 || name.trim() !== name || /[\u0000-\u001f\u007f]/.test(name)) {
    return false;
  }
  if (engine === "mysql" || engine === "mariadb") {
    const chars = [...name];
    return chars.length <= 64 && chars.every((char) => (char.codePointAt(0) ?? 0) <= 0xffff);
  }
  return new TextEncoder().encode(name).length <= 63;
}

/**
 * The backups of a database (docs/DATABASES.md 2.3, 7.1, D3): when, how large, SHA-256, with
 * "Jetzt sichern", "Wiederherstellen" (always into a new database), "Herunterladen" and the
 * restore guide. Administrators start runs; restore operators read and download. The globals of
 * the connection (roles with their password hashes) are listed and downloaded by administrators
 * only.
 */
export function DatabaseBackupsCard({
  databaseId,
  databaseName,
  engine,
  connectionId,
  admin,
  format,
  platformUnsupported = false,
}: {
  databaseId: string;
  databaseName: string;
  engine: string;
  connectionId: string;
  admin: boolean;
  format: DbFormat;
  /** The executor cannot back up this engine yet (an agent on Windows, E7). */
  platformUnsupported?: boolean;
}) {
  const { t } = format;
  const backups = useDatabaseBackups(databaseId);
  const globals = useConnectionGlobals(connectionId, admin);
  const backup = useRequestBackup(databaseId);
  const [restoring, setRestoring] = React.useState<DbBackup | null>(null);
  const [downloadError, setDownloadError] = React.useState<unknown>(null);
  const supported = BACKUP_ENGINES.has(engine) && !platformUnsupported;
  const mysql = engine === "mysql" || engine === "mariadb";
  const globalsFile = mysql ? "users.sql" : "globals.sql";
  const download = async (row: DbBackup, kind: "dump" | "guide" | "globals") => {
    setDownloadError(null);
    try {
      await downloadFile({
        path:
          kind === "guide"
            ? restoreGuidePath(databaseId, row.id)
            : kind === "globals"
              ? globalsDownloadPath(connectionId, row.id)
              : backupDownloadPath(databaseId, row.id),
        accept: kind === "guide" ? "text/plain" : "application/octet-stream",
        fallbackName:
          kind === "guide"
            ? `${databaseName}-restore-guide.txt`
            : kind === "globals"
              ? globalsFile
              : `${databaseName}.${mysql ? "sql" : "pgdump"}`,
      });
    } catch (error) {
      setDownloadError(error);
    }
  };
  const rows = backups.data?.backups ?? [];
  const latestGlobals = admin ? (globals.data?.backups ?? []).slice(0, 3) : [];
  return (
    <Card data-slot="database-backups">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("backups.title")}</CardTitle>
          <CardDescription>{t("backups.description")}</CardDescription>
        </div>
        {admin && supported ? (
          <Button size="sm" onClick={() => backup.mutate()} disabled={backup.isPending}>
            <Play aria-hidden="true" />
            {t("backups.now")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {platformUnsupported ? (
          <Alert data-slot="database-platform-unsupported">
            <AlertTitle>{t("backups.platformUnsupported")}</AlertTitle>
          </Alert>
        ) : null}
        {backup.isSuccess ? (
          <Alert>
            <AlertTitle>{t("backups.queued")}</AlertTitle>
          </Alert>
        ) : null}
        {backup.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{t(problemKey(backup.error))}</AlertTitle>
          </Alert>
        ) : null}
        {downloadError ? (
          <Alert variant="destructive">
            <AlertTitle>{t("backups.downloadFailed")}</AlertTitle>
          </Alert>
        ) : null}
        {backups.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={History}
            title={t("database.noBackups.title")}
            description={t(supported ? "backups.none" : "database.noBackups.description")}
          />
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="space-y-0.5 text-sm">
                  <div className="font-medium">{format.dateTime(row.finishedAt)}</div>
                  <div className="text-muted-foreground">
                    {format.bytes(row.bytes)} · SHA-256 {row.sha256.slice(0, 16)}… ·{" "}
                    {t("backups.snapshot", { id: row.snapshotId.slice(0, 8) })}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <StatusBadge tone="neutral">{t("backups.unverified")}</StatusBadge>
                  <Button size="sm" variant="outline" onClick={() => void download(row, "dump")}>
                    <Download aria-hidden="true" />
                    {t("backups.download")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void download(row, "guide")}>
                    <FileText aria-hidden="true" />
                    {t("backups.guide")}
                  </Button>
                  {admin && supported ? (
                    <Button size="sm" variant="outline" onClick={() => setRestoring(row)}>
                      <RotateCcw aria-hidden="true" />
                      {t("backups.restore")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        {latestGlobals.length > 0 ? (
          <div className="space-y-2 border-t pt-3" data-slot="database-globals">
            <div className="text-sm font-medium">{t("backups.globalsTitle")}</div>
            <p className="text-xs text-muted-foreground">{t("backups.globalsDescription")}</p>
            <ul className="divide-y">
              {latestGlobals.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <span>{format.dateTime(row.finishedAt)}</span>
                  <Button size="sm" variant="outline" onClick={() => void download(row, "globals")}>
                    <KeyRound aria-hidden="true" />
                    {t("backups.globalsDownload", { file: globalsFile })}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
      {restoring ? (
        <RestoreDialog
          databaseId={databaseId}
          databaseName={databaseName}
          engine={engine}
          connectionId={connectionId}
          backup={restoring}
          format={format}
          onClose={() => setRestoring(null)}
        />
      ) : null}
    </Card>
  );
}

function RestoreDialog({
  databaseId,
  databaseName,
  engine,
  connectionId,
  backup,
  format,
  onClose,
}: {
  databaseId: string;
  databaseName: string;
  engine: string;
  connectionId: string;
  backup: DbBackup;
  format: DbFormat;
  onClose: () => void;
}) {
  const { t } = format;
  const connections = useConnections();
  const restore = useRequestRestore(databaseId);
  const [target, setTarget] = React.useState(connectionId);
  const [name, setName] = React.useState("");
  const targets = (connections.data?.connections ?? []).filter(
    (connection: DbConnection) => connection.engine === engine,
  );
  const valid = name === "" || restoreNameValid(name, engine);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("backups.restoreTitle", { name: databaseName })}</DialogTitle>
          <DialogDescription>{t("backups.restoreDescription")}</DialogDescription>
        </DialogHeader>
        {restore.isSuccess ? (
          <Alert>
            <AlertTitle>
              {t("backups.restoreQueued", { name: restore.data.targetName ?? "" })}
            </AlertTitle>
            <AlertDescription>{t("backups.restoreOwners")}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("backups.restoreFrom", { at: format.dateTime(backup.finishedAt) })}
            </p>
            <div className="space-y-2">
              <Label htmlFor="restore-target">{t("backups.restoreTarget")}</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger id="restore-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {target !== connectionId ? (
              <p className="text-xs text-muted-foreground" data-slot="restore-other-executor">
                {t("backups.restoreOtherConnection")}
              </p>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="restore-name">{t("backups.restoreName")}</Label>
              <Input
                id="restore-name"
                value={name}
                placeholder={t("backups.restoreNamePlaceholder", { name: databaseName })}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={!valid}
              />
              <p className="text-xs text-muted-foreground">
                {valid ? t("backups.restoreNameHint") : t("backups.restoreNameInvalid")}
              </p>
            </div>
            {restore.isError ? (
              <Alert variant="destructive">
                <AlertTitle>{t(problemKey(restore.error))}</AlertTitle>
              </Alert>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t(restore.isSuccess ? "backups.close" : "backups.cancel")}
          </Button>
          {restore.isSuccess ? null : (
            <Button
              disabled={!valid || restore.isPending}
              onClick={() =>
                restore.mutate({
                  backupId: backup.id,
                  ...(target !== connectionId ? { targetConnectionId: target } : {}),
                  ...(name ? { name } : {}),
                })
              }
            >
              {t("backups.restoreStart")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
