import { Link, useNavigate } from "@tanstack/react-router";
import {
  Building,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  ShieldAlert,
  Trash2,
  Webhook as WebhookIcon,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  PIN_FIRST,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { ConfirmDialog } from "../components/confirm-dialog";
import { useDeleteWebhook, useIntegrationsScope, useUpdateWebhook, useWebhooks } from "../hooks";
import { webhookDetailTo } from "../paths";
import {
  displayUrl,
  eventKey,
  integrationErrorKey,
  isInsecureUrl,
  isSignedFormat,
} from "../presenters";
import type { Webhook } from "../types";
import { useIntegrationsFormat } from "../use-format";
import { WebhookRulesNotice } from "./rules-using-webhook";
import { SignatureHelp } from "./signature-help";
import { WebhookFormDialog } from "./webhook-form-dialog";
import { InsecureBadge, WebhookHealthBadge, WebhookStatsLine } from "./webhook-status";

/** The webhooks tab: the tenant's webhooks, their health and how to verify requests. */
export function WebhooksPanel() {
  const { t } = useTranslation("integrations");
  const scope = useIntegrationsScope();
  if (scope.tenantId === null) {
    return (
      <Alert variant="info">
        <Building />
        <AlertTitle>{t("noTenant.title")}</AlertTitle>
        <AlertDescription>{t("noTenant.description")}</AlertDescription>
      </Alert>
    );
  }
  if (!scope.canManageTenant) {
    return (
      <Alert variant="warning">
        <ShieldAlert />
        <AlertTitle>{t("noTenantAccess.title")}</AlertTitle>
        <AlertDescription>
          {t("noTenantAccess.description", { tenant: scope.tenantName ?? "" })}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="space-y-6">
      <WebhookList />
      <SignatureHelp />
    </div>
  );
}

function WebhookList() {
  const { t } = useTranslation("integrations");
  const navigate = useNavigate();
  const query = useWebhooks();
  const update = useUpdateWebhook();
  const remove = useDeleteWebhook();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Webhook | null>(null);
  const [deleting, setDeleting] = React.useState<Webhook | null>(null);

  const toggleActive = (webhook: Webhook) => {
    update.mutate(
      { id: webhook.id, patch: { active: !webhook.active } },
      {
        onSuccess: () =>
          toast.success(t(webhook.active ? "toasts.webhookPaused" : "toasts.webhookActivated")),
        onError: (error) => toast.error(t(integrationErrorKey(error))),
      },
    );
  };

  const confirmDelete = () => {
    if (!deleting) {
      return;
    }
    remove.mutate(deleting.id, {
      onSuccess: () => {
        toast.success(t("toasts.webhookDeleted"));
        setDeleting(null);
      },
      onError: (error) => toast.error(t(integrationErrorKey(error))),
    });
  };

  const webhooks = query.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t("webhooks.title")}</CardTitle>
          <CardDescription>{t("webhooks.description")}</CardDescription>
        </div>
        <Button onClick={() => setCreating(true)} className="shrink-0">
          <Plus aria-hidden="true" />
          {t("webhooks.create")}
        </Button>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : query.error ? (
          <ErrorState
            title={t("webhooks.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : webhooks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
            <WebhookIcon className="size-8 text-muted-foreground" aria-hidden="true" />
            <p className="font-medium">{t("webhooks.empty.title")}</p>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("webhooks.empty.description")}
            </p>
          </div>
        ) : (
          <Table className="min-w-[48rem]" scrollLabel={t("webhooks.title")}>
            <TableHeader>
              <TableRow>
                <TableHead pin={PIN_FIRST}>{t("webhooks.columns.webhook")}</TableHead>
                <TableHead>{t("webhooks.columns.events")}</TableHead>
                <TableHead>{t("webhooks.columns.health")}</TableHead>
                <TableHead>{t("webhooks.columns.lastDelivery")}</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">{t("webhooks.columns.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.map((webhook) => (
                <WebhookRow
                  key={webhook.id}
                  webhook={webhook}
                  onEdit={() => setEditing(webhook)}
                  onToggle={() => toggleActive(webhook)}
                  onDelete={() => setDeleting(webhook)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <WebhookFormDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => void navigate({ to: webhookDetailTo(id) })}
      />
      {editing ? (
        <WebhookFormDialog
          open
          webhook={editing}
          onOpenChange={(open) => {
            if (!open) {
              setEditing(null);
            }
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        title={t("webhooks.deleteConfirm.title")}
        description={t("webhooks.deleteConfirm.description")}
        detail={
          deleting ? (
            <div className="space-y-3">
              <div>{displayUrl(deleting.url)}</div>
              <WebhookRulesNotice webhookId={deleting.id} />
            </div>
          ) : null
        }
        confirmLabel={t("webhooks.deleteConfirm.confirm")}
        destructive
        pending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </Card>
  );
}

function WebhookRow({
  webhook,
  onEdit,
  onToggle,
  onDelete,
}: {
  webhook: Webhook;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t, relative, dateTime } = useIntegrationsFormat();
  const name = webhook.name ?? t("webhooks.unnamed");
  const last = webhook.stats.lastDelivery;
  return (
    <TableRow>
      <TableCell pin={PIN_FIRST} className="min-w-56 max-w-md">
        <Link
          to={webhookDetailTo(webhook.id)}
          className="font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
          aria-label={t("webhooks.open", { name })}
        >
          {name}
        </Link>
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground" title={webhook.url}>
            {displayUrl(webhook.url)}
          </span>
          {isInsecureUrl(webhook.url) ? <InsecureBadge /> : null}
          {isSignedFormat(webhook.format) ? null : (
            <Badge variant="secondary" className="shrink-0">
              {t(`formats.${webhook.format}.label`)}
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-sm">
        <span
          title={webhook.events.map((event) => t(`events.${eventKey(event)}.label`)).join(", ")}
        >
          {t("webhooks.eventCount", { count: webhook.events.length })}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <WebhookHealthBadge webhook={webhook} />
          <WebhookStatsLine webhook={webhook} />
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-sm">
        {last ? (
          <span title={dateTime(last.createdAt) ?? undefined}>{relative(last.createdAt)}</span>
        ) : (
          <span className="text-muted-foreground">{t("webhooks.noDeliveries")}</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("webhooks.actions", { name })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil aria-hidden="true" />
              {t("webhooks.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggle}>
              {webhook.active ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {webhook.active ? t("webhooks.pause") : t("webhooks.activate")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} variant="destructive">
              <Trash2 aria-hidden="true" />
              {t("webhooks.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
