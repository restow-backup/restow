import { AlertTriangle, KeyRound, LockOpen, MessageSquare } from "lucide-react";
import * as React from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { zodResolver } from "@/lib/form";

import { SecretReveal } from "../components/secret-reveal";
import { useCreateWebhook, useRotateSecret, useUpdateWebhook } from "../hooks";
import {
  type WebhookFormValues,
  detectWebhookFormat,
  formatFollowsUrl,
  integrationErrorKey,
  isInsecureUrl,
  isSignedFormat,
  needsNewSecret,
  suggestedFormat,
  toWebhookInput,
  webhookFormFrom,
  webhookFormSchema,
  webhookPatch,
} from "../presenters";
import { WEBHOOK_FORMATS, type Webhook, type WebhookFormat } from "../types";
import { EventPicker } from "./event-picker";
import { useRuleCount } from "./rules-using-webhook";

interface WebhookFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The webhook to edit; omit to add a new one. */
  webhook?: Webhook;
  /** After a new webhook's secret was taken care of. */
  onCreated?: (webhookId: string) => void;
}

/**
 * Add or edit a webhook. A new webhook's signing secret is revealed once in
 * the same dialog, which can only be left after it was copied or its safe
 * storage confirmed; so is the new secret of a chat webhook switched to the
 * signed format. A webhook in a chat format (Discord, Slack, Teams) is sent
 * unsigned, so its secret is never shown.
 */
export function WebhookFormDialog({
  open,
  onOpenChange,
  webhook,
  onCreated,
}: WebhookFormDialogProps) {
  const [created, setCreated] = React.useState<{ id: string; secret: string } | null>(null);
  const [ready, setReady] = React.useState(false);

  const close = () => {
    setCreated(null);
    setReady(false);
    onOpenChange(false);
  };

  const finish = () => {
    const id = created?.id;
    close();
    if (id) {
      onCreated?.(id);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else if (created === null) {
          close();
        } else if (ready) {
          finish();
        }
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        onInteractOutside={(event) => {
          if (created !== null) {
            event.preventDefault();
          }
        }}
      >
        {created !== null ? (
          <SecretReveal
            kind="secret"
            value={created.secret}
            onReadyChange={setReady}
            onDone={finish}
          />
        ) : (
          <WebhookForm
            webhook={webhook}
            onSecret={setCreated}
            onDone={close}
            onCreatedUnsigned={(id) => {
              close();
              onCreated?.(id);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function WebhookForm({
  webhook,
  onSecret,
  onDone,
  onCreatedUnsigned,
}: {
  webhook?: Webhook;
  /** A secret to reveal: of a new signed webhook, or of one switched to the signed format. */
  onSecret: (created: { id: string; secret: string }) => void;
  onDone: () => void;
  /** A new chat webhook: there is no secret to show. */
  onCreatedUnsigned: (id: string) => void;
}) {
  const { t } = useTranslation("integrations");
  const create = useCreateWebhook();
  const update = useUpdateWebhook();
  const rotate = useRotateSecret();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  // The format follows the URL until it is picked by hand.
  const [followUrl, setFollowUrl] = React.useState(() => formatFollowsUrl(webhook));
  const form = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookFormSchema),
    defaultValues: webhookFormFrom(webhook),
  });
  const errors = form.formState.errors;
  const ruleCount = useRuleCount(webhook?.id);
  const url = useWatch({ control: form.control, name: "url" });
  const format = useWatch({ control: form.control, name: "format" });
  const detected = detectWebhookFormat(url ?? "");
  const reason = (message: string | undefined) =>
    message ? t(`webhookForm.errors.${message}`) : undefined;
  const busy = create.isPending || update.isPending || rotate.isPending;

  React.useEffect(() => {
    if (followUrl) {
      const next = suggestedFormat(url ?? "");
      if (form.getValues("format") !== next) {
        form.setValue("format", next, { shouldDirty: true });
      }
    }
  }, [url, followUrl, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      if (!webhook) {
        const result = await create.mutateAsync(toWebhookInput(values));
        toast.success(t("toasts.webhookCreated"));
        if (isSignedFormat(result.format)) {
          onSecret({ id: result.id, secret: result.secret });
        } else {
          onCreatedUnsigned(result.id);
        }
        return;
      }
      const patch = webhookPatch(values, webhook);
      if (Object.keys(patch).length > 0) {
        await update.mutateAsync({ id: webhook.id, patch });
        toast.success(t("toasts.webhookUpdated"));
      }
      if (needsNewSecret(webhook, values.format)) {
        // The secret of a chat webhook was never shown: the receiver gets a fresh one.
        const rotated = await rotate.mutateAsync(webhook.id);
        onSecret({ id: rotated.id, secret: rotated.secret });
        return;
      }
      onDone();
    } catch (error) {
      setSubmitError(error);
    }
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {webhook ? t("webhookForm.editTitle") : t("webhookForm.createTitle")}
        </DialogTitle>
        <DialogDescription>{t("webhookForm.description")}</DialogDescription>
      </DialogHeader>

      <form id="webhook-form" onSubmit={onSubmit} noValidate className="space-y-5">
        <Field
          id="webhook-url"
          label={t("webhookForm.url")}
          hint={t("webhookForm.urlHint")}
          error={reason(errors.url?.message)}
        >
          <Input
            id="webhook-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("webhookForm.urlPlaceholder")}
            aria-invalid={errors.url !== undefined}
            aria-describedby={messageId("webhook-url")}
            className="font-mono text-xs"
            {...form.register("url")}
          />
        </Field>
        {isInsecureUrl(url ?? "") && !errors.url ? (
          <Alert variant="warning">
            <LockOpen />
            <AlertDescription>{t("webhooks.insecureHint")}</AlertDescription>
          </Alert>
        ) : null}

        <Controller
          control={form.control}
          name="format"
          render={({ field }) => (
            <Field
              id="webhook-format"
              label={t("webhookForm.format")}
              hint={
                detected !== null && detected === field.value
                  ? `${t(`formats.${field.value}.description`)} ${t("webhookForm.formatDetected")}`
                  : t(`formats.${field.value}.description`)
              }
            >
              <Select
                value={field.value}
                onValueChange={(value) => {
                  setFollowUrl(false);
                  field.onChange(value as WebhookFormat);
                }}
              >
                <SelectTrigger
                  id="webhook-format"
                  className="w-full sm:w-80"
                  aria-describedby={messageId("webhook-format")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEBHOOK_FORMATS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`formats.${option}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />
        {!isSignedFormat(format) ? (
          <Alert variant="info">
            <MessageSquare />
            <AlertDescription>{t("webhookForm.chatUnsigned")}</AlertDescription>
          </Alert>
        ) : needsNewSecret(webhook, format) ? (
          <Alert variant="info">
            <KeyRound />
            <AlertDescription>{t("webhookForm.newSecret")}</AlertDescription>
          </Alert>
        ) : null}

        <Field
          id="webhook-name"
          label={t("webhookForm.name")}
          hint={t("webhookForm.nameHint")}
          error={reason(errors.name?.message)}
        >
          <Input
            id="webhook-name"
            autoComplete="off"
            maxLength={100}
            placeholder={t("webhookForm.namePlaceholder")}
            aria-invalid={errors.name !== undefined}
            aria-describedby={messageId("webhook-name")}
            {...form.register("name")}
          />
        </Field>

        <Controller
          control={form.control}
          name="events"
          render={({ field }) => (
            <EventPicker
              value={field.value}
              onChange={field.onChange}
              error={reason(errors.events?.message)}
              rules={ruleCount}
            />
          )}
        />

        <Controller
          control={form.control}
          name="active"
          render={({ field }) => (
            <div className="flex items-start gap-3">
              <Switch
                id="webhook-active"
                checked={field.value}
                onCheckedChange={field.onChange}
                aria-describedby="webhook-active-hint"
              />
              <div className="space-y-0.5">
                <Label htmlFor="webhook-active">{t("webhookForm.active")}</Label>
                <p id="webhook-active-hint" className="text-xs text-muted-foreground">
                  {t("webhookForm.activeHint")}
                </p>
              </div>
            </div>
          )}
        />

        {submitError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{t(integrationErrorKey(submitError))}</AlertDescription>
          </Alert>
        ) : null}
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" form="webhook-form" loading={busy}>
          {webhook ? t("webhookForm.submitEdit") : t("webhookForm.submitCreate")}
        </Button>
      </DialogFooter>
    </>
  );
}
