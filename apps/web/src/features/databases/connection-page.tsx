import { Link, useNavigate } from "@tanstack/react-router";
import { Database, PlugZap, ShieldAlert, Trash2 } from "lucide-react";
import * as React from "react";

import { Field } from "@/components/forms/field";
import {
  ConfirmDialog,
  ErrorState,
  NativeSelect,
  PageHeader,
  RelativeTime,
  StatusBadge,
} from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { canAccess, useSession } from "@/lib/session";

import type { DbConnectionDetail } from "./api.js";
import { problemKey } from "./components/add-connection-dialog.js";
import { ConnectionHealthCard } from "./components/health.js";
import { ProbeResult, RightsMatrix } from "./components/probe-result.js";
import {
  type DbFormat,
  useConnection,
  useDbFormat,
  useDeleteConnection,
  useProbe,
  useTestStoredConnection,
  useUpdateConnection,
} from "./hooks.js";
import { DATABASE_ADMIN_ROLES, databasesTo, databaseTo, linkTo } from "./paths.js";
import {
  codeKey,
  connectionStateView,
  ENGINE_LABEL,
  HEALTH_INTERVAL_CHOICES,
  INTERVAL_CHOICES,
  ratingView,
} from "./presenters.js";

/**
 * One connection (docs/DATABASES.md 2.3): executor, sign-in, TLS fingerprint, mode, schedule and
 * the databases it found; "Test connection" with the stored credentials; a new certificate or a
 * new instance is red until an administrator confirms it here (3.2, 3.3).
 */
export function ConnectionPage({ connectionId }: { connectionId: string }) {
  const format = useDbFormat();
  const { t } = format;
  const { role } = useSession();
  const admin = canAccess(role, DATABASE_ADMIN_ROLES);
  const connection = useConnection(connectionId);
  const test = useTestStoredConnection(connectionId);
  const [probeId, setProbeId] = React.useState<string | null>(null);
  const probe = useProbe(probeId);

  if (connection.isError) {
    return (
      <ErrorState
        title={t("connection.loadError")}
        error={connection.error}
        onRetry={() => void connection.refetch()}
        retrying={connection.isFetching}
      />
    );
  }
  if (connection.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  const data = connection.data;
  const state = connectionStateView(data.state);
  const waiting = probe.data?.status === "pending" || probe.data?.status === "running";

  return (
    <div className="space-y-6" data-slot="database-connection-page">
      <PageHeader
        icon={Database}
        title={data.name}
        description={`${ENGINE_LABEL[data.engine]} · ${data.address}`}
        actions={
          admin ? (
            <>
              <Button
                variant="outline"
                disabled={test.isPending || waiting}
                onClick={() =>
                  test.mutate(undefined, { onSuccess: (answer) => setProbeId(answer.id) })
                }
                data-action="test-stored"
              >
                <PlugZap aria-hidden="true" />
                {t("connection.test")}
              </Button>
              <DeleteConnection connection={data} format={format} />
            </>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={state.tone}>{t(state.key)}</StatusBadge>
        {data.notices.map((notice) => (
          <StatusBadge key={notice} tone="warning">
            {t(codeKey(notice))}
          </StatusBadge>
        ))}
      </div>
      {test.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{t(problemKey(test.error))}</AlertTitle>
        </Alert>
      ) : null}
      {waiting ? (
        <Alert variant="info">
          <AlertTitle>{t("add.waiting")}</AlertTitle>
          <AlertDescription>{t("add.waitingHint")}</AlertDescription>
        </Alert>
      ) : null}
      {probe.data?.status === "done" ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("connection.testResult")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ProbeResult probe={probe.data} format={format} />
          </CardContent>
        </Card>
      ) : null}
      {admin ? <Confirmations connection={data} format={format} /> : null}
      <Facts connection={data} format={format} />
      {data.lastCheck?.rights ? (
        <Card>
          <CardContent className="pt-6">
            <RightsMatrix rights={data.lastCheck.rights} format={format} />
          </CardContent>
        </Card>
      ) : null}
      <ConnectionHealthCard connection={data} format={format} />
      <DatabasesCard connection={data} format={format} />
      {admin ? <Settings connection={data} format={format} /> : null}
    </div>
  );
}

function Facts({ connection, format }: { connection: DbConnectionDetail; format: DbFormat }) {
  const { t } = format;
  const executor =
    connection.executor.kind === "server"
      ? t("executor.server")
      : connection.executor.hostname
        ? t(connection.executor.online ? "executor.agentOnline" : "executor.agentOffline", {
            hostname: connection.executor.hostname,
          })
        : t("executor.missing");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("connection.facts")}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t("connection.engine")}</dt>
          <dd>
            {ENGINE_LABEL[connection.engine]}
            {connection.serverVersion ? ` ${connection.serverVersion}` : ""}
          </dd>
          <dt className="text-muted-foreground">{t("connection.address")}</dt>
          <dd className="font-mono">{connection.address}</dd>
          <dt className="text-muted-foreground">{t("connection.executor")}</dt>
          <dd data-slot="connection-executor">{executor}</dd>
          <dt className="text-muted-foreground">{t("connection.signIn")}</dt>
          <dd data-slot="connection-credential">
            {connection.authMethod === "socket"
              ? t("connection.socket")
              : connection.credential === "set"
                ? t("connection.credentialSet")
                : t("connection.credentialMissing")}
          </dd>
          <dt className="text-muted-foreground">{t("connection.tls")}</dt>
          <dd>
            {connection.tls.fingerprint ? (
              <span className="flex flex-col">
                <code className="font-mono text-xs break-all">{connection.tls.fingerprint}</code>
                {connection.tls.confirmedAt ? (
                  <span className="text-xs text-muted-foreground">
                    {t("connection.tlsConfirmed", {
                      by: connection.tls.confirmedBy ?? "",
                      at: format.dateTime(connection.tls.confirmedAt) ?? "",
                    })}
                  </span>
                ) : null}
              </span>
            ) : (
              t("connection.unencrypted")
            )}
          </dd>
          {connection.privateNetworkApproval ? (
            <>
              <dt className="text-muted-foreground">{t("connection.approval")}</dt>
              <dd>
                {t("connection.approvedBy", {
                  by: connection.privateNetworkApproval.by,
                  at: format.dateTime(connection.privateNetworkApproval.at) ?? "",
                })}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t("connection.mode")}</dt>
          <dd>{t(`modes.${connection.mode}`)}</dd>
          <dt className="text-muted-foreground">{t("connection.schedule")}</dt>
          <dd>{t("intervals.minutes", { count: connection.schedule.intervalMinutes })}</dd>
          <dt className="text-muted-foreground">{t("connection.lastCheck")}</dt>
          <dd>
            {connection.lastCheck ? (
              <span className="flex flex-col">
                <RelativeTime value={connection.lastCheck.at} />
                {connection.lastCheck.errorCode ? (
                  <span className="text-xs text-muted-foreground">
                    {t(codeKey(connection.lastCheck.errorCode))}
                    {connection.lastCheck.errorMessage
                      ? `: ${connection.lastCheck.errorMessage}`
                      : ""}
                  </span>
                ) : null}
              </span>
            ) : (
              t("list.never")
            )}
          </dd>
          {!connection.identityKnown ? (
            <>
              <dt className="text-muted-foreground">{t("connection.identity")}</dt>
              <dd>{t("probe.identityUnknown")}</dd>
            </>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

/** A new certificate or instance: red until an administrator confirms it (3.2, 3.3). */
function Confirmations({
  connection,
  format,
}: {
  connection: DbConnectionDetail;
  format: DbFormat;
}) {
  const { t } = format;
  const update = useUpdateConnection(connection.id);
  const check = connection.lastCheck;
  if (
    !check ||
    (check.errorCode !== "db_tls_changed" && check.errorCode !== "db_instance_changed")
  ) {
    // A health check saw it first (D2): only a test of the connection can be confirmed.
    const seen = connection.health.errorCode;
    if (seen === "db_tls_changed" || seen === "db_instance_changed") {
      return (
        <Alert variant="destructive" data-slot="confirm-from-health">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>
            {t(seen === "db_tls_changed" ? "confirm.tlsTitle" : "confirm.instanceTitle")}
          </AlertTitle>
          <AlertDescription>{t("confirm.fromHealth")}</AlertDescription>
        </Alert>
      );
    }
    return null;
  }
  const tls = check.errorCode === "db_tls_changed";
  return (
    <Alert variant="destructive" data-slot="confirm-change">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>{t(tls ? "confirm.tlsTitle" : "confirm.instanceTitle")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{t(tls ? "confirm.tlsDescription" : "confirm.instanceDescription")}</p>
        {tls && check.tlsFingerprintSeen ? (
          <code className="block font-mono text-xs break-all">{check.tlsFingerprintSeen}</code>
        ) : null}
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="outline">
              {t(tls ? "confirm.tlsAction" : "confirm.instanceAction")}
            </Button>
          }
          title={t(tls ? "confirm.tlsTitle" : "confirm.instanceTitle")}
          description={t(tls ? "confirm.tlsQuestion" : "confirm.instanceQuestion")}
          confirmLabel={t(tls ? "confirm.tlsAction" : "confirm.instanceAction")}
          onConfirm={() =>
            update.mutateAsync({
              confirm: { probeId: check.probeId, tls, instance: !tls },
            })
          }
        />
      </AlertDescription>
    </Alert>
  );
}

function DatabasesCard({
  connection,
  format,
}: {
  connection: DbConnectionDetail;
  format: DbFormat;
}) {
  const { t } = format;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("connection.databases")}</CardTitle>
        <CardDescription>
          {connection.engine === "mysql" || connection.engine === "mariadb"
            ? t("probe.schemasByName")
            : t("connection.databasesDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table scrollLabel={t("connection.databases")}>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">{t("list.columns.database")}</TableHead>
              <TableHead>{t("list.columns.size")}</TableHead>
              <TableHead className="pr-4">{t("list.columns.rating")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connection.databases.map((database) => {
              const rating = ratingView(database.rating);
              return (
                <TableRow key={database.id} data-database={database.id}>
                  <TableCell className="pl-4">
                    <Link {...linkTo(databaseTo(database.id))} className="hover:underline">
                      {database.name}
                    </Link>
                    {database.droppedAt ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("connection.dropped", { at: format.dateTime(database.droppedAt) ?? "" })}
                      </span>
                    ) : database.excluded ? (
                      <span className="block text-xs text-muted-foreground">
                        {t("connection.excluded")}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>{format.bytes(database.sizeBytes) ?? t("list.unknown")}</TableCell>
                  <TableCell className="pr-4">
                    <StatusBadge tone={rating.tone}>{t(rating.key)}</StatusBadge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Settings({ connection, format }: { connection: DbConnectionDetail; format: DbFormat }) {
  const { t } = format;
  const update = useUpdateConnection(connection.id);
  const [name, setName] = React.useState(connection.name);
  const [intervalMinutes, setIntervalMinutes] = React.useState(connection.schedule.intervalMinutes);
  const [healthMinutes, setHealthMinutes] = React.useState(connection.health.intervalMinutes);
  const [enabled, setEnabled] = React.useState(connection.enabled);
  const [user, setUser] = React.useState("");
  const [password, setPassword] = React.useState("");

  const save = () => {
    update.mutate(
      {
        ...(name.trim() !== connection.name ? { name: name.trim() } : {}),
        ...(intervalMinutes !== connection.schedule.intervalMinutes
          ? { schedule: { intervalMinutes } }
          : {}),
        ...(enabled !== connection.enabled ? { enabled } : {}),
        ...(healthMinutes !== connection.health.intervalMinutes
          ? { healthIntervalMinutes: healthMinutes }
          : {}),
        ...(user.trim() ? { user: user.trim() } : {}),
        ...(password ? { password } : {}),
      },
      {
        onSuccess: () => {
          setUser("");
          setPassword("");
          toast.success(t("settings.saved"));
        },
      },
    );
  };

  return (
    <Card data-slot="connection-settings">
      <CardHeader>
        <CardTitle>{t("settings.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="conn-name" label={t("add.name")}>
            <Input id="conn-name" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field id="conn-interval" label={t("add.interval")}>
            <NativeSelect
              id="conn-interval"
              value={String(intervalMinutes)}
              onChange={(event) => setIntervalMinutes(Number(event.target.value))}
            >
              {INTERVAL_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {t("intervals.minutes", { count: minutes })}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="conn-health-interval" label={t("health.interval")}>
            <NativeSelect
              id="conn-health-interval"
              value={String(healthMinutes)}
              onChange={(event) => setHealthMinutes(Number(event.target.value))}
            >
              {[...new Set([...HEALTH_INTERVAL_CHOICES, connection.health.intervalMinutes])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t("health.intervalChoice", { count: minutes })}
                  </option>
                ))}
            </NativeSelect>
          </Field>
        </div>
        {connection.authMethod === "password" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="conn-user"
              label={t("settings.newUser")}
              hint={t("settings.credentialsHint")}
            >
              <Input
                id="conn-user"
                value={user}
                autoComplete="off"
                onChange={(event) => setUser(event.target.value)}
              />
            </Field>
            <Field id="conn-password" label={t("settings.newPassword")}>
              <Input
                id="conn-password"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Switch
            id="conn-enabled"
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          <Label htmlFor="conn-enabled">{t("settings.enabled")}</Label>
        </div>
        {update.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{t(problemKey(update.error))}</AlertTitle>
          </Alert>
        ) : null}
        <div className="flex justify-end">
          <Button onClick={save} disabled={update.isPending} data-action="save-settings">
            {t("settings.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DeleteConnection({
  connection,
  format,
}: {
  connection: DbConnectionDetail;
  format: DbFormat;
}) {
  const { t } = format;
  const remove = useDeleteConnection(connection.id);
  const navigate = useNavigate();
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" data-action="delete-connection">
          <Trash2 aria-hidden="true" />
          {t("connection.delete")}
        </Button>
      }
      destructive
      title={t("connection.deleteTitle", { name: connection.name })}
      description={t("connection.deleteDescription")}
      confirmLabel={t("connection.delete")}
      confirmationText={connection.name}
      onConfirm={() =>
        remove.mutateAsync().then(() => {
          toast.success(t("connection.deleted", { name: connection.name }));
          void navigate(linkTo(databasesTo()));
        })
      }
    />
  );
}
