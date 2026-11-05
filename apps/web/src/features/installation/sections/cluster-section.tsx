import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ErrorState } from "@/components/error-state";
import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, errorMessageKey, setupStateQueryOptions } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import { AccessNote, useInstallationAccess } from "../access";
import {
  type ClusterNode,
  type ClusterView,
  type CreatedJoinToken,
  JOIN_TOKEN_TTLS,
  joinCommand,
  NODE_NAME,
  useCluster,
  useCreateJoinToken,
  useRemoveNode,
  useRevokeJoinToken,
} from "../cluster-api";

/** The command that lets a worker host reach the database of this installation. */
export const ALLOW_WORKER_COMMAND =
  "sudo bash install.sh --allow-worker <address of the worker host> --database-address <address of this host>";

/**
 * Installation › Cluster (docs/SIZING.md, "Several hosts: worker nodes"): the worker nodes of this
 * installation with their processes and releases, what a new node needs (per storage target, and
 * the database reachable over TLS from the new host), and one-time join tokens for `install.sh
 * --join` on the new host. A node gets the master key and database logins of its own, so the
 * whole page, reading included, is the owner's; issuing a token and removing a node need a recent
 * sign-in. Real failover replication is in development; the page says so.
 */
export function ClusterSection() {
  const { t } = useTranslation("installation");
  const access = useInstallationAccess();
  const query = useCluster(access.change === null);
  if (access.change !== null) {
    return (
      <div className="space-y-4" data-slot="cluster">
        <p className="text-sm text-muted-foreground">{t("cluster.intro")}</p>
        <AccessNote block={access.change} level="owner" />
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError && !query.data) {
    return (
      <ErrorState
        title={t("cluster.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <ClusterContent view={query.data} />;
}

function errorText(error: unknown, t: (key: string) => string, tc: (key: string) => string) {
  if (error instanceof ApiError) {
    const code = (error.problem as { code?: unknown } | null)?.code;
    if (typeof code === "string") {
      return t(`cluster.errors.${code}`);
    }
  }
  return tc(errorMessageKey(error));
}

export function ClusterContent({ view }: { view: ClusterView }) {
  const { t } = useTranslation("installation");
  return (
    <div className="space-y-6" data-slot="cluster">
      <p className="text-sm text-muted-foreground">{t("cluster.intro")}</p>
      <Alert variant="info">
        <AlertTitle>{t("cluster.replication.title")}</AlertTitle>
        <AlertDescription>{t("cluster.replication.text")}</AlertDescription>
      </Alert>
      <NodesCard view={view} />
      <RequirementsCard view={view} />
      <JoinCard view={view} />
      <Card>
        <CardHeader>
          <CardTitle>{t("cluster.security.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{t("cluster.security.logins")}</p>
          <p>{t("cluster.security.masterKey")}</p>
          <p>{t("cluster.security.singleInstance")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function NodesCard({ view }: { view: ClusterView }) {
  const { t, i18n } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const identity = useConfirmIdentity();
  const remove = useRemoveNode();
  const [selected, setSelected] = React.useState<ClusterNode | null>(null);
  const removeNode = (node: ClusterNode) =>
    remove.mutate(node.id ?? "", {
      onSuccess: () => setSelected(null),
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(() => removeNode(node));
        }
      },
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cluster.nodes.title")}</CardTitle>
        <CardDescription>
          {t("cluster.nodes.description", { version: view.version })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-3" data-testid="cluster-nodes">
          {view.nodes.map((node) => (
            <li key={node.id ?? "main"} className="space-y-1 rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {node.status === "main" ? t("cluster.nodes.main") : node.name}
                </span>
                {node.hostname ? (
                  <span className="text-muted-foreground">{node.hostname}</span>
                ) : null}
                {node.version ? <Badge variant="secondary">{node.version}</Badge> : null}
                {node.outdated ? (
                  <Badge variant="warning">{t("cluster.nodes.outdated")}</Badge>
                ) : null}
                {node.versionMismatch ? (
                  <Badge variant="destructive">{t("cluster.nodes.versionMismatch")}</Badge>
                ) : null}
              </div>
              {node.processes.length === 0 ? (
                <p className="text-muted-foreground">{t("cluster.nodes.noProcesses")}</p>
              ) : (
                <ul className="text-xs text-muted-foreground">
                  {node.processes.map((process) => (
                    <li key={process.instanceId}>
                      {t("cluster.nodes.process", {
                        role: process.role,
                        state: process.alive
                          ? (process.state ?? t("cluster.nodes.running"))
                          : t("cluster.nodes.gone"),
                        when: formatDateTime(process.beatAt, i18n.language) ?? "",
                      })}
                    </li>
                  ))}
                </ul>
              )}
              {node.outdated && node.status !== "main" ? (
                <p className="text-xs text-muted-foreground">{t("cluster.nodes.update")}</p>
              ) : null}
              {node.status === "active" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setSelected(node)}>
                  {t("cluster.nodes.remove")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {remove.isError && !isRecentSignInRequired(remove.error) ? (
          <p className="text-sm text-destructive" role="alert">
            {errorText(remove.error, t, tc)}
          </p>
        ) : null}
        <ConfirmDialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open && !remove.isPending) {
              setSelected(null);
            }
          }}
          title={t("cluster.nodes.confirmTitle", { name: selected?.name ?? "" })}
          description={t("cluster.nodes.confirmDescription")}
          confirmLabel={t("cluster.nodes.remove")}
          destructive
          pending={remove.isPending}
          onConfirm={() => {
            if (selected) {
              removeNode(selected);
            }
          }}
        />
        {identity.dialog}
      </CardContent>
    </Card>
  );
}

function RequirementsCard({ view }: { view: ClusterView }) {
  const { t } = useTranslation("installation");
  const database = view.database;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cluster.requirements.title")}</CardTitle>
        <CardDescription>{t("cluster.requirements.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="font-medium">{t("cluster.requirements.storage")}</p>
          {view.targets.length === 0 ? (
            <p className="text-muted-foreground">{t("cluster.requirements.noTargets")}</p>
          ) : (
            <ul className="space-y-1" data-testid="cluster-targets">
              {view.targets.map((target) => (
                <li key={`${target.tenantId ?? "installation"}:${target.targetId}`}>
                  <span className="font-mono text-xs">
                    {target.tenantName ?? t("cluster.requirements.installationDefault")} /{" "}
                    {target.path ?? target.targetId}
                  </span>
                  {": "}
                  <span className={target.kind === "volume" ? "text-destructive" : undefined}>
                    {t(`cluster.requirements.kinds.${target.kind}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {view.joinBlocked ? (
            <Alert variant="destructive">
              <AlertDescription>{t("cluster.requirements.volumeBlocks")}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <div className="space-y-1">
          <p className="font-medium">{t("cluster.requirements.database")}</p>
          {database.address ? (
            <p>
              {t("cluster.requirements.exposed", {
                address: database.address,
                ssl: database.ssl
                  ? t("cluster.requirements.sslOn")
                  : t("cluster.requirements.sslOff"),
              })}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("cluster.requirements.notExposed")}</p>
          )}
          {database.nodeRules.length > 0 ? (
            <ul className="font-mono text-xs">
              {database.nodeRules.map((rule) => (
                <li key={`${rule.type}:${rule.address ?? ""}`}>
                  {rule.type} {rule.address ?? "all"} {rule.method ?? ""}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-muted-foreground">{t("cluster.requirements.howToExpose")}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
            {ALLOW_WORKER_COMMAND}
          </pre>
        </div>
        <p className="text-muted-foreground">
          {t("cluster.requirements.version", { version: view.version })}
        </p>
      </CardContent>
    </Card>
  );
}

function JoinCard({ view }: { view: ClusterView }) {
  const { t, i18n } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const identity = useConfirmIdentity();
  const create = useCreateJoinToken();
  const revoke = useRevokeJoinToken();
  const { data: setup } = useQuery(setupStateQueryOptions);
  const origin = setup?.publicUrl ?? (typeof window === "undefined" ? "" : window.location.origin);
  const [nodeName, setNodeName] = React.useState("");
  const [address, setAddress] = React.useState("");
  const [ttl, setTtl] = React.useState<number>(60);
  const [standby, setStandby] = React.useState(false);
  const [created, setCreated] = React.useState<(CreatedJoinToken & { nodeName: string }) | null>(
    null,
  );
  const name = nodeName.trim().toLowerCase();
  const blocked = view.joinBlocked || view.database.address === null;
  const ready = NODE_NAME.test(name) && !blocked && !create.isPending;
  const submit = () =>
    create.mutate(
      {
        nodeName: name,
        expectedAddress: address.trim() || null,
        ttlMinutes: ttl,
        standbyScheduler: standby,
      },
      {
        onSuccess: (token) => {
          setCreated({ ...token, nodeName: name });
          setNodeName("");
          setAddress("");
        },
        onError: (error) => {
          if (isRecentSignInRequired(error)) {
            identity.ask(submit);
          }
        },
      },
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cluster.join.title")}</CardTitle>
        <CardDescription>{t("cluster.join.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {created ? (
          <Alert variant="warning" data-testid="cluster-token-once">
            <AlertTitle>{t("cluster.join.createdTitle")}</AlertTitle>
            <AlertDescription className="gap-2">
              <p>
                {t("cluster.join.createdOnce", {
                  when: formatDateTime(created.expiresAt, i18n.language) ?? "",
                })}
              </p>
              <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
                {joinCommand(origin, created.token, created.nodeName)}
              </pre>
              <Button type="button" variant="outline" size="sm" onClick={() => setCreated(null)}>
                {t("cluster.join.hide")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {blocked ? (
          <p className="text-sm text-muted-foreground">
            {view.joinBlocked ? t("cluster.join.blockedVolume") : t("cluster.join.blockedDatabase")}
          </p>
        ) : null}
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) {
              submit();
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cluster-node-name">{t("cluster.join.nodeName")}</Label>
            <Input
              id="cluster-node-name"
              value={nodeName}
              onChange={(event) => setNodeName(event.target.value)}
              placeholder="worker-1"
              autoComplete="off"
              disabled={blocked}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cluster-node-address">{t("cluster.join.address")}</Label>
            <Input
              id="cluster-node-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="192.0.2.20"
              autoComplete="off"
              disabled={blocked}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cluster-token-ttl">{t("cluster.join.ttl")}</Label>
            <select
              id="cluster-token-ttl"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={ttl}
              onChange={(event) => setTtl(Number(event.target.value))}
              disabled={blocked}
            >
              {JOIN_TOKEN_TTLS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {t("cluster.join.ttlOption", { minutes })}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm sm:mt-6" htmlFor="cluster-standby">
            <Checkbox
              id="cluster-standby"
              checked={standby}
              onCheckedChange={(value) => setStandby(value === true)}
              disabled={blocked}
            />
            {t("cluster.join.standby")}
          </label>
          {create.isError && !isRecentSignInRequired(create.error) ? (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              {errorText(create.error, t, tc)}
            </p>
          ) : null}
          <div className="sm:col-span-2">
            <Button type="submit" disabled={!ready} loading={create.isPending}>
              {t("cluster.join.issue")}
            </Button>
          </div>
        </form>
        {view.tokens.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("cluster.join.open")}</p>
            <ul className="space-y-1 text-sm" data-testid="cluster-tokens">
              {view.tokens.map((token) => (
                <li key={token.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{token.prefix}…</span>
                  <span>
                    {t("cluster.join.tokenRow", {
                      name: token.nodeName,
                      when: formatDateTime(token.expiresAt, i18n.language) ?? "",
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={() =>
                      revoke.mutate(token.id, {
                        onError: (error) => {
                          if (isRecentSignInRequired(error)) {
                            identity.ask(() => revoke.mutate(token.id));
                          }
                        },
                      })
                    }
                  >
                    {t("cluster.join.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {identity.dialog}
      </CardContent>
    </Card>
  );
}
