import { CircleCheck, Info, TriangleAlert, Upload } from "lucide-react";
import * as React from "react";
import {
  Controller,
  type FieldError,
  type FieldPath,
  type UseFormReturn,
  useWatch,
} from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { DisabledReason } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import type { MailTransport, SmtpSecurity } from "@/lib/api";
import type { CredentialKind, GraphMailApp, InstallationSettings } from "../api";
import {
  type MailFormValues,
  SMTP_SECURITY,
  fieldMessageKey,
  mailFormContext,
  mayKeepGraphCredential,
  mayKeepStoredPassword,
  portForSecurity,
  previewServiceAccountKey,
} from "../forms";
import { GoogleMailGuide, GraphMailGuide } from "./mail-guides";

/** Files larger than this are not a PEM bundle or a service account key. */
const MAX_TEXT_FILE_BYTES = 64 * 1024;

type MailForm = UseFormReturn<MailFormValues>;

function useFieldMessage() {
  const { t: tc } = useTranslation();
  return (error: FieldError | undefined) => {
    const key = fieldMessageKey(error);
    return key ? tc(key) : undefined;
  };
}

/** A textarea that also takes its content from a file (PEM bundle, JSON key). */
function TextFileField({
  form,
  id,
  name,
  label,
  hint,
  error,
  accept,
  uploadLabel,
  failedLabel,
  placeholder,
  children,
}: {
  form: MailForm;
  id: string;
  name: FieldPath<MailFormValues>;
  label: string;
  hint: string;
  error: string | undefined;
  accept: string;
  uploadLabel: string;
  failedLabel: string;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const readFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    try {
      const list = [...files];
      if (list.some((file) => file.size > MAX_TEXT_FILE_BYTES)) {
        throw new Error("file too large");
      }
      // A key and a certificate may come as two files; one text holds both.
      const texts = await Promise.all(list.map((file) => file.text()));
      form.setValue(name, texts.map((text) => text.trim()).join("\n"), {
        shouldDirty: true,
        shouldValidate: true,
      });
    } catch {
      toast.error(failedLabel);
    } finally {
      if (fileRef.current) {
        fileRef.current.value = "";
      }
    }
  };

  return (
    <Field id={id} label={label} hint={hint} error={error} className="sm:col-span-2">
      <Textarea
        id={id}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        className="max-h-72 min-h-32 font-mono text-xs md:text-xs"
        aria-invalid={error !== undefined}
        aria-describedby={messageId(id)}
        {...form.register(name)}
      />
      <input
        ref={fileRef}
        type="file"
        accept={accept}
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void readFiles(event.target.files)}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => fileRef.current?.click()}
        >
          <Upload />
          {uploadLabel}
        </Button>
        {children}
      </div>
    </Field>
  );
}

export function MailFields({ form, settings }: { form: MailForm; settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const transport = useWatch({ control: form.control, name: "transport" });
  const stored = settings.mail.transport;
  const context = mailFormContext(settings);
  const storedCredential =
    context.storedSmtp?.passwordStored === true ||
    context.storedGraphOwn?.credentialStored === true ||
    context.googleKeyStored;

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="settings-mail-transport">{t("mail.transport.label")}</Label>
        <Controller
          control={form.control}
          name="transport"
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(value) => {
                field.onChange(value as MailTransport);
                form.clearErrors();
              }}
            >
              <SelectTrigger id="settings-mail-transport" className="w-full sm:max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smtp">{t("mail.transport.smtp")}</SelectItem>
                <SelectItem value="graph">{t("mail.transport.graph")}</SelectItem>
                <SelectItem value="google">{t("mail.transport.google")}</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {stored !== null && transport !== stored && storedCredential ? (
        <p className="text-xs text-muted-foreground">{t("mail.switchRemovesCredential")}</p>
      ) : null}

      {transport === "smtp" ? <SmtpFields form={form} settings={settings} /> : null}
      {transport === "graph" ? <GraphFields form={form} settings={settings} /> : null}
      {transport === "google" ? <GoogleFields form={form} settings={settings} /> : null}
    </>
  );
}

function SmtpFields({ form, settings }: { form: MailForm; settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const message = useFieldMessage();
  const smtp = useWatch({ control: form.control, name: "smtp" });
  const errors = form.formState.errors;
  const context = mailFormContext(settings);

  const storedPassword = context.storedSmtp?.passwordStored === true;
  const passwordHint = !storedPassword
    ? t("mail.smtp.passwordHint")
    : mayKeepStoredPassword(smtp, context.storedSmtp)
      ? t("mail.smtp.passwordKeep")
      : t("mail.smtp.passwordAgain");

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id="settings-smtp-host" label={t("mail.smtp.host")} error={message(errors.smtp?.host)}>
        <Input
          id="settings-smtp-host"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("mail.smtp.hostPlaceholder")}
          aria-invalid={errors.smtp?.host !== undefined}
          aria-describedby={messageId("settings-smtp-host")}
          {...form.register("smtp.host")}
        />
      </Field>

      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="settings-smtp-security">{t("mail.smtp.security")}</Label>
          <Controller
            control={form.control}
            name="smtp.security"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={(value) => {
                  const next = value as SmtpSecurity;
                  field.onChange(next);
                  form.setValue("smtp.port", portForSecurity(form.getValues("smtp.port"), next), {
                    shouldDirty: true,
                  });
                }}
              >
                <SelectTrigger id="settings-smtp-security" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SMTP_SECURITY.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`mail.smtp.securityOptions.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <Field
          id="settings-smtp-port"
          label={t("mail.smtp.port")}
          error={message(errors.smtp?.port)}
        >
          <Input
            id="settings-smtp-port"
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={errors.smtp?.port !== undefined}
            aria-describedby={messageId("settings-smtp-port")}
            {...form.register("smtp.port")}
          />
        </Field>
      </div>

      {smtp.security === "none" ? (
        <Alert variant="warning" className="sm:col-span-2">
          <TriangleAlert />
          <AlertDescription>{t("mail.smtp.securityNoneWarning")}</AlertDescription>
        </Alert>
      ) : null}

      <Field
        id="settings-smtp-username"
        label={t("mail.smtp.username")}
        hint={t("mail.smtp.usernameHint")}
        error={message(errors.smtp?.username)}
      >
        <Input
          id="settings-smtp-username"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.smtp?.username !== undefined}
          aria-describedby={messageId("settings-smtp-username")}
          {...form.register("smtp.username")}
        />
      </Field>

      <Field
        id="settings-smtp-password"
        label={t("mail.smtp.password")}
        hint={passwordHint}
        error={message(errors.smtp?.password)}
      >
        <PasswordInput
          id="settings-smtp-password"
          autoComplete="new-password"
          aria-invalid={errors.smtp?.password !== undefined}
          aria-describedby={messageId("settings-smtp-password")}
          {...form.register("smtp.password")}
        />
      </Field>

      <Field
        id="settings-smtp-from"
        label={t("mail.smtp.from")}
        error={message(errors.smtp?.from)}
        className="sm:col-span-2"
      >
        <Input
          id="settings-smtp-from"
          type="email"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("mail.smtp.fromPlaceholder")}
          aria-invalid={errors.smtp?.from !== undefined}
          aria-describedby={messageId("settings-smtp-from")}
          {...form.register("smtp.from")}
        />
      </Field>
    </div>
  );
}

function GraphAppChoice({ form, settings }: { form: MailForm; settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const backupAvailable = settings.capabilities.graphMail.appConfigured;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{t("mail.graph.app.label")}</legend>
      <Controller
        control={form.control}
        name="graph.app"
        render={({ field }) => {
          // A stored choice of the backup app stays selectable, so it can be kept or left.
          const backupDisabled = !backupAvailable && field.value !== "backup";
          return (
            <RadioGroup
              value={field.value}
              onValueChange={(value) => {
                field.onChange(value as GraphMailApp);
                form.clearErrors("graph");
              }}
              className="gap-3"
            >
              <div className="flex items-start gap-3">
                <RadioGroupItem id="settings-graph-app-own" value="own" className="mt-0.5" />
                <div className="space-y-0.5">
                  <Label htmlFor="settings-graph-app-own" className="cursor-pointer">
                    {t("mail.graph.app.own")}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t("mail.graph.app.ownHint")}</p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <DisabledReason
                  reason={backupDisabled ? t("mail.graph.app.backupUnavailable") : null}
                >
                  <RadioGroupItem
                    id="settings-graph-app-backup"
                    value="backup"
                    className="mt-0.5"
                    disabled={backupDisabled}
                  />
                </DisabledReason>
                <div className="space-y-0.5">
                  <Label htmlFor="settings-graph-app-backup" className="cursor-pointer">
                    {t("mail.graph.app.backup")}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {backupAvailable
                      ? t("mail.graph.app.backupHint")
                      : t("mail.graph.app.backupUnavailable")}
                  </p>
                </div>
              </div>
            </RadioGroup>
          );
        }}
      />
    </fieldset>
  );
}

function GraphFields({ form, settings }: { form: MailForm; settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const message = useFieldMessage();
  const graph = useWatch({ control: form.control, name: "graph" });
  const errors = form.formState.errors.graph;
  const context = mailFormContext(settings);
  const { graphMail } = settings.capabilities;

  return (
    <div className="space-y-4">
      <Alert variant="info">
        <Info />
        <AlertDescription>{t("mail.graph.hint")}</AlertDescription>
      </Alert>

      <GraphAppChoice form={form} settings={settings} />

      {graph.app === "backup" && !graphMail.appConfigured ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>{t("mail.graph.appMissing.title")}</AlertTitle>
          <AlertDescription>{t("mail.graph.appMissing.description")}</AlertDescription>
        </Alert>
      ) : null}

      {graph.app === "own" ? (
        <GraphMailGuide
          clientId={graph.clientId}
          sender={graph.sender}
          defaultOpen={context.storedGraphOwn === null}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="settings-graph-sender"
          label={t("mail.graph.sender")}
          hint={t("mail.graph.senderHint")}
          error={message(errors?.sender)}
        >
          <Input
            id="settings-graph-sender"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("mail.graph.senderPlaceholder")}
            aria-invalid={errors?.sender !== undefined}
            aria-describedby={messageId("settings-graph-sender")}
            {...form.register("graph.sender")}
          />
        </Field>

        {graph.app === "own" ? (
          <OwnAppFields form={form} settings={settings} />
        ) : (
          <Field
            id="settings-graph-tenant"
            label={t("mail.graph.tenantId")}
            hint={
              graphMail.defaultTenantId
                ? t("mail.graph.tenantIdDefault", { tenant: graphMail.defaultTenantId })
                : t("mail.graph.tenantIdHint")
            }
            error={message(errors?.tenantId)}
          >
            <Input
              id="settings-graph-tenant"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("mail.graph.tenantIdPlaceholder")}
              aria-invalid={errors?.tenantId !== undefined}
              aria-describedby={messageId("settings-graph-tenant")}
              {...form.register("graph.tenantId")}
            />
          </Field>
        )}
      </div>
    </div>
  );
}

function OwnAppFields({ form, settings }: { form: MailForm; settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const message = useFieldMessage();
  const graph = useWatch({ control: form.control, name: "graph" });
  const errors = form.formState.errors.graph;
  const stored = mailFormContext(settings).storedGraphOwn;
  const keep = mayKeepGraphCredential(graph, stored);
  const credentialHint = (kind: CredentialKind) => {
    const prefix = kind === "secret" ? "clientSecret" : "certificate";
    if (!stored?.credentialStored) {
      return t(`mail.graph.${prefix}Hint`);
    }
    return keep ? t(`mail.graph.${prefix}Keep`) : t(`mail.graph.${prefix}Again`);
  };

  return (
    <>
      <Field
        id="settings-graph-directory"
        label={t("mail.graph.directoryId")}
        hint={t("mail.graph.directoryIdHint")}
        error={message(errors?.tenantId)}
      >
        <Input
          id="settings-graph-directory"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("mail.graph.guidPlaceholder")}
          className="font-mono text-xs md:text-xs"
          aria-invalid={errors?.tenantId !== undefined}
          aria-describedby={messageId("settings-graph-directory")}
          {...form.register("graph.tenantId")}
        />
      </Field>

      <Field
        id="settings-graph-client"
        label={t("mail.graph.clientId")}
        hint={t("mail.graph.clientIdHint")}
        error={message(errors?.clientId)}
      >
        <Input
          id="settings-graph-client"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("mail.graph.guidPlaceholder")}
          className="font-mono text-xs md:text-xs"
          aria-invalid={errors?.clientId !== undefined}
          aria-describedby={messageId("settings-graph-client")}
          {...form.register("graph.clientId")}
        />
      </Field>

      <div className="space-y-1.5">
        <Label htmlFor="settings-graph-credential-kind">{t("mail.graph.credentialKind")}</Label>
        <Controller
          control={form.control}
          name="graph.credentialKind"
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={(value) => {
                field.onChange(value as CredentialKind);
                form.clearErrors(["graph.clientSecret", "graph.certificatePem"]);
              }}
            >
              <SelectTrigger id="settings-graph-credential-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="secret">{t("mail.graph.credentialKinds.secret")}</SelectItem>
                <SelectItem value="certificate">
                  {t("mail.graph.credentialKinds.certificate")}
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {graph.credentialKind === "secret" ? (
        <Field
          id="settings-graph-secret"
          label={t("mail.graph.clientSecret")}
          hint={credentialHint("secret")}
          error={message(errors?.clientSecret)}
        >
          <PasswordInput
            id="settings-graph-secret"
            autoComplete="new-password"
            aria-invalid={errors?.clientSecret !== undefined}
            aria-describedby={messageId("settings-graph-secret")}
            {...form.register("graph.clientSecret")}
          />
        </Field>
      ) : (
        <TextFileField
          form={form}
          id="settings-graph-certificate"
          name="graph.certificatePem"
          label={t("mail.graph.certificatePem")}
          hint={credentialHint("certificate")}
          error={message(errors?.certificatePem)}
          accept=".pem,.crt,.cer,.key,.txt"
          uploadLabel={t("mail.graph.uploadPem")}
          failedLabel={t("mail.graph.uploadFailed")}
        />
      )}
    </>
  );
}

function GoogleFields({ form, settings }: { form: MailForm; settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const message = useFieldMessage();
  const google = useWatch({ control: form.control, name: "google" });
  const errors = form.formState.errors.google;
  const stored = settings.mail.transport === "google" ? settings.mail.google : null;
  const preview = google.serviceAccountKey.trim()
    ? previewServiceAccountKey(google.serviceAccountKey.trim())
    : null;
  const clientId = preview?.clientId ?? stored?.clientId ?? null;
  const keyHint =
    stored?.keyStored === true
      ? t("mail.google.keyKeep", { account: stored.serviceAccountEmail })
      : t("mail.google.keyHint");

  return (
    <div className="space-y-4">
      <Alert variant="info">
        <Info />
        <AlertDescription>{t("mail.google.hint")}</AlertDescription>
      </Alert>

      <GoogleMailGuide clientId={clientId} defaultOpen={stored === null} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="settings-google-sender"
          label={t("mail.google.sender")}
          hint={t("mail.google.senderHint")}
          error={message(errors?.sender)}
          className="sm:col-span-2"
        >
          <Input
            id="settings-google-sender"
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("mail.google.senderPlaceholder")}
            aria-invalid={errors?.sender !== undefined}
            aria-describedby={messageId("settings-google-sender")}
            {...form.register("google.sender")}
          />
        </Field>

        <TextFileField
          form={form}
          id="settings-google-key"
          name="google.serviceAccountKey"
          label={t("mail.google.key")}
          hint={keyHint}
          error={message(errors?.serviceAccountKey)}
          accept=".json,application/json"
          uploadLabel={t("mail.google.uploadKey")}
          failedLabel={t("mail.google.uploadFailed")}
        >
          {preview ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <CircleCheck aria-hidden="true" className="size-3.5 text-primary" />
              {t("mail.google.keyRecognized", { account: preview.clientEmail })}
            </span>
          ) : null}
        </TextFileField>
      </div>
    </div>
  );
}
