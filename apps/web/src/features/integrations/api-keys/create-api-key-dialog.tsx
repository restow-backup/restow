import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { zodResolver } from "@/lib/form";

import { SecretReveal } from "../components/secret-reveal";
import { useCreateApiKey } from "../hooks";
import {
  type ApiKeyFormValues,
  EXPIRY_OPTIONS,
  type ExpiryOption,
  SCOPE_GROUPS,
  apiKeyFormSchema,
  emptyApiKeyForm,
  integrationErrorKey,
  scopeKey,
  toCreateApiKeyInput,
  toggleItem,
} from "../presenters";
import { API_SCOPES, type ApiKeyKind, type ApiScope } from "../types";

interface CreateApiKeyDialogProps {
  kind: ApiKeyKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Create a tenant or provider key: name, scopes, expiry. After creation the
 * same dialog reveals the token once and can only be left once it is copied
 * or its safe storage confirmed.
 */
export function CreateApiKeyDialog({ kind, open, onOpenChange }: CreateApiKeyDialogProps) {
  const [token, setToken] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);

  const close = () => {
    setToken(null);
    setReady(false);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
        } else if (token === null || ready) {
          close();
        }
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"
        onInteractOutside={(event) => {
          if (token !== null) {
            event.preventDefault();
          }
        }}
      >
        {token !== null ? (
          <SecretReveal kind="key" value={token} onReadyChange={setReady} onDone={close} />
        ) : (
          <CreateApiKeyForm kind={kind} onCreated={setToken} onCancel={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateApiKeyForm({
  kind,
  onCreated,
  onCancel,
}: {
  kind: ApiKeyKind;
  onCreated: (token: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("integrations");
  const create = useCreateApiKey(kind);
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const form = useForm<ApiKeyFormValues>({
    resolver: zodResolver(apiKeyFormSchema),
    defaultValues: emptyApiKeyForm,
  });
  const errors = form.formState.errors;
  const reason = (message: string | undefined) =>
    message ? t(`createKey.errors.${message}`) : undefined;

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const created = await create.mutateAsync(toCreateApiKeyInput(values));
      toast.success(t("toasts.keyCreated"));
      onCreated(created.token);
    } catch (error) {
      setSubmitError(error);
    }
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {kind === "provider" ? t("createKey.providerTitle") : t("createKey.title")}
        </DialogTitle>
        <DialogDescription>
          {kind === "provider" ? t("createKey.providerDescription") : t("createKey.description")}
        </DialogDescription>
      </DialogHeader>

      <form id="create-api-key" onSubmit={onSubmit} noValidate className="space-y-5">
        <Field
          id="api-key-name"
          label={t("createKey.name")}
          hint={t("createKey.nameHint")}
          error={reason(errors.name?.message)}
        >
          <Input
            id="api-key-name"
            autoComplete="off"
            maxLength={100}
            placeholder={t("createKey.namePlaceholder")}
            aria-invalid={errors.name !== undefined}
            aria-describedby={messageId("api-key-name")}
            {...form.register("name")}
          />
        </Field>

        <Controller
          control={form.control}
          name="scopes"
          render={({ field }) => (
            <ScopePicker
              value={field.value}
              onChange={field.onChange}
              error={reason(errors.scopes?.message)}
            />
          )}
        />

        <Field id="api-key-expiry" label={t("createKey.expiry")} hint={t("createKey.expiryHint")}>
          <Controller
            control={form.control}
            name="expiry"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => field.onChange(value as ExpiryOption)}
              >
                <SelectTrigger
                  id="api-key-expiry"
                  className="w-full sm:w-60"
                  aria-describedby={messageId("api-key-expiry")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`createKey.expiryOptions.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>

        {submitError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{t(integrationErrorKey(submitError))}</AlertDescription>
          </Alert>
        ) : null}
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={create.isPending}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="submit" form="create-api-key" loading={create.isPending}>
          {t("createKey.submit")}
        </Button>
      </DialogFooter>
    </>
  );
}

function ScopePicker({
  value,
  onChange,
  error,
}: {
  value: ApiScope[];
  onChange: (scopes: ApiScope[]) => void;
  error: string | undefined;
}) {
  const { t } = useTranslation("integrations");
  return (
    <fieldset className="space-y-3" aria-describedby="api-key-scopes-message">
      <legend className="text-sm font-medium">{t("createKey.scopes")}</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {SCOPE_GROUPS.map((group) => (
          <div key={group.id} className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(`scopes.groups.${group.id}`)}
            </p>
            <ul className="space-y-2">
              {group.scopes.map((scope) => {
                const id = `scope-${scopeKey(scope)}`;
                return (
                  <li key={scope}>
                    <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
                      <Checkbox
                        id={id}
                        checked={value.includes(scope)}
                        onCheckedChange={(checked) =>
                          onChange(toggleItem(value, scope, checked === true, API_SCOPES))
                        }
                        className="mt-0.5"
                      />
                      <span className="space-y-0.5">
                        <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                          {t(`scopes.${scopeKey(scope)}.label`)}
                          <code className="text-xs font-normal text-muted-foreground">{scope}</code>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t(`scopes.${scopeKey(scope)}.description`)}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <p
        id="api-key-scopes-message"
        role={error ? "alert" : undefined}
        className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
      >
        {error ?? t("createKey.scopesHint")}
      </p>
    </fieldset>
  );
}
