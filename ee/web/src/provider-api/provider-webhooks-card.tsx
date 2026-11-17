import { Plus, Webhook } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, EmptyState, ErrorState } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SecretRevealDialog } from "@/features/integrations/components/secret-reveal";
import { errorMessageKey } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import { PROVIDER_API_NAMESPACE } from "./i18n";
import {
  type ProviderWebhook,
  useCreateProviderWebhook,
  useDeleteProviderWebhook,
  useProviderWebhooks,
  useRotateProviderWebhookSecret,
  useSetProviderWebhookActive,
  useTestProviderWebhook,
  webhookState,
} from "./webhooks-api";

const STATE_BADGE = {
  active: "info",
  paused: "secondary",
  failing: "warning",
} as const;

/**
 * Installation › Provider API, the provider's own webhooks (0.6.0): events of the installation,
 * first `billing.period_closed`, signed with each webhook's secret. Every provider role sees them;
 * the owner adds, tests, pauses, renews the secret and deletes (`canChange`). The secret is shown
 * once, after adding or renewing.
 */
export function ProviderWebhooksCard({ canChange }: { canChange: boolean }) {
  const { t, i18n } = useTranslation(PROVIDER_API_NAMESPACE);
  const { t: tCommon } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const query = useProviderWebhooks(true);
  const create = useCreateProviderWebhook();
  const setActive = useSetProviderWebhookActive();
  const remove = useDeleteProviderWebhook();
  const rotate = useRotateProviderWebhookSecret();
  const test = useTestProviderWebhook();
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [secret, setSecret] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<ProviderWebhook | null>(null);
  const [rotating, setRotating] = React.useState<ProviderWebhook | null>(null);
  const date = (iso: string) => formatDateTime(iso, language) ?? iso;
  const failed = (error: unknown, title: string) =>
    toast.error(title, { description: tCommon(errorMessageKey(error)) });

  const items = query.data?.items ?? [];

  return (
    <Card data-slot="provider-webhooks">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle>{t("webhooks.title")}</CardTitle>
          <CardDescription className="max-w-prose">{t("webhooks.description")}</CardDescription>
        </div>
        <Button
          variant="outline"
          disabled={!canChange}
          onClick={() => {
            setName("");
            setUrl("");
            setAdding(true);
          }}
        >
          <Plus aria-hidden="true" />
          {t("webhooks.create")}
        </Button>
      </CardHeader>
      <CardContent>
        {query.isError ? (
          <ErrorState
            title={t("webhooks.loadError")}
            error={query.error}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        ) : !query.data ? (
          <Skeleton className="h-24 w-full" />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Webhook}
            title={t("webhooks.empty.title")}
            description={t("webhooks.empty.description")}
          />
        ) : (
          <Table className="min-w-[44rem]" scrollLabel={t("webhooks.caption")}>
            <TableCaption className="sr-only">{t("webhooks.caption")}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("webhooks.columns.webhook")}</TableHead>
                <TableHead scope="col">{t("webhooks.columns.events")}</TableHead>
                <TableHead scope="col">{t("webhooks.columns.state")}</TableHead>
                <TableHead scope="col">{t("webhooks.columns.lastDelivery")}</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">{t("webhooks.columns.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((hook) => {
                const state = webhookState(hook);
                return (
                  <TableRow key={hook.id} data-webhook={hook.id}>
                    <TableCell className="max-w-72">
                      <span className="block font-medium">{hook.name ?? hook.url}</span>
                      {hook.name ? (
                        <span className="block break-all text-xs text-muted-foreground">
                          {hook.url}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{hook.events.join(", ")}</TableCell>
                    <TableCell>
                      <Badge variant={STATE_BADGE[state]}>{t(`webhooks.state.${state}`)}</Badge>
                      {state === "failing" && hook.failingSince ? (
                        <span className="block text-xs text-muted-foreground">
                          {t("webhooks.failingSince", { date: date(hook.failingSince) })}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {hook.lastDelivery ? (
                        <>
                          <span className="block">
                            {t(`webhooks.delivery.${hook.lastDelivery.status}`)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {hook.lastDelivery.event}, {date(hook.lastDelivery.createdAt)}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{t("webhooks.noDelivery")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canChange || !hook.active}
                          onClick={() =>
                            test.mutate(hook.id, {
                              onSuccess: () => toast.success(t("webhooks.tested")),
                              onError: (error) => failed(error, t("webhooks.testFailed")),
                            })
                          }
                        >
                          {t("webhooks.actions.test")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canChange}
                          onClick={() =>
                            setActive.mutate(
                              { id: hook.id, active: !hook.active },
                              {
                                onSuccess: () => toast.success(t("webhooks.toggled")),
                                onError: (error) => failed(error, t("webhooks.toggleFailed")),
                              },
                            )
                          }
                        >
                          {hook.active ? t("webhooks.actions.pause") : t("webhooks.actions.resume")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canChange}
                          onClick={() => setRotating(hook)}
                        >
                          {t("webhooks.actions.rotate")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canChange}
                          onClick={() => setDeleting(hook)}
                        >
                          {t("webhooks.actions.delete")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <ConfirmDialog
        open={adding}
        onOpenChange={setAdding}
        title={t("webhooks.form.title")}
        description={t("webhooks.form.description")}
        confirmLabel={t("webhooks.form.confirm")}
        confirmDisabled={url.trim().length === 0}
        onConfirm={async () => {
          const created = await create.mutateAsync({
            name: name.trim() || null,
            url: url.trim(),
          });
          toast.success(t("webhooks.created"));
          setSecret(created.secret);
        }}
      >
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="provider-webhook-name">{t("webhooks.form.name")}</Label>
            <Input
              id="provider-webhook-name"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="provider-webhook-url">{t("webhooks.form.url")}</Label>
            <Input
              id="provider-webhook-url"
              type="url"
              inputMode="url"
              value={url}
              placeholder="https://"
              aria-describedby="provider-webhook-url-hint"
              onChange={(event) => setUrl(event.target.value)}
            />
            <p id="provider-webhook-url-hint" className="text-xs text-muted-foreground">
              {t("webhooks.form.urlHint")}
            </p>
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title={t("webhooks.rotateDialog.title")}
        description={t("webhooks.rotateDialog.description")}
        confirmLabel={t("webhooks.rotateDialog.confirm")}
        onConfirm={async () => {
          if (!rotating) return;
          const rotated = await rotate.mutateAsync(rotating.id);
          setSecret(rotated.secret);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("webhooks.deleteDialog.title")}
        description={t("webhooks.deleteDialog.description")}
        confirmLabel={t("webhooks.deleteDialog.confirm")}
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await remove.mutateAsync(deleting.id);
          toast.success(t("webhooks.deleted"));
        }}
      />

      {secret !== null ? (
        <SecretRevealDialog kind="secret" value={secret} onClose={() => setSecret(null)} />
      ) : null}
    </Card>
  );
}
