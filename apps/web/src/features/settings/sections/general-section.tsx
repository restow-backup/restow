import { Globe, HardDrive, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import type { OperatingMode } from "@/lib/api";
import { zodResolver } from "@/lib/form";
import { formatDateTime } from "@/lib/format";
import { isLocalhostOrigin, previewPasskeyReady } from "@/lib/passkey-ready";
import type { InstallationSettings, SettingsPatch } from "../api";
import { ConfirmDialog } from "../components/confirm-dialog";
import { FormFooter } from "../components/form-footer";
import { ModeOption } from "../components/mode-option";
import { ReadinessCard, ReadinessSummary } from "../components/readiness";
import {
  type GeneralFormValues,
  fieldMessageKey,
  generalFormFromSettings,
  generalFormSchema,
  leavesPublicMode,
  problemFieldIssues,
  toGeneralPatch,
} from "../forms";
import { useUpdateSettings } from "../hooks";
import { settingsErrorKey } from "../presenters";

const FORM_ID = "settings-general-form";

/** Operating mode, public URL, passkey readiness and installation facts. */
export function GeneralSection({ settings }: { settings: InstallationSettings }) {
  return (
    <div className="space-y-6">
      <OperatingModeCard settings={settings} />
      <ReadinessCard fallback={settings.passkeyReady} />
      <InstallationCard settings={settings} />
    </div>
  );
}

function OperatingModeCard({ settings }: { settings: InstallationSettings }) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const update = useUpdateSettings();
  const [submitError, setSubmitError] = React.useState<unknown>(null);
  const [pendingLocal, setPendingLocal] = React.useState<SettingsPatch | null>(null);

  const stored = generalFormFromSettings(settings);
  const form = useForm<GeneralFormValues>({
    resolver: zodResolver(generalFormSchema),
    defaultValues: stored,
  });

  // Follow changes made elsewhere without throwing away what is being edited.
  React.useEffect(() => {
    form.reset(
      { operatingMode: stored.operatingMode, publicUrl: stored.publicUrl },
      {
        keepDirtyValues: true,
      },
    );
  }, [form, stored.operatingMode, stored.publicUrl]);

  const mode = useWatch({ control: form.control, name: "operatingMode" });
  const publicUrl = useWatch({ control: form.control, name: "publicUrl" });
  const dirty = form.formState.isDirty;
  const urlError = form.formState.errors.publicUrl;

  const observedOrigin = typeof window === "undefined" ? null : window.location.origin;
  const preview = previewPasskeyReady({
    operatingMode: mode,
    publicUrl: mode === "public" ? publicUrl : "",
    observedOrigin,
    allowLocalhost: isLocalhostOrigin(observedOrigin),
  });

  const select = (next: OperatingMode) => {
    form.setValue("operatingMode", next, { shouldDirty: true });
    if (next === "local") {
      // Local mode stores no URL; going back to the stored value keeps the form honest about changes.
      form.setValue("publicUrl", stored.publicUrl, { shouldDirty: true });
      form.clearErrors("publicUrl");
    } else if (!form.getValues("publicUrl") && observedOrigin) {
      // Offer the address the browser is using right now.
      form.setValue("publicUrl", observedOrigin, { shouldDirty: true });
    }
  };

  const discard = () => {
    setSubmitError(null);
    form.reset(generalFormFromSettings(settings));
  };

  const save = async (patch: SettingsPatch) => {
    setSubmitError(null);
    try {
      const result = await update.mutateAsync(patch);
      form.reset(generalFormFromSettings(result));
      toast.success(t("toasts.saved"));
    } catch (error) {
      const issue = problemFieldIssues(error).find((candidate) => candidate.field === "publicUrl");
      if (issue) {
        form.setError("publicUrl", { message: issue.reason }, { shouldFocus: true });
      } else {
        setSubmitError(error);
      }
    } finally {
      setPendingLocal(null);
    }
  };

  const onSubmit = form.handleSubmit(async (values) => {
    const patch = toGeneralPatch(values, settings);
    if (!patch) {
      discard();
      return;
    }
    if (leavesPublicMode(values, settings)) {
      setPendingLocal(patch);
      return;
    }
    await save(patch);
  });

  const urlMessage = fieldMessageKey(urlError);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("general.mode.title")}</CardTitle>
        <CardDescription>{t("general.mode.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-6">
          <div
            role="radiogroup"
            aria-label={t("general.mode.title")}
            className="grid gap-3 sm:grid-cols-2"
          >
            <ModeOption
              name="settings-operating-mode"
              icon={<HardDrive className="size-5" />}
              title={t("general.mode.local")}
              description={t("general.mode.localDescription")}
              selected={mode === "local"}
              onSelect={() => select("local")}
            />
            <ModeOption
              name="settings-operating-mode"
              icon={<Globe className="size-5" />}
              title={t("general.mode.public")}
              description={t("general.mode.publicDescription")}
              selected={mode === "public"}
              onSelect={() => select("public")}
            />
          </div>

          {mode === "public" ? (
            <Field
              id="settings-public-url"
              label={t("general.publicUrl.label")}
              error={urlMessage ? tc(urlMessage) : undefined}
              hint={t("general.publicUrl.hint")}
            >
              <Input
                id="settings-public-url"
                type="url"
                inputMode="url"
                autoComplete="url"
                spellCheck={false}
                placeholder={t("general.publicUrl.placeholder")}
                aria-invalid={urlError !== undefined}
                aria-describedby={messageId("settings-public-url")}
                {...form.register("publicUrl")}
              />
            </Field>
          ) : null}

          {settings.environment.publicUrlMismatch && settings.environment.publicUrl ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>{t("general.environment.title")}</AlertTitle>
              <AlertDescription>
                {t("general.environment.description", { url: settings.environment.publicUrl })}
              </AlertDescription>
            </Alert>
          ) : null}

          {dirty ? <ReadinessSummary readiness={preview} title={t("readiness.preview")} /> : null}

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
        dirty={dirty}
        saving={form.formState.isSubmitting || update.isPending}
        onDiscard={discard}
      />

      <ConfirmDialog
        open={pendingLocal !== null}
        onOpenChange={(open) => !open && setPendingLocal(null)}
        title={t("general.localConfirm.title")}
        description={t("general.localConfirm.description")}
        confirmLabel={t("general.localConfirm.confirm")}
        destructive
        pending={update.isPending}
        onConfirm={() => pendingLocal && void save(pendingLocal)}
      />
    </Card>
  );
}

function InstallationCard({ settings }: { settings: InstallationSettings }) {
  const { t, i18n } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const updatedAt = formatDateTime(settings.updatedAt, i18n.language);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("general.installation.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <dt className="text-muted-foreground">{t("general.installation.updatedAt")}</dt>
            <dd>{updatedAt ?? tc("time.unknown")}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
