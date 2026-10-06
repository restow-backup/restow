import { TriangleAlert } from "lucide-react";
import { Controller, type UseFormReturn, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  HETZNER_LOCATIONS,
  type HetznerLocation,
  PRESET_DEFAULTS,
  type S3Preset,
  S3_PRESETS,
  type StoredLocation,
  type TargetFormValues,
  fieldMessageKey,
  hetznerEndpoint,
  hetznerLocationForEndpoint,
  needsCredentialsAgain,
} from "../forms";
import type { EditableKind } from "../types";

/**
 * Where a storage location is: a path on the server, or an S3-compatible
 * bucket with its provider preset, endpoint, region, addressing style and
 * access key pair. Shared by the add/edit target dialog and the installation
 * default storage (features/installation, Default storage), so both ask for
 * the same fields in the same way. The key pair is write-only: with `stored`
 * credentials, empty fields keep them (for the same endpoint).
 */
export function LocationFields({
  form,
  kind,
  stored,
}: {
  form: UseFormReturn<TargetFormValues>;
  kind: EditableKind;
  stored: StoredLocation | null;
}) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const values = useWatch({ control: form.control }) as TargetFormValues;
  const credentialsAgain = stored !== null && needsCredentialsAgain(values, stored);
  const insecureEndpoint = kind === "s3" && (values.endpoint ?? "").trim().startsWith("http:");

  const message = (name: keyof TargetFormValues) => {
    const key = fieldMessageKey(form.formState.errors[name]);
    return key ? tc(key) : undefined;
  };
  const describedBy = (id: string) => messageId(id);

  const selectPreset = (preset: S3Preset) => {
    form.setValue("preset", preset);
    const defaults = PRESET_DEFAULTS[preset];
    form.setValue("endpoint", defaults.endpoint, { shouldValidate: form.formState.isSubmitted });
    form.setValue("region", defaults.region);
    form.setValue("forcePathStyle", defaults.forcePathStyle);
  };

  const selectHetznerLocation = (location: HetznerLocation) => {
    form.setValue("endpoint", hetznerEndpoint(location), {
      shouldValidate: form.formState.isSubmitted,
    });
    form.setValue("region", location);
  };

  return kind === "local" ? (
    <Field
      id="target-base-path"
      label={t("form.local.basePath")}
      error={message("basePath")}
      hint={t("form.local.basePathHint")}
    >
      <Input
        id="target-base-path"
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        placeholder={t("form.local.basePathPlaceholder")}
        aria-invalid={form.formState.errors.basePath !== undefined}
        aria-describedby={describedBy("target-base-path")}
        {...form.register("basePath")}
      />
    </Field>
  ) : (
    <>
      <div className="space-y-1.5">
        <Label htmlFor="target-preset">{t("form.s3.preset")}</Label>
        <Select value={values.preset} onValueChange={(value) => selectPreset(value as S3Preset)}>
          <SelectTrigger
            id="target-preset"
            className="w-full"
            aria-describedby="target-preset-hint"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {S3_PRESETS.map((preset) => (
              <SelectItem key={preset} value={preset}>
                {t(`form.s3.presets.${preset}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p id="target-preset-hint" className="text-xs text-muted-foreground">
          {t("form.s3.presetHint")}
        </p>
      </div>

      {values.preset === "hetzner" ? (
        <div className="space-y-1.5">
          <Label htmlFor="target-hetzner-location">{t("form.s3.hetznerLocation")}</Label>
          <Select
            value={hetznerLocationForEndpoint(values.endpoint ?? "") ?? ""}
            onValueChange={(value) => selectHetznerLocation(value as HetznerLocation)}
          >
            <SelectTrigger id="target-hetzner-location" className="w-full">
              <SelectValue placeholder={t("form.s3.hetznerLocationCustom")} />
            </SelectTrigger>
            <SelectContent>
              {HETZNER_LOCATIONS.map((location) => (
                <SelectItem key={location} value={location}>
                  {t(`form.s3.hetznerLocations.${location}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="target-bucket" label={t("form.s3.bucket")} error={message("bucket")}>
          <Input
            id="target-bucket"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("form.s3.bucketPlaceholder")}
            aria-invalid={form.formState.errors.bucket !== undefined}
            aria-describedby={describedBy("target-bucket")}
            {...form.register("bucket")}
          />
        </Field>
        <Field
          id="target-prefix"
          label={t("form.s3.prefix")}
          error={message("prefix")}
          hint={t("form.s3.prefixHint")}
        >
          <Input
            id="target-prefix"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("form.s3.prefixPlaceholder")}
            aria-invalid={form.formState.errors.prefix !== undefined}
            aria-describedby={describedBy("target-prefix")}
            {...form.register("prefix")}
          />
        </Field>
      </div>

      <Field
        id="target-endpoint"
        label={t("form.s3.endpoint")}
        error={message("endpoint")}
        hint={t("form.s3.endpointHint")}
      >
        <Input
          id="target-endpoint"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("form.s3.endpointPlaceholder")}
          aria-invalid={form.formState.errors.endpoint !== undefined}
          aria-describedby={describedBy("target-endpoint")}
          {...form.register("endpoint")}
        />
      </Field>
      {insecureEndpoint ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>{t("form.s3.insecureEndpoint")}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
        <Field
          id="target-region"
          label={t("form.s3.region")}
          error={message("region")}
          hint={t("form.s3.regionHint")}
        >
          <Input
            id="target-region"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={form.formState.errors.region !== undefined}
            aria-describedby={describedBy("target-region")}
            {...form.register("region")}
          />
        </Field>
        <div className="space-y-1.5">
          <Label htmlFor="target-path-style">{t("form.s3.forcePathStyle")}</Label>
          <div className="flex h-9 items-center">
            <Controller
              control={form.control}
              name="forcePathStyle"
              render={({ field }) => (
                <Switch
                  id="target-path-style"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-describedby="target-path-style-hint"
                />
              )}
            />
          </div>
          <p id="target-path-style-hint" className="text-xs text-muted-foreground">
            {t("form.s3.forcePathStyleHint")}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="target-access-key"
          label={t("form.s3.accessKeyId")}
          error={message("accessKeyId")}
          hint={
            stored?.s3?.hasCredentials && !credentialsAgain
              ? t("form.s3.keepCredentials", { hint: stored.s3.accessKeyIdHint ?? "" })
              : undefined
          }
        >
          <Input
            id="target-access-key"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              stored?.s3?.accessKeyIdHint
                ? t("form.s3.storedKeyPlaceholder", { hint: stored.s3.accessKeyIdHint })
                : undefined
            }
            aria-invalid={form.formState.errors.accessKeyId !== undefined}
            aria-describedby={describedBy("target-access-key")}
            {...form.register("accessKeyId")}
          />
        </Field>
        <Field
          id="target-secret"
          label={t("form.s3.secretAccessKey")}
          error={message("secretAccessKey")}
          hint={
            credentialsAgain && stored?.s3?.hasCredentials
              ? t("form.s3.credentialsAgain")
              : t("form.s3.secretHint")
          }
        >
          <PasswordInput
            id="target-secret"
            autoComplete="new-password"
            aria-invalid={form.formState.errors.secretAccessKey !== undefined}
            aria-describedby={describedBy("target-secret")}
            {...form.register("secretAccessKey")}
          />
        </Field>
      </div>
    </>
  );
}
