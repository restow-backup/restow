import { CircleCheck, Info, Send, TriangleAlert } from "lucide-react";
import * as React from "react";
import {
  Controller,
  type FieldError,
  type UseFormReturn,
  useForm,
  useWatch,
} from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import type { MailTransport, SmtpSecurity } from "@/lib/api";
import { zodResolver } from "@/lib/form";
import { useSession } from "@/lib/session";
import type { InstallationSettings, MailSettings, MailTestResult } from "../api";
import { FormFooter } from "../components/form-footer";
import {
  type MailFormContext,
  type MailFormValues,
  type MailTestFormValues,
  SMTP_SECURITY,
  fieldMessageKey,
  mailFormContext,
  mailFormFromSettings,
  mailFormSchema,
  mailTestFormSchema,
  mayKeepStoredPassword,
  portForSecurity,
  problemFieldIssues,
  toMailInput,
} from "../forms";
import { useMailTest, useUpdateSettings } from "../hooks";
import { formatDuration, mailTestFailureKey, settingsErrorKey } from "../presenters";

const FORM_ID = "settings-mail-form";

/** Paths of the mail form that an API issue can point at. */
const MAIL_FIELDS = new Set([
  "transport",
  "smtp.host",
  "smtp.port",
  "smtp.security",
  "smtp.username",
  "smtp.password",
  "smtp.from",
  "graph.sender",
  "graph.tenantId",
]);

type MailFieldPath = Parameters<UseFormReturn<MailFormValues>["setError"]>[0];

/** Attach the API's field issues to the form; true when at least one matched a field. */
function applyIssues(form: UseFormReturn<MailFormValues>, error: unknown): boolean {
  const issues = problemFieldIssues(error, ["mail"]).filter((issue) =>
    MAIL_FIELDS.has(issue.field),
  );
  issues.forEach((issue, index) => {
    form.setError(
      issue.field as MailFieldPath,
      { message: issue.reason },
      { shouldFocus: index === 0 },
    );
  });
  return issues.length > 0;
}

export function MailSection({ settings }: { settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const update = useUpdateSettings();
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  // The resolver reads the latest stored state (password reuse, Graph default tenant).
  const contextRef = React.useRef<MailFormContext>(mailFormContext(settings));
  contextRef.current = mailFormContext(settings);

  const form = useForm<MailFormValues>({
    resolver: (values, context, options) =>
      zodResolver(mailFormSchema(contextRef.current))(values, context, options),
    defaultValues: mailFormFromSettings(settings.mail),
  });

  // Follow changes made elsewhere without throwing away what is being edited.
  const storedKey = JSON.stringify(settings.mail);
  React.useEffect(() => {
    const stored = JSON.parse(storedKey) as MailSettings;
    form.reset(mailFormFromSettings(stored), { keepDirtyValues: true });
  }, [form, storedKey]);

  const discard = () => {
    setSubmitError(null);
    form.reset(mailFormFromSettings(settings.mail));
  };

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const result = await update.mutateAsync({ mail: toMailInput(values) });
      form.reset(mailFormFromSettings(result.mail));
      toast.success(t("toasts.saved"));
    } catch (error) {
      if (!applyIssues(form, error)) {
        setSubmitError(error);
      }
    }
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("mail.title")}</CardTitle>
          <CardDescription>{t("mail.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {settings.mail.transport === null ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>{t("mail.notConfigured.title")}</AlertTitle>
              <AlertDescription>{t("mail.notConfigured.description")}</AlertDescription>
            </Alert>
          ) : null}
          <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-5">
            <MailFields form={form} settings={settings} />
            {submitError ? (
              <Alert variant="destructive">
                <TriangleAlert />
                <AlertDescription>{tc(settingsErrorKey(submitError))}</AlertDescription>
              </Alert>
            ) : null}
          </form>
        </CardContent>
        <FormFooter
          formId={FORM_ID}
          dirty={form.formState.isDirty}
          saving={form.formState.isSubmitting}
          onDiscard={discard}
        />
      </Card>

      <MailTestCard mailForm={form} />
    </div>
  );
}

function MailFields({
  form,
  settings,
}: {
  form: UseFormReturn<MailFormValues>;
  settings: InstallationSettings;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const transport = useWatch({ control: form.control, name: "transport" });
  const smtp = useWatch({ control: form.control, name: "smtp" });
  const errors = form.formState.errors;
  const context = mailFormContext(settings);
  const { graphMail } = settings.capabilities;

  const message = (error: FieldError | undefined) => {
    const key = fieldMessageKey(error);
    return key ? tc(key) : undefined;
  };

  const storedPassword = context.storedSmtp?.passwordStored === true;
  const passwordHint = !storedPassword
    ? t("mail.smtp.passwordHint")
    : mayKeepStoredPassword(smtp, context.storedSmtp)
      ? t("mail.smtp.passwordKeep")
      : t("mail.smtp.passwordAgain");

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
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {transport === "smtp" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="settings-smtp-host"
            label={t("mail.smtp.host")}
            error={message(errors.smtp?.host)}
          >
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
                      form.setValue(
                        "smtp.port",
                        portForSecurity(form.getValues("smtp.port"), next),
                        {
                          shouldDirty: true,
                        },
                      );
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
      ) : (
        <div className="space-y-4">
          <Alert variant="info">
            <Info />
            <AlertDescription>{t("mail.graph.hint")}</AlertDescription>
          </Alert>
          {!graphMail.appConfigured ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>{t("mail.graph.appMissing.title")}</AlertTitle>
              <AlertDescription>{t("mail.graph.appMissing.description")}</AlertDescription>
            </Alert>
          ) : null}
          {storedPassword ? (
            <p className="text-xs text-muted-foreground">{t("mail.graph.passwordRemoved")}</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="settings-graph-sender"
              label={t("mail.graph.sender")}
              error={message(errors.graph?.sender)}
            >
              <Input
                id="settings-graph-sender"
                type="email"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("mail.graph.senderPlaceholder")}
                aria-invalid={errors.graph?.sender !== undefined}
                aria-describedby={messageId("settings-graph-sender")}
                {...form.register("graph.sender")}
              />
            </Field>
            <Field
              id="settings-graph-tenant"
              label={t("mail.graph.tenantId")}
              hint={
                graphMail.defaultTenantId
                  ? t("mail.graph.tenantIdDefault", { tenant: graphMail.defaultTenantId })
                  : t("mail.graph.tenantIdHint")
              }
              error={message(errors.graph?.tenantId)}
            >
              <Input
                id="settings-graph-tenant"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("mail.graph.tenantIdPlaceholder")}
                aria-invalid={errors.graph?.tenantId !== undefined}
                aria-describedby={messageId("settings-graph-tenant")}
                {...form.register("graph.tenantId")}
              />
            </Field>
          </div>
        </div>
      )}
    </>
  );
}

/** Identifies what a test ran with, so an outdated result is not shown as current. */
function testKey(values: MailFormValues, recipient: string): string {
  return JSON.stringify([toMailInput(values), recipient.trim()]);
}

function MailTestCard({ mailForm }: { mailForm: UseFormReturn<MailFormValues> }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const { user } = useSession();
  const test = useMailTest();
  const [testedKey, setTestedKey] = React.useState<string | null>(null);

  const form = useForm<MailTestFormValues>({
    resolver: zodResolver(mailTestFormSchema),
    defaultValues: { recipient: user?.email ?? "" },
  });

  const mailValues = useWatch({ control: mailForm.control }) as MailFormValues;
  const recipient = useWatch({ control: form.control, name: "recipient" });
  const current = testedKey !== null && testedKey === testKey(mailValues, recipient);

  const onSubmit = form.handleSubmit(async (values) => {
    // The test sends exactly what the form above shows; it has to be valid first.
    if (!(await mailForm.trigger())) {
      return;
    }
    const mail = mailForm.getValues();
    setTestedKey(testKey(mail, values.recipient));
    test.mutate(
      { to: values.recipient.trim(), mail: toMailInput(mail) },
      {
        onError: (error) => {
          applyIssues(mailForm, error);
        },
      },
    );
  });

  const recipientError = form.formState.errors.recipient;
  const recipientMessage = fieldMessageKey(recipientError);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("mail.test.title")}</CardTitle>
        <CardDescription>{t("mail.test.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-3 sm:flex-row sm:items-start"
        >
          <Field
            id="settings-test-recipient"
            label={t("mail.test.recipient")}
            error={recipientMessage ? tc(recipientMessage) : undefined}
            className="flex-1"
          >
            <Input
              id="settings-test-recipient"
              type="email"
              autoComplete="email"
              spellCheck={false}
              aria-invalid={recipientError !== undefined}
              aria-describedby={messageId("settings-test-recipient")}
              {...form.register("recipient")}
            />
          </Field>
          <Button type="submit" className="sm:mt-6" loading={test.isPending}>
            {test.isPending ? null : <Send />}
            {t("mail.test.send")}
          </Button>
        </form>

        {current && test.data ? <MailTestOutcome result={test.data} /> : null}
        {current && test.error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{t("mail.test.failed")}</AlertTitle>
            <AlertDescription>{tc(settingsErrorKey(test.error))}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MailTestOutcome({ result }: { result: MailTestResult }) {
  const { t, i18n } = useTranslation("settings");
  if (result.ok || !result.failure) {
    return (
      <Alert variant="info" aria-live="polite">
        <CircleCheck />
        <AlertTitle>{t("mail.test.successTitle")}</AlertTitle>
        <AlertDescription>
          {t("mail.test.success", {
            recipient: result.recipient,
            duration: formatDuration(result.durationMs, i18n.language),
          })}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" aria-live="polite">
      <TriangleAlert />
      <AlertTitle>{t("mail.test.failed")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{t(mailTestFailureKey(result.failure.reason))}</p>
        {result.failure.detail ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("mail.test.detail")}</p>
            <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {result.failure.detail}
            </pre>
          </div>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
