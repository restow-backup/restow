import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ApiError } from "@/lib/api";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  fetchRestoreInfo,
  type RestoreOperation,
  startRestore,
  type UploadProgress,
  uploadDump,
} from "@/routes/setup/restore-api";

/**
 * A restore with the install script: on a fresh host only (it refuses a host that runs an
 * installation already, like this one).
 */
export const RESTORE_INSTALL_COMMAND =
  "sudo bash install.sh --restore /path/to/restow.dump --env-from /path/to/old/.env";

/**
 * The restore by hand on this installation, without the updater (docs/DATABASE.md, "Restoring a
 * dump by hand"): the old master key into .env first, then the dump into a database of its own,
 * prepared (restore mode on, the key checked) and activated; worker and scheduler only after.
 */
export const RESTORE_MANUAL_COMMANDS = [
  "cd /opt/restow",
  "# 1. Replace RESTOW_MASTER_KEY and BETTER_AUTH_SECRET in .env with the old installation's",
  "sudo nano .env",
  "# 2. Restore the dump into a database of its own, worker and scheduler stopped",
  "sudo docker compose stop api worker scheduler",
  'sudo docker compose exec -T postgres psql -U restow -d postgres -c "CREATE DATABASE restow_restore"',
  "sudo docker compose exec -T postgres pg_restore -U restow -d restow_restore --no-owner --no-acl --exit-on-error < /path/to/restow.dump",
  "# 3. Restore mode on, master key and storage checked; read the report",
  "sudo docker compose run --rm --no-deps --entrypoint restow api restore prepare",
  "# 4. Make it the live database, then start everything",
  "sudo docker compose run --rm --no-deps --entrypoint restow api restore activate",
  "sudo docker compose up -d",
].join("\n");

interface RestoreSourceStepProps {
  token: string;
  /** The restore started (or one runs already): on to its progress and report. */
  onStarted: (operation: RestoreOperation) => void;
}

/**
 * What a restore needs, and which dump: one the updater kept (it keeps the dumps of the last
 * updates in its own volume, so they are only there when that volume survived on this host), or
 * one uploaded here. Without the updater the wizard cannot restore: the step shows the restore by
 * hand on this installation (install.sh --restore is for a fresh host only) and how to switch the
 * updater on.
 */
export function RestoreSourceStep({ token, onStarted }: RestoreSourceStepProps) {
  const { t, i18n } = useTranslation("setup");
  const language = i18n.resolvedLanguage ?? "en";
  const info = useQuery({
    queryKey: ["setup", "restore", "info"],
    queryFn: () => fetchRestoreInfo(token),
    retry: false,
  });
  const [chosen, setChosen] = React.useState<string | null>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [progress, setProgress] = React.useState<UploadProgress | null>(null);

  // A restore that runs already (the page was reloaded): straight on to it.
  React.useEffect(() => {
    const operation = info.data?.operation;
    if (
      operation &&
      (operation.status === "running" || operation.status === "awaiting_confirmation")
    ) {
      onStarted(operation);
    }
  }, [info.data, onStarted]);

  const start = useMutation({
    mutationFn: async () => {
      let dump = chosen;
      if (file) {
        dump = (
          await uploadDump(token, file, info.data?.partBytes ?? 32 * 1024 * 1024, setProgress)
        ).file;
      }
      if (!dump) {
        throw new Error("no dump");
      }
      return (await startRestore(token, dump)).operation;
    },
    onSuccess: onStarted,
  });

  const bring = (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">{t("restoreSource.bring.title")}</p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        <li>{t("restoreSource.bring.masterKey")}</li>
        <li>{t("restoreSource.bring.authSecret")}</li>
        <li>{t("restoreSource.bring.dump")}</li>
      </ul>
    </div>
  );

  if (info.isPending) {
    return <p className="text-sm text-muted-foreground">{t("restoreSource.loading")}</p>;
  }
  if (info.isError || !info.data.available) {
    return (
      <div className="space-y-4 text-sm">
        {bring}
        <p className="text-muted-foreground">{t("restoreSource.unavailable.why")}</p>
        <p className="text-muted-foreground">{t("restoreSource.unavailable.manual")}</p>
        <pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {RESTORE_MANUAL_COMMANDS}
        </pre>
        <p className="text-muted-foreground">{t("restoreSource.unavailable.manualAbort")}</p>
        <p className="text-muted-foreground">{t("restoreSource.unavailable.updater")}</p>
        <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
          cd /opt/restow && sudo docker compose --profile updater up -d
        </pre>
        <p className="text-muted-foreground">{t("restoreSource.unavailable.freshHost")}</p>
        <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
          {RESTORE_INSTALL_COMMAND}
        </pre>
      </div>
    );
  }

  const dumps = info.data.dumps;
  const failure = start.error;
  const failureText =
    failure instanceof ApiError && typeof failure.problem?.detail === "string"
      ? failure.problem.detail
      : failure
        ? t("restoreSource.failed")
        : null;
  const busy = start.isPending;

  return (
    <div className="space-y-4 text-sm">
      {bring}
      {dumps.length > 0 ? (
        <div className="space-y-2">
          <p className="font-medium">{t("restoreSource.kept.title")}</p>
          <p className="text-xs text-muted-foreground">{t("restoreSource.kept.note")}</p>
          <div role="radiogroup" aria-label={t("restoreSource.kept.title")} className="grid gap-2">
            {dumps.map((dump) => (
              <label
                key={dump.file}
                className={cn(
                  "flex cursor-pointer flex-col rounded-md border p-3",
                  chosen === dump.file && !file
                    ? "border-primary ring-1 ring-ring"
                    : "border-border",
                )}
              >
                <input
                  type="radio"
                  name="restore-dump"
                  value={dump.file}
                  className="sr-only"
                  checked={chosen === dump.file && !file}
                  onChange={() => {
                    setChosen(dump.file);
                    setFile(null);
                  }}
                />
                <span className="font-mono text-xs">{dump.file}</span>
                <span className="text-xs text-muted-foreground">
                  {formatBytes(dump.bytes, language)} · {formatDateTime(dump.createdAt, language)}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("restoreSource.kept.none")}</p>
      )}
      <div className="space-y-2">
        <label htmlFor="restore-file" className="font-medium">
          {t("restoreSource.upload.label")}
        </label>
        <input
          id="restore-file"
          type="file"
          accept=".dump,application/octet-stream"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setChosen(null);
          }}
          className="block w-full text-sm"
        />
        <p className="text-xs text-muted-foreground">{t("restoreSource.upload.hint")}</p>
      </div>
      {progress && busy ? (
        <div className="space-y-1">
          <Progress value={progress.total > 0 ? (progress.done / progress.total) * 100 : 0} />
          <p className="text-xs text-muted-foreground">
            {t(`restoreSource.upload.${progress.phase}`, {
              done: formatBytes(progress.done, language),
              total: formatBytes(progress.total, language),
            })}
          </p>
        </div>
      ) : null}
      {failureText ? (
        <p role="alert" className="text-sm text-destructive">
          {failureText}
        </p>
      ) : null}
      <Button
        type="button"
        onClick={() => start.mutate()}
        disabled={(!chosen && !file) || busy}
        loading={busy}
      >
        {t("restoreSource.start")}
      </Button>
    </div>
  );
}
