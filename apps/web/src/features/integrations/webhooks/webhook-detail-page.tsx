import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  KeyRound,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Send,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";

import { ConfirmDialog } from "../components/confirm-dialog";
import { SecretRevealDialog } from "../components/secret-reveal";
import {
  useDeleteWebhook,
  useIntegrationsScope,
  useRotateSecret,
  useSendTestEvent,
  useUpdateWebhook,
  useWebhook,
} from "../hooks";
import { integrationsTo } from "../paths";
import {
  INTEGRATIONS_ROLES,
  displayUrl,
  eventKey,
  integrationErrorKey,
  isInsecureUrl,
} from "../presenters";
import type { Webhook } from "../types";
import { useIntegrationsFormat } from "../use-format";
import { DeliveriesCard } from "./deliveries-card";
import { WebhookFormDialog } from "./webhook-form-dialog";
import { InsecureBadge, WebhookHealthBadge, WebhookStatsLine } from "./webhook-status";

/** One webhook: its configuration, the actions on it and its delivery log. */
export function WebhookDetailPage({ webhookId }: { webhookId: string }) {
  return (
    <RequireRole roles={INTEGRATIONS_ROLES}>
      <TooltipProvider delayDuration={200}>
        <WebhookDetail webhookId={webhookId} />
      </TooltipProvider>
    </RequireRole>
  );
}

function BackLink() {
  const { t } = useTranslation("integrations");
  return (
    <Link
      to={integrationsTo()}
      search={{ tab: "webhooks" } as never}
      className={buttonVariants({ variant: "ghost", size: "sm", className: "-ml-2" })}
    >
      <ArrowLeft aria-hidden="true" />
      {t("detail.back")}
    </Link>
  );
}

function WebhookDetail({ webhookId }: { webhookId: string }) {
  const { t } = useTranslation("integrations");
  const scope = useIntegrationsScope();
  const query = useWebhook(webhookId);

  if (!scope.tenantEnabled) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Alert variant="info">
          <AlertTitle>{t("noTenant.title")}</AlertTitle>
          <AlertDescription>{t("noTenant.description")}</AlertDescription>
        </Alert>
      </div>
    );
  }
  if (query.isPending) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.error || !query.data) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="space-y-6">
        <BackLink />
        {notFound ? (
          <Alert variant="warning">
            <AlertTitle>{t("detail.notFound.title")}</AlertTitle>
            <AlertDescription>{t("detail.notFound.description")}</AlertDescription>
          </Alert>
        ) : (
          <ErrorState
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        )}
      </div>
    );
  }
  return <WebhookView webhook={query.data} />;
}

function WebhookView({ webhook }: { webhook: Webhook }) {
  const { t } = useTranslation("integrations");
  const navigate = useNavigate();
  const sendTest = useSendTestEvent();
  const rotate = useRotateSecret();
  const update = useUpdateWebhook();
  const remove = useDeleteWebhook();
  const [editing, setEditing] = React.useState(false);
  const [confirmRotate, setConfirmRotate] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);
  const name = webhook.name ?? t("webhooks.unnamed");

  const onError = (error: unknown) => toast.error(t(integrationErrorKey(error)));

  const test = () =>
    sendTest.mutate(webhook.id, {
      onSuccess: () => toast.success(t("toasts.testQueued")),
      onError,
    });

  const rotateSecret = () =>
    rotate.mutate(webhook.id, {
      onSuccess: (result) => {
        setConfirmRotate(false);
        setSecret(result.secret);
        toast.success(t("toasts.secretRotated"));
      },
      onError,
    });

  const toggleActive = () =>
    update.mutate(
      { id: webhook.id, patch: { active: !webhook.active } },
      {
        onSuccess: () =>
          toast.success(t(webhook.active ? "toasts.webhookPaused" : "toasts.webhookActivated")),
        onError,
      },
    );

  const deleteWebhook = () =>
    remove.mutate(webhook.id, {
      onSuccess: () => {
        toast.success(t("toasts.webhookDeleted"));
        void navigate({ to: integrationsTo(), search: { tab: "webhooks" } as never });
      },
      onError,
    });

  return (
    <div className="space-y-6">
      <BackLink />
      <PageHeader title={name} description={displayUrl(webhook.url)}>
        <Button onClick={test} loading={sendTest.isPending} disabled={!webhook.active}>
          <Send aria-hidden="true" />
          {t("detail.sendTest")}
        </Button>
        <Button variant="outline" onClick={() => setEditing(true)}>
          <Pencil aria-hidden="true" />
          {t("webhooks.edit")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label={t("webhooks.actions", { name })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={toggleActive}>
              {webhook.active ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {webhook.active ? t("webhooks.pause") : t("webhooks.activate")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setConfirmRotate(true)}>
              <KeyRound aria-hidden="true" />
              {t("detail.rotateSecret")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setConfirmDelete(true)} variant="destructive">
              <Trash2 aria-hidden="true" />
              {t("webhooks.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      {!webhook.active ? (
        <Alert variant="warning">
          <Pause />
          <AlertTitle>{t("detail.pausedNotice.title")}</AlertTitle>
          <AlertDescription>{t("detail.pausedNotice.description")}</AlertDescription>
        </Alert>
      ) : null}

      <ConfigurationCard webhook={webhook} />
      <DeliveriesCard webhookId={webhook.id} webhookActive={webhook.active} />

      {editing ? (
        <WebhookFormDialog open webhook={webhook} onOpenChange={(open) => setEditing(open)} />
      ) : null}
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title={t("detail.rotateConfirm.title")}
        description={t("detail.rotateConfirm.description")}
        confirmLabel={t("detail.rotateConfirm.confirm")}
        pending={rotate.isPending}
        onConfirm={rotateSecret}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("webhooks.deleteConfirm.title")}
        description={t("webhooks.deleteConfirm.description", { url: displayUrl(webhook.url) })}
        confirmLabel={t("webhooks.deleteConfirm.confirm")}
        destructive
        pending={remove.isPending}
        onConfirm={deleteWebhook}
      />
      <SecretRevealDialog kind="secret" value={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function ConfigurationCard({ webhook }: { webhook: Webhook }) {
  const { t, relative, dateTime } = useIntegrationsFormat();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("detail.configuration")}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
          <div className="min-w-0 space-y-1 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t("detail.url")}</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {webhook.url}
              </code>
              {isInsecureUrl(webhook.url) ? <InsecureBadge /> : null}
            </dd>
          </div>
          <div className="min-w-0 space-y-1 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t("detail.events")}</dt>
            <dd className="flex flex-wrap gap-1.5">
              {webhook.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("detail.noEvents")}</p>
              ) : (
                webhook.events.map((event) => (
                  <Badge key={event} variant="secondary" title={event}>
                    {t(`events.${eventKey(event)}.label`)}
                  </Badge>
                ))
              )}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t("detail.status")}</dt>
            <dd className="flex flex-col items-start gap-1">
              <WebhookHealthBadge webhook={webhook} />
              <WebhookStatsLine webhook={webhook} />
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t("detail.secret")}</dt>
            <dd className={webhook.secretConfigured ? undefined : "text-destructive"}>
              {webhook.secretConfigured ? t("detail.secretConfigured") : t("detail.secretMissing")}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t("detail.created")}</dt>
            <dd title={dateTime(webhook.createdAt) ?? undefined}>{relative(webhook.createdAt)}</dd>
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t("detail.updated")}</dt>
            <dd title={dateTime(webhook.updatedAt) ?? undefined}>{relative(webhook.updatedAt)}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
