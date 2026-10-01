import { useNavigate } from "@tanstack/react-router";
import { PlugZap, TriangleAlert } from "lucide-react";
import * as React from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
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
import { zodResolver } from "@/lib/form";
import {
  IMAP_AUTH_MODES,
  IMAP_SECURITY,
  type ImapFormValues,
  MASTER_USER_STYLES,
  type StoredImapConnection,
  emptyImapForm,
  fieldMessageKey,
  imapFormFromStored,
  imapFormSchema,
  needsPasswordAgain,
  portForSecurity,
  toCreateImapInput,
  toImapTestInput,
  toUpdateImapInput,
} from "../forms";
import { sourceDetailTo } from "../paths";
import { problemField, sourceErrorKey } from "../presenters";
import type { ImapSecurity, SourceDto } from "../types";
import { useCreateSource, useInlineImapTest, useTestSource, useUpdateSource } from "../use-sources";
import { ProbeResult } from "./probe-result";

interface ImapSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The source to edit; omit to create a new one. */
  source?: SourceDto;
}

function storedConnection(source: SourceDto | undefined): StoredImapConnection | null {
  if (!source?.imap) {
    return null;
  }
  return {
    name: source.name,
    host: source.imap.host,
    port: source.imap.port,
    security: source.imap.security,
    username: source.imap.username,
    imapAuthMode: source.imap.imapAuthMode,
    masterUser: source.imap.masterUser,
  };
}

/**
 * Create or edit an IMAP source. The connection can be tested before saving;
 * after saving, the stored connection is tested once more so the status on
 * the detail page reflects what was actually stored.
 */
export function ImapSourceDialog({ open, onOpenChange, source }: ImapSourceDialogProps) {
  const { t } = useTranslation("sources");
  const editing = source !== undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? t("form.imap.editTitle") : t("form.imap.title")}</DialogTitle>
          <DialogDescription>{t("form.imap.description")}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts from the stored values. */}
        <ImapSourceForm source={source} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function connectionKey(values: ImapFormValues): string {
  return [
    values.host,
    values.port,
    values.security,
    values.username,
    values.password,
    values.imapAuthMode,
  ].join("\n");
}

function ImapSourceForm({ source, onDone }: { source?: SourceDto; onDone: () => void }) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const stored = storedConnection(source);

  const form = useForm<ImapFormValues>({
    resolver: zodResolver(imapFormSchema(stored)),
    defaultValues: stored ? imapFormFromStored(stored) : emptyImapForm,
  });
  const create = useCreateSource();
  const update = useUpdateSource(source?.id ?? "");
  const storedTest = useTestSource();
  const inlineTest = useInlineImapTest();
  const [testedKey, setTestedKey] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const values = useWatch({ control: form.control }) as ImapFormValues;
  const passwordAgain = stored !== null && needsPasswordAgain(values, stored);
  // A test result describes the values it ran with; once they change it is hidden.
  const testIsCurrent = testedKey === connectionKey(values);

  const message = (name: keyof ImapFormValues) => {
    const key = fieldMessageKey(form.formState.errors[name]);
    return key ? tc(key) : undefined;
  };

  const runInlineTest = async () => {
    if (!(await form.trigger(["host", "port", "username"]))) {
      return;
    }
    const current = form.getValues();
    const input = toImapTestInput(
      current,
      source && stored ? { sourceId: source.id, connection: stored } : null,
    );
    if (!input) {
      form.setError("password", { message: stored ? "passwordAgain" : "required" });
      return;
    }
    setTestedKey(connectionKey(current));
    inlineTest.mutate(input);
  };

  const onSubmit = form.handleSubmit(async (submitted) => {
    setSubmitError(null);
    try {
      if (!source || !stored) {
        const created = await create.mutateAsync(toCreateImapInput(submitted));
        toast.success(t("toasts.created"));
        onDone();
        // per_mailbox has no source-level login to test (every mailbox
        // carries its own instead); firing this would always fail silently.
        if (submitted.imapAuthMode !== "per_mailbox") {
          storedTest.mutate(created.id);
        }
        await navigate({ to: sourceDetailTo(created.id) });
        return;
      }
      const patch = toUpdateImapInput(submitted, stored);
      if (Object.keys(patch).length === 0) {
        onDone();
        return;
      }
      await update.mutateAsync(patch);
      toast.success(t("toasts.updated"));
      onDone();
      if (
        submitted.imapAuthMode !== "per_mailbox" &&
        Object.keys(patch).some((key) => key !== "name")
      ) {
        storedTest.mutate(source.id);
      }
    } catch (error) {
      const field = problemField(error);
      if (field === "name" || field === "password") {
        form.setError(field, { message: sourceErrorKey(error) }, { shouldFocus: true });
      } else {
        setSubmitError(error);
      }
    }
  });

  const busy = form.formState.isSubmitting;

  return (
    <>
      <form id="imap-source-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <Field id="imap-name" label={t("form.name")} error={message("name")}>
          <Input
            id="imap-name"
            autoComplete="off"
            placeholder={t("form.namePlaceholderImap")}
            aria-invalid={form.formState.errors.name !== undefined}
            aria-describedby={messageId("imap-name")}
            {...form.register("name")}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-[1fr_6rem]">
          <Field id="imap-host" label={t("form.imap.host")} error={message("host")}>
            <Input
              id="imap-host"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("form.imap.hostPlaceholder")}
              aria-invalid={form.formState.errors.host !== undefined}
              aria-describedby={messageId("imap-host")}
              {...form.register("host")}
            />
          </Field>
          <Field id="imap-port" label={t("form.imap.port")} error={message("port")}>
            <Input
              id="imap-port"
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={form.formState.errors.port !== undefined}
              aria-describedby={messageId("imap-port")}
              {...form.register("port")}
            />
          </Field>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="imap-security">{t("form.imap.security")}</Label>
          <Controller
            control={form.control}
            name="security"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  const next = value as ImapSecurity;
                  field.onChange(next);
                  form.setValue("port", portForSecurity(form.getValues("port"), next));
                }}
              >
                <SelectTrigger id="imap-security" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMAP_SECURITY.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`form.imap.securityOptions.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          {values.security === "none" ? (
            <Alert variant="warning" className="mt-2">
              <TriangleAlert />
              <AlertDescription>{t("form.imap.securityNoneWarning")}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="imap-auth-mode">{t("form.imap.authMode.label")}</Label>
          <Controller
            control={form.control}
            name="imapAuthMode"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="imap-auth-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {IMAP_AUTH_MODES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`form.imap.authMode.options.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <p className="text-xs text-muted-foreground">
            {t(`form.imap.authMode.explain.${values.imapAuthMode}`)}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="imap-username"
            label={t("form.imap.username")}
            error={message("username")}
            hint={
              values.imapAuthMode === "master_user"
                ? t("form.imap.usernameHintMasterUser")
                : values.imapAuthMode === "per_mailbox"
                  ? t("form.imap.usernameHintPerMailbox")
                  : undefined
            }
          >
            <Input
              id="imap-username"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("form.imap.usernamePlaceholder")}
              aria-invalid={form.formState.errors.username !== undefined}
              aria-describedby={messageId("imap-username")}
              {...form.register("username")}
            />
          </Field>
          {values.imapAuthMode === "per_mailbox" ? (
            <div className="space-y-1.5">
              <Label>{t("form.imap.password")}</Label>
              <p className="text-sm text-muted-foreground">
                {t("form.imap.authMode.perMailboxPasswordHint")}
              </p>
            </div>
          ) : (
            <Field
              id="imap-password"
              label={t("form.imap.password")}
              error={message("password")}
              hint={
                !stored
                  ? t("form.imap.passwordHint")
                  : passwordAgain
                    ? t("form.imap.passwordAgain")
                    : t("form.imap.passwordKeep")
              }
            >
              <PasswordInput
                id="imap-password"
                autoComplete="new-password"
                aria-invalid={form.formState.errors.password !== undefined}
                aria-describedby={messageId("imap-password")}
                {...form.register("password")}
              />
            </Field>
          )}
        </div>

        {values.imapAuthMode === "master_user" ? (
          <div className="grid gap-4 rounded-lg border border-border p-3 sm:grid-cols-2">
            <Field
              id="imap-master-username"
              label={t("form.imap.authMode.masterUsername")}
              error={message("masterUsername")}
              hint={t("form.imap.authMode.masterUsernameHint")}
            >
              <Input
                id="imap-master-username"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={form.formState.errors.masterUsername !== undefined}
                aria-describedby={messageId("imap-master-username")}
                {...form.register("masterUsername")}
              />
            </Field>
            <div className="space-y-1.5">
              <Label htmlFor="imap-master-style">{t("form.imap.authMode.masterStyle")}</Label>
              <Controller
                control={form.control}
                name="masterUserStyle"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="imap-master-style" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MASTER_USER_STYLES.map((option) => (
                        <SelectItem key={option} value={option}>
                          {t(`form.imap.authMode.masterStyleOptions.${option}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            {values.masterUserStyle === "dovecot_separator" ? (
              <Field
                id="imap-master-separator"
                label={t("form.imap.authMode.masterSeparator")}
                hint={t("form.imap.authMode.masterSeparatorHint")}
              >
                <Input
                  id="imap-master-separator"
                  autoComplete="off"
                  placeholder="*"
                  maxLength={4}
                  aria-describedby={messageId("imap-master-separator")}
                  {...form.register("masterUserSeparator")}
                />
              </Field>
            ) : null}
          </div>
        ) : null}

        {values.imapAuthMode === "per_mailbox" ? (
          <Alert>
            <AlertDescription>{t("form.imap.authMode.perMailboxTestHint")}</AlertDescription>
          </Alert>
        ) : values.imapAuthMode === "master_user" ? (
          // The real login is the master account impersonating a mailbox, not
          // `values.username` (a label only): there is no mailbox to
          // impersonate before the source is saved, so an inline test here
          // could only run the weaker bare master login and risks being read
          // as proof of the per-mailbox login the worker actually uses.
          // Saving runs that bare check automatically; the authoritative
          // per-mailbox "Test login" (directory) proves the real shape.
          <Alert>
            <AlertDescription>{t("form.imap.authMode.masterUserTestHint")}</AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground">{t("form.imap.testHint")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runInlineTest()}
                loading={inlineTest.isPending}
                disabled={busy}
                className="shrink-0"
              >
                {inlineTest.isPending ? null : <PlugZap />}
                {t("actions.test")}
              </Button>
            </div>
            {testIsCurrent && inlineTest.data ? (
              <ProbeResult probe={inlineTest.data} compact />
            ) : null}
            {testIsCurrent && inlineTest.error ? (
              <p role="alert" className="text-sm text-destructive">
                {tc(sourceErrorKey(inlineTest.error))}
              </p>
            ) : null}
          </div>
        )}

        {submitError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(sourceErrorKey(submitError))}</AlertDescription>
          </Alert>
        ) : null}
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" form="imap-source-form" loading={busy}>
          {stored ? tc("actions.save") : t("actions.create")}
        </Button>
      </DialogFooter>
    </>
  );
}
