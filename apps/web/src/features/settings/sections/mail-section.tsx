import { CircleCheck, Info, Send, Trash2, TriangleAlert } from "lucide-react";
import * as React from "react";
import { type UseFormReturn, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { AccessNote, ReadOnlyGroup, useInstallationAccess } from "@/features/installation/access";
import { zodResolver } from "@/lib/form";
import { useSession } from "@/lib/session";
import type { InstallationSettings, MailSettings, MailTestResult } from "../api";
import { ConfirmDialog } from "../components/confirm-dialog";
import { FormFooter } from "../components/form-footer";
import {
  type MailFormContext,
  type MailFormValues,
  type MailTestFormValues,
  fieldMessageKey,
  mailFormContext,
  mailFormFromSettings,
  mailFormSchema,
  mailTestFormSchema,
  problemFieldIssues,
  toMailInput,
} from "../forms";
import { useMailTest, useRemoveMailConfiguration, useUpdateSettings } from "../hooks";
import { formatDuration, mailTestFailureKey, settingsErrorKey } from "../presenters";
import { MailFields } from "./mail-fields";

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
  "graph.app",
  "graph.sender",
  "graph.tenantId",
  "graph.clientId",
  "graph.credentialKind",
  "graph.clientSecret",
  "graph.certificatePem",
  "google.sender",
  "google.serviceAccountKey",
]);

/** The API's own-app paths (`graph.ownApp.*`) are flat fields in the form. */
function formField(field: string): string {
  return field.startsWith("graph.ownApp.") ? `graph.${field.slice("graph.ownApp.".length)}` : field;
}

type MailFieldPath = Parameters<UseFormReturn<MailFormValues>["setError"]>[0];

/** Attach the API's field issues to the form; true when at least one matched a field. */
function applyIssues(form: UseFormReturn<MailFormValues>, error: unknown): boolean {
  const issues = problemFieldIssues(error, ["mail"])
    .map((issue) => ({ ...issue, field: formField(issue.field) }))
    .filter((issue) => MAIL_FIELDS.has(issue.field));
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
  const access = useInstallationAccess();
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
      <AccessNote block={access.change} level="owner" />
      <ReadOnlyGroup closed={access.change !== null}>
        <Card>
          <CardHeader>
            <CardTitle>{t("mail.title")}</CardTitle>
            <CardDescription>{t("mail.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {settings.mail.transport === null ? (
              // The setup wizard lets an operator skip the mail step: no transport is a normal state.
              <Alert variant="info">
                <Info />
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
            {settings.mail.transport !== null ? <RemoveMailRow /> : null}
          </CardContent>
          <FormFooter
            formId={FORM_ID}
            dirty={form.formState.isDirty}
            saving={form.formState.isSubmitting}
            onDiscard={discard}
          />
        </Card>
      </ReadOnlyGroup>

      <ReadOnlyGroup closed={access.operate !== null}>
        <MailTestCard mailForm={form} />
      </ReadOnlyGroup>
    </div>
  );
}

/**
 * Removing the transport belongs to the card that sets it: it forgets the
 * transport and destroys the stored SMTP password, behind a confirmation.
 */
function RemoveMailRow() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const remove = useRemoveMailConfiguration();
  const [confirming, setConfirming] = React.useState(false);

  const confirm = () => {
    remove.mutate(undefined, {
      onSuccess: () => {
        toast.success(t("toasts.mailRemoved"));
        setConfirming(false);
      },
      onError: (error) => {
        toast.error(tc(settingsErrorKey(error)));
        setConfirming(false);
      },
    });
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("mail.remove.title")}</p>
        <p className="max-w-prose text-sm text-muted-foreground">{t("mail.remove.description")}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="shrink-0 border-destructive/40 text-destructive-text hover:bg-destructive/10 hover:text-destructive-text"
        onClick={() => setConfirming(true)}
      >
        <Trash2 aria-hidden="true" />
        {t("mail.remove.action")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("mail.remove.confirmTitle")}
        description={t("mail.remove.confirmDescription")}
        confirmLabel={t("mail.remove.confirm")}
        destructive
        pending={remove.isPending}
        onConfirm={confirm}
      />
    </div>
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
