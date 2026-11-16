import * as React from "react";
import { useTranslation } from "react-i18next";

import { NativeSelect } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { toast } from "@/components/ui/sonner";

import type { SqlDatabase, SqlInstance } from "../api.js";
import { useEndpointFormat, useSqlBackups, useSqlRestore } from "../hooks.js";
import { endpointErrorKey, sqlNewNameProblem, sqlProposedName } from "../presenters.js";

/**
 * Restore one backup of a database under a new name (W2a, docs/BAREMETAL-WINDOWS.md 5.1.4): the
 * agent fetches the file from the repository, checks its SHA-256 and restores it next to the
 * existing database, which stays as it is. A restore over the existing database comes with W2b.
 */
export function SqlRestoreDialog({
  endpointId,
  database,
  instances,
  open,
  onOpenChange,
}: {
  endpointId: string;
  database: SqlDatabase;
  instances: readonly SqlInstance[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const backups = useSqlBackups(endpointId, open ? database.id : null);
  const restore = useSqlRestore(endpointId);
  const active = (backups.data ?? []).filter((backup) => backup.status === "active");
  const [backupId, setBackupId] = React.useState<string>("");
  const [newName, setNewName] = React.useState(() => sqlProposedName(database.name));
  const [target, setTarget] = React.useState(database.instance);
  const [checkdb, setCheckdb] = React.useState(true);
  const chosen = backupId || active[0]?.id || "";
  const problem = sqlNewNameProblem(newName, database.name);

  const submit = () => {
    if (!chosen || problem) {
      return;
    }
    restore.mutate(
      { backupId: chosen, newName, targetInstance: target, checkdb },
      {
        onSuccess: () => {
          toast.success(t("sql.restore.queued", { name: newName }));
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-slot="sql-restore-dialog">
        <DialogHeader>
          <DialogTitle>{t("sql.restore.title", { name: database.name })}</DialogTitle>
          <DialogDescription>{t("sql.restore.description")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="sql-restore-backup">{t("sql.restore.backup")}</Label>
            {active.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {backups.isLoading ? t("sql.restore.loading") : t("sql.restore.noBackup")}
              </p>
            ) : (
              <NativeSelect
                id="sql-restore-backup"
                value={chosen}
                onChange={(event) => setBackupId(event.target.value)}
              >
                {active.map((backup) => (
                  <option key={backup.id} value={backup.id}>
                    {t("sql.restore.backupOption", {
                      at: format.dateTime(backup.backupFinish) ?? backup.backupFinish,
                      size: format.bytes(backup.bytes),
                    })}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sql-restore-name">{t("sql.restore.newName")}</Label>
            <Input
              id="sql-restore-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={problem ? true : undefined}
              aria-describedby="sql-restore-name-hint"
            />
            <p
              id="sql-restore-name-hint"
              className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
            >
              {problem ? t(`sql.restore.nameProblem.${problem}`) : t("sql.restore.newNameHint")}
            </p>
          </div>
          {instances.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="sql-restore-target">{t("sql.restore.target")}</Label>
              <NativeSelect
                id="sql-restore-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                {instances.map((instance) => (
                  <option key={instance.name} value={instance.name}>
                    {instance.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <div className="flex items-start gap-2">
            <Checkbox
              id="sql-restore-checkdb"
              checked={checkdb}
              onCheckedChange={(value) => setCheckdb(value === true)}
              aria-describedby="sql-restore-checkdb-hint"
              className="mt-0.5"
            />
            <div className="grid gap-0.5">
              <Label htmlFor="sql-restore-checkdb">{t("sql.restore.checkdb")}</Label>
              <p id="sql-restore-checkdb-hint" className="text-xs text-muted-foreground">
                {t("sql.restore.checkdbHint")}
              </p>
            </div>
          </div>
          {restore.error ? (
            <Alert variant="destructive">
              <AlertDescription>{t(endpointErrorKey(restore.error))}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("sql.restore.cancel")}
            </Button>
            <Button type="submit" disabled={!chosen || problem !== null || restore.isPending}>
              {t("sql.restore.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
