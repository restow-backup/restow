import { Database, FileDown, RefreshCw, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { CopyButton, EmptyState, ErrorState, RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import {
  downloadSqlRestoreScript,
  type EndpointDetail,
  type SqlDatabase,
  type SqlInstance,
} from "../api.js";
import {
  useConfirmSqlTde,
  useEndpointFormat,
  useSqlInventory,
  useSqlOverview,
  useSqlVerify,
} from "../hooks.js";
import { endpointErrorKey, sqlCodeMessage, sqlRatingView, sqlSignInView } from "../presenters.js";
import { SqlRestoreDialog } from "./sql-restore-dialog.js";

/**
 * SQL Server on a Windows machine (preview, W2a, docs/BAREMETAL-WINDOWS.md 5.1): the instances
 * and whether the agent can sign in (with the T-SQL block a DBA runs once), and the databases
 * with their recovery model, the newest backup in the repository and the rating of the newest
 * check. Green only after a backup restored from the repository passed DBCC CHECKDB.
 *
 * Only admins act here (restoring under a new name, checking, the restore script); a restore
 * operator reads. No SQL credential is asked for or kept: the agent signs in with its service
 * account.
 */
export function SqlTab({ detail, canAct }: { detail: EndpointDetail; canAct: boolean }) {
  const { t } = useTranslation("endpoints");
  const overview = useSqlOverview(detail.id, true);
  const inventory = useSqlInventory(detail.id);
  const verify = useSqlVerify(detail.id);
  const [restoring, setRestoring] = React.useState<SqlDatabase | null>(null);

  if (overview.isError) {
    return (
      <ErrorState
        title={t("sql.loadError")}
        error={overview.error}
        onRetry={() => void overview.refetch()}
        retrying={overview.isFetching}
      />
    );
  }
  if (!overview.data) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  const data = overview.data;
  const actions = canAct && data.capable && detail.status === "active";

  const checkSignIn = () =>
    inventory.mutate(undefined, {
      onSuccess: () => toast.success(t("sql.signIn.checkQueued")),
      onError: (error) => toast.error(t(endpointErrorKey(error))),
    });
  const checkNow = (databaseId?: string) =>
    verify.mutate(databaseId, {
      onSuccess: (result) =>
        toast.success(
          result.queued.length > 0
            ? t("sql.verify.queued", { name: result.queued.join(", ") })
            : t("sql.verify.alreadyQueued"),
        ),
      onError: (error) => toast.error(t(endpointErrorKey(error))),
    });

  return (
    <div className="space-y-4" data-slot="sql-tab">
      <Alert>
        <Database aria-hidden="true" />
        <AlertTitle className="flex items-center gap-2">
          {t("sql.title")}
          <Badge variant="outline">{t("sql.preview")}</Badge>
        </AlertTitle>
        <AlertDescription>
          <p>{t("sql.intro")}</p>
          {!data.capable ? <p>{t("sql.notCapable")}</p> : null}
          {data.capable && !data.enabled ? <p>{t("sql.notEnabled")}</p> : null}
        </AlertDescription>
      </Alert>

      <Card data-slot="sql-instances">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t("sql.instances.title")}</CardTitle>
            <CardDescription>
              {data.inventoryAt ? (
                <>
                  {t("sql.instances.inventoryAt")}{" "}
                  <RelativeTime value={data.inventoryAt} focusable={false} />
                </>
              ) : (
                t("sql.instances.noInventory")
              )}
            </CardDescription>
          </div>
          {actions ? (
            <Button
              size="sm"
              variant="outline"
              onClick={checkSignIn}
              disabled={inventory.isPending || data.pending.inventory > 0}
            >
              <RefreshCw aria-hidden="true" />
              {t("sql.signIn.check")}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {data.instances.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("sql.instances.none")}</p>
          ) : (
            data.instances.map((instance) => (
              <InstanceRow key={instance.name} instance={instance} account={data.account} />
            ))
          )}
        </CardContent>
      </Card>

      <Card data-slot="sql-databases">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t("sql.databases.title")}</CardTitle>
            <CardDescription>
              {t("sql.databases.description", {
                day: t(`sql.weekday.${data.verify.weekday}`),
                time: data.verify.time,
              })}
            </CardDescription>
          </div>
          {actions && data.databases.some((database) => database.lastBackup) ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkNow()}
              disabled={verify.isPending}
            >
              <ShieldCheck aria-hidden="true" />
              {t("sql.verify.all")}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {data.databases.length === 0 ? (
            <EmptyState
              icon={Database}
              title={t("sql.databases.empty")}
              description={t("sql.databases.emptyHint")}
            />
          ) : (
            <ul className="divide-y" data-slot="sql-database-list">
              {data.databases.map((database) => (
                <DatabaseRow
                  key={database.id}
                  endpointId={detail.id}
                  database={database}
                  actions={actions}
                  onRestore={() => setRestoring(database)}
                  onCheck={() => checkNow(database.id)}
                  checking={verify.isPending}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {restoring ? (
        <SqlRestoreDialog
          endpointId={detail.id}
          database={restoring}
          instances={data.instances}
          open={restoring !== null}
          onOpenChange={(open) => {
            if (!open) setRestoring(null);
          }}
        />
      ) : null}
    </div>
  );
}

function InstanceRow({ instance, account }: { instance: SqlInstance; account: string }) {
  const { t } = useTranslation("endpoints");
  const [variant, setVariant] = React.useState<"sysadmin" | "minimal">("sysadmin");
  const view = sqlSignInView(instance.signIn);
  const error = instance.inventory?.error;
  const errorText = sqlCodeMessage(error?.code);
  const version = instance.inventory?.version ?? instance.facts?.version ?? "";
  const edition = instance.inventory?.edition ?? instance.facts?.edition ?? "";
  const script = instance.loginScripts[variant];
  return (
    <div className="space-y-3 rounded-md border p-3" data-instance={instance.name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{instance.name}</p>
          <p className="text-xs text-muted-foreground">
            {[edition, version].filter(Boolean).join(", ")}
          </p>
        </div>
        <StatusBadge tone={view.tone} icon>
          {t(view.key)}
        </StatusBadge>
      </div>
      {instance.facts?.clustered ? (
        <p className="text-sm text-muted-foreground">{t("sql.instances.clustered")}</p>
      ) : null}
      {instance.facts?.strictEncryption ? (
        <p className="text-sm text-muted-foreground">{t("sql.instances.strictEncryption")}</p>
      ) : null}
      {instance.inventory?.backupCompressionDefault ? (
        <p className="text-sm text-muted-foreground">{t("sql.instances.compressionDefault")}</p>
      ) : null}
      {errorText ? (
        <p className="text-sm" data-slot="sql-instance-error">
          {t(errorText.key, errorText.values)}
          {error?.number ? ` (${error.number})` : ""}
        </p>
      ) : null}
      {instance.signIn !== "ok" ? (
        <div className="space-y-2" data-slot="sql-login-script">
          <p className="text-sm">{t("sql.signIn.howTo", { account })}</p>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={variant}
            onValueChange={(value) => {
              if (value === "sysadmin" || value === "minimal") setVariant(value);
            }}
            aria-label={t("sql.signIn.variant")}
          >
            <ToggleGroupItem value="sysadmin">{t("sql.signIn.sysadmin")}</ToggleGroupItem>
            <ToggleGroupItem value="minimal">{t("sql.signIn.minimal")}</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {t(variant === "sysadmin" ? "sql.signIn.sysadminHint" : "sql.signIn.minimalHint")}
          </p>
          <div className="relative">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-12 font-mono text-xs">
              {script}
            </pre>
            <CopyButton
              value={script}
              label={t("sql.signIn.copy")}
              className="absolute top-2 right-2"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DatabaseRow({
  endpointId,
  database,
  actions,
  onRestore,
  onCheck,
  checking,
}: {
  endpointId: string;
  database: SqlDatabase;
  actions: boolean;
  onRestore: () => void;
  onCheck: () => void;
  checking: boolean;
}) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const tde = useConfirmSqlTde(endpointId);
  const rating = sqlRatingView(database.rating);
  const check = database.lastVerification;
  const checkCode = sqlCodeMessage(check?.code);
  const backup = database.lastBackup;
  const download = () => {
    if (!backup) return;
    downloadSqlRestoreScript(endpointId, backup.id).catch((error: unknown) =>
      toast.error(t(endpointErrorKey(error))),
    );
  };
  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0" data-database={database.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium break-all">
            {database.name}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {database.instance}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            {[
              t("sql.databases.model", { model: database.recoveryModel }),
              database.system ? t("sql.databases.system") : null,
              database.droppedAt ? t("sql.databases.dropped") : null,
              database.selected ? null : t("sql.databases.notSelected"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <StatusBadge tone={rating.tone} icon data-rating={database.rating}>
          {t(rating.key)}
        </StatusBadge>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t("sql.databases.lastBackup")}</dt>
          <dd>
            {backup ? (
              <>
                <RelativeTime value={backup.backupFinish} focusable={false} />
                {` · ${format.bytes(backup.bytes)}`}
              </>
            ) : (
              t("sql.databases.noBackup")
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("sql.databases.lastCheck")}</dt>
          <dd>
            {check ? (
              <>
                {t(`sql.outcome.${check.outcome}`)}
                {", "}
                <RelativeTime value={check.checkedAt} focusable={false} />
                {check.physicalOnly ? ` · ${t("sql.databases.physicalOnly")}` : ""}
              </>
            ) : (
              t("sql.databases.noCheck")
            )}
          </dd>
        </div>
      </dl>
      {check && check.outcome === "incomplete" && checkCode ? (
        <p className="text-xs text-muted-foreground">{t(checkCode.key, checkCode.values)}</p>
      ) : null}
      {check && check.outcome === "red" && check.evidence.length > 0 ? (
        <ul className="space-y-1 text-xs" data-slot="sql-evidence">
          {check.evidence.slice(0, 5).map((item) => (
            <li key={`${item.source}-${item.number ?? 0}-${item.message}`} className="break-words">
              {t("sql.databases.evidence", { code: item.number ?? 0, message: item.message })}
            </li>
          ))}
        </ul>
      ) : null}
      {database.encrypted && !database.tdeConfirmedAt ? (
        <Alert variant="warning">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("sql.databases.tde")}</span>
            {actions ? (
              <Button
                size="sm"
                variant="outline"
                disabled={tde.isPending}
                onClick={() => tde.mutate(database.id)}
              >
                {t("sql.databases.tdeConfirm")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {actions && backup ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onCheck} disabled={checking}>
            <ShieldCheck aria-hidden="true" />
            {t("sql.verify.one")}
          </Button>
          <Button size="sm" variant="outline" onClick={onRestore}>
            {t("sql.restore.open")}
          </Button>
          <Button size="sm" variant="ghost" onClick={download}>
            <FileDown aria-hidden="true" />
            {t("sql.script.download")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
