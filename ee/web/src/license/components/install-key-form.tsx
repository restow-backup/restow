import { KeyRound, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";

import { installReadiness, licenseErrorMessage } from "../presenters";
import type { LicenseState } from "../types";
import { useInstallLicense } from "../use-license";

const FIELD_ID = "license-key";

/**
 * Paste a key, verify it offline on the server and install it. When this
 * build cannot verify keys (or setup is incomplete) the form says why
 * instead of letting every attempt fail.
 */
export function InstallKeyForm({ state }: { state: LicenseState }) {
  const { t } = useTranslation("license");
  const install = useInstallLicense();
  const [value, setValue] = React.useState("");
  const [missing, setMissing] = React.useState(false);
  const readiness = installReadiness(state);
  const ready = readiness === "ready";

  const serverMessage = install.error ? licenseErrorMessage(install.error) : null;
  const error = missing
    ? t("install.required")
    : serverMessage
      ? t(serverMessage.key, serverMessage.values)
      : undefined;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (value.trim() === "") {
      setMissing(true);
      return;
    }
    install.mutate(value, {
      onSuccess: (next) => {
        setValue("");
        toast.success(t("toasts.installed", { edition: next.edition }));
      },
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">
          {state.key ? t("install.replaceTitle") : t("install.title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("key.description")}</p>
      </div>

      {ready ? null : (
        <Alert variant="warning">
          <ShieldAlert />
          <AlertTitle>{t("install.unavailable.title")}</AlertTitle>
          <AlertDescription>{t(`install.unavailable.${readiness}`)}</AlertDescription>
        </Alert>
      )}

      <Field id={FIELD_ID} label={t("install.label")} error={error} hint={t("install.hint")}>
        <Textarea
          id={FIELD_ID}
          name="licenseKey"
          rows={4}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setMissing(false);
            if (install.error) {
              install.reset();
            }
          }}
          placeholder={t("install.placeholder")}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!ready || install.isPending}
          aria-invalid={error ? true : undefined}
          aria-describedby={messageId(FIELD_ID)}
          className="min-h-24 resize-y break-all font-mono text-xs"
        />
      </Field>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground sm:max-w-md">{t("install.offline")}</p>
        <Button type="submit" loading={install.isPending} disabled={!ready} className="shrink-0">
          {install.isPending ? null : <KeyRound />}
          {t("install.submit")}
        </Button>
      </div>
    </form>
  );
}
