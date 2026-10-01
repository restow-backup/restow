import { ChevronDown, Info, TriangleAlert, Upload } from "lucide-react";
import * as React from "react";
import { Controller, type UseFormReturn, useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { zodResolver } from "@/lib/form";
import { cn } from "@/lib/utils";
import { problemFieldIssues } from "../forms";
import type { CredentialKind, MicrosoftAppView } from "./api";
import { type SetupVariant, StepFrame } from "./components";
import {
  MICROSOFT_APP_FIELDS,
  type MicrosoftAppFormValues,
  type StoredFormSource,
  formFromView,
  mayKeepCredential,
  microsoftAppFormSchema,
  storedCredential,
  toSaveInput,
} from "./forms";
import { useSaveMicrosoftApp } from "./hooks";
import { fieldReasonKey, microsoftAppErrorKey } from "./presenters";

/**
 * Step 4: the registration's values. The secret and the PEM are write-only:
 * the fields start empty, and leaving them empty keeps what is stored (same
 * app and login host only). A registration from the server environment is
 * shown read-only instead.
 */

const MAX_PEM_FILE_BYTES = 64 * 1024;

type FieldPath = Parameters<UseFormReturn<MicrosoftAppFormValues>["setError"]>[0];

/** Attach the API's field issues to the form; true when at least one matched a field. */
function applyIssues(form: UseFormReturn<MicrosoftAppFormValues>, error: unknown): boolean {
  const issues = problemFieldIssues(error).filter((issue) =>
    MICROSOFT_APP_FIELDS.has(issue.field as keyof MicrosoftAppFormValues),
  );
  issues.forEach((issue, index) => {
    form.setError(
      issue.field as FieldPath,
      { message: issue.reason },
      { shouldFocus: index === 0 },
    );
  });
  return issues.length > 0;
}

interface EnterStepProps {
  view: MicrosoftAppView;
  variant: SetupVariant;
  /** Reports unsaved edits, so the connection test can say it uses the saved values. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function EnterStep({ view, variant, onDirtyChange }: EnterStepProps) {
  const { t } = useTranslation("settings");
  return (
    <StepFrame
      number={4}
      title={t("microsoftApp.steps.enter.title")}
      description={t("microsoftApp.steps.enter.description")}
      variant={variant}
    >
      {view.source === "environment" ? (
        <Alert variant="info">
          <Info />
          <AlertDescription>{t("microsoftApp.steps.enter.readOnly")}</AlertDescription>
        </Alert>
      ) : (
        <MicrosoftAppForm view={view} variant={variant} onDirtyChange={onDirtyChange} />
      )}
    </StepFrame>
  );
}

export function MicrosoftAppForm({ view, variant, onDirtyChange }: EnterStepProps) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const save = useSaveMicrosoftApp();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const stored = storedCredential(view);
  const id = (name: string) => `${variant}-msapp-${name}`;
  // Sovereign-cloud login hosts are rare: folded away unless one is set.
  const [advancedOpen, setAdvancedOpen] = React.useState(view.authorityHost !== null);

  // The resolver reads the latest stored credential (may it be kept?).
  const storedRef = React.useRef(stored);
  storedRef.current = stored;
  const form = useForm<MicrosoftAppFormValues>({
    resolver: (values, context, options) =>
      zodResolver(microsoftAppFormSchema(storedRef.current))(values, context, options),
    defaultValues: formFromView(view),
  });

  // Follow changes made elsewhere (another tab, the other variant) without losing edits.
  const storedKey = JSON.stringify({
    clientId: view.clientId,
    homeTenantId: view.homeTenantId,
    authorityHost: view.authorityHost,
    credential: view.credential,
  } satisfies StoredFormSource);
  React.useEffect(() => {
    const source = JSON.parse(storedKey) as StoredFormSource;
    form.reset(formFromView(source), { keepDirtyValues: true });
  }, [form, storedKey]);

  const dirty = form.formState.isDirty;
  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const values = useWatch({ control: form.control }) as MicrosoftAppFormValues;
  const keep = mayKeepCredential(values, stored);
  const errors = form.formState.errors;
  const message = (reason: string | undefined) => {
    const key = fieldReasonKey(reason);
    return key ? tc(key) : undefined;
  };

  const onSubmit = form.handleSubmit(async (submitted) => {
    setSubmitError(null);
    try {
      const result = await save.mutateAsync(toSaveInput(submitted));
      form.reset(formFromView(result));
      toast.success(t("microsoftApp.toasts.saved"));
    } catch (error) {
      if (!applyIssues(form, error)) {
        setSubmitError(error);
      }
    }
  });

  const secretHint =
    !stored || stored.kind !== "secret"
      ? t("microsoftApp.form.secretHint")
      : keep
        ? t("microsoftApp.form.secretKeep")
        : t("microsoftApp.form.secretAgain");
  const certificateHint =
    !stored || stored.kind !== "certificate"
      ? t("microsoftApp.form.certificateHint")
      : keep
        ? t("microsoftApp.form.certificateKeep", { thumbprint: stored.thumbprint ?? "" })
        : t("microsoftApp.form.certificateAgain");

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={id("client-id")}
          label={t("microsoftApp.form.clientId")}
          error={message(errors.clientId?.message)}
        >
          <Input
            id={id("client-id")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder={t("microsoftApp.form.clientIdPlaceholder")}
            aria-invalid={errors.clientId !== undefined}
            aria-describedby={messageId(id("client-id"))}
            {...form.register("clientId")}
          />
        </Field>
        <Field
          id={id("tenant-id")}
          label={t("microsoftApp.form.tenantId")}
          hint={t("microsoftApp.form.tenantIdHint")}
          error={message(errors.homeTenantId?.message)}
        >
          <Input
            id={id("tenant-id")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder={t("microsoftApp.form.tenantIdPlaceholder")}
            aria-invalid={errors.homeTenantId !== undefined}
            aria-describedby={messageId(id("tenant-id"))}
            {...form.register("homeTenantId")}
          />
        </Field>
      </div>

      <Controller
        control={form.control}
        name="credentialKind"
        render={({ field }) => (
          <Tabs
            value={field.value}
            onValueChange={(value) => {
              field.onChange(value as CredentialKind);
              form.clearErrors(["clientSecret", "certificatePem"]);
            }}
          >
            <div className="space-y-1.5">
              <p className="text-sm font-medium" id={id("credential-label")}>
                {t("microsoftApp.form.credential")}
              </p>
              <TabsList aria-labelledby={id("credential-label")}>
                <TabsTrigger value="secret">{t("microsoftApp.form.kinds.secret")}</TabsTrigger>
                <TabsTrigger value="certificate">
                  {t("microsoftApp.form.kinds.certificate")}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="secret" className="mt-2">
              <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
                <Field
                  id={id("client-secret")}
                  label={t("microsoftApp.form.clientSecret")}
                  hint={secretHint}
                  error={message(errors.clientSecret?.message)}
                >
                  <PasswordInput
                    id={id("client-secret")}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      stored?.kind === "secret" && keep
                        ? t("microsoftApp.form.secretStored")
                        : undefined
                    }
                    aria-invalid={errors.clientSecret !== undefined}
                    aria-describedby={messageId(id("client-secret"))}
                    {...form.register("clientSecret")}
                  />
                </Field>
                <Field
                  id={id("expires-at")}
                  label={t("microsoftApp.form.expiresAt")}
                  hint={t("microsoftApp.form.expiresAtHint")}
                  error={message(errors.secretExpiresAt?.message)}
                >
                  <Input
                    id={id("expires-at")}
                    type="date"
                    aria-invalid={errors.secretExpiresAt !== undefined}
                    aria-describedby={messageId(id("expires-at"))}
                    {...form.register("secretExpiresAt")}
                  />
                </Field>
              </div>
            </TabsContent>
            <TabsContent value="certificate" className="mt-2">
              <CertificateField form={form} id={id("certificate")} hint={certificateHint} />
            </TabsContent>
          </Tabs>
        )}
      />

      <Collapsible
        open={advancedOpen || errors.authorityHost !== undefined}
        onOpenChange={setAdvancedOpen}
        className="rounded-lg border border-border px-4 py-2"
      >
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="-mx-2 text-muted-foreground">
            {t("microsoftApp.form.advanced")}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "transition-transform duration-200",
                (advancedOpen || errors.authorityHost !== undefined) && "rotate-180",
              )}
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 pb-2">
          <Field
            id={id("authority")}
            label={t("microsoftApp.form.authorityHost")}
            hint={t("microsoftApp.form.authorityHostHint")}
            error={message(errors.authorityHost?.message)}
            className="sm:max-w-md"
          >
            <Input
              id={id("authority")}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("microsoftApp.form.authorityHostPlaceholder")}
              aria-invalid={errors.authorityHost !== undefined}
              aria-describedby={messageId(id("authority"))}
              {...form.register("authorityHost")}
            />
          </Field>
        </CollapsibleContent>
      </Collapsible>

      {submitError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{tc(microsoftAppErrorKey(submitError))}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {/* Before a first save there is nothing that could be "saved" yet. */}
          {dirty ? t("form.unsaved") : view.source === "database" ? t("form.saved") : null}
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button
            variant="outline"
            onClick={() => {
              setSubmitError(null);
              form.reset(formFromView(view));
            }}
            disabled={!dirty || form.formState.isSubmitting}
          >
            {t("form.discard")}
          </Button>
          <Button type="submit" loading={form.formState.isSubmitting} disabled={!dirty}>
            {tc("actions.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function CertificateField({
  form,
  id,
  hint,
}: {
  form: UseFormReturn<MicrosoftAppFormValues>;
  id: string;
  hint: string;
}) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const error = form.formState.errors.certificatePem?.message;
  const key = fieldReasonKey(error);

  const readFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    try {
      const list = [...files];
      if (list.some((file) => file.size > MAX_PEM_FILE_BYTES)) {
        throw new Error("file too large");
      }
      // Key and certificate may come as two files (.key and .crt); one PEM holds both.
      const texts = await Promise.all(list.map((file) => file.text()));
      form.setValue("certificatePem", texts.map((text) => text.trim()).join("\n"), {
        shouldDirty: true,
        shouldValidate: true,
      });
    } catch {
      toast.error(t("microsoftApp.form.uploadFailed"));
    } finally {
      if (fileRef.current) {
        fileRef.current.value = "";
      }
    }
  };

  return (
    <Field
      id={id}
      label={t("microsoftApp.form.certificatePem")}
      hint={hint}
      error={key ? tc(key) : undefined}
    >
      <Textarea
        id={id}
        spellCheck={false}
        autoComplete="off"
        className="max-h-72 min-h-32 font-mono text-xs md:text-xs"
        aria-invalid={error !== undefined}
        aria-describedby={messageId(id)}
        {...form.register("certificatePem")}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".pem,.crt,.cer,.key,.txt"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void readFiles(event.target.files)}
      />
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => fileRef.current?.click()}
      >
        <Upload />
        {t("microsoftApp.form.uploadPem")}
      </Button>
    </Field>
  );
}
