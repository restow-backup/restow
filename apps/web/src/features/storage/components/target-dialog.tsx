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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import {
  PRESET_DEFAULTS,
  type S3Preset,
  S3_PRESETS,
  type TargetFormValues,
  emptyTargetForm,
  fieldMessageKey,
  formFieldOf,
  needsCredentialsAgain,
  targetFormFromDto,
  targetFormSchema,
  toCreateTargetInput,
  toProbeInput,
  toUpdateTargetInput,
} from "../forms";
import { problemFields, storageErrorKey } from "../presenters";
import type { AssignableRole, EditableKind, MigrationMode, StorageTargetDto } from "../types";
import { useCreateTarget, useProbeSettings, useTestTarget, useUpdateTarget } from "../use-storage";
import { ObjectLockLine } from "./object-lock-line";
import { ProbeResult } from "./probe-result";

interface TargetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: EditableKind;
  /** The target to edit; omit to add one. */
  target?: StorageTargetDto;
  /** Why "primary" cannot be chosen when adding, if it cannot. */
  primaryBlocked: "primaryExists" | "tenantHasData" | null;
}

/**
 * Add or edit a storage target. Settings can be tested before saving; after
 * saving, the stored target is tested once more so its card reflects what was
 * actually stored.
 */
export function TargetDialog({
  open,
  onOpenChange,
  kind,
  target,
  primaryBlocked,
}: TargetDialogProps) {
  const { t } = useTranslation("storage");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{target ? t("form.editTitle") : t(`form.createTitle.${kind}`)}</DialogTitle>
          <DialogDescription>{t(`form.description.${kind}`)}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: every opening starts from the stored values. */}
        <TargetForm
          kind={kind}
          target={target}
          primaryBlocked={primaryBlocked}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The values a probe result belongs to; once they change, the result is hidden. */
function connectionKey(values: TargetFormValues): string {
  return [
    values.basePath,
    values.bucket,
    values.prefix,
    values.endpoint,
    values.region,
    values.forcePathStyle,
    values.accessKeyId,
    values.secretAccessKey,
  ].join("\n");
}

function TargetForm({
  kind,
  target,
  primaryBlocked,
  onDone,
}: {
  kind: EditableKind;
  target?: StorageTargetDto;
  primaryBlocked: "primaryExists" | "tenantHasData" | null;
  onDone: () => void;
}) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const stored = target ?? null;
  const form = useForm<TargetFormValues>({
    resolver: zodResolver(targetFormSchema(kind, stored)),
    defaultValues: stored
      ? targetFormFromDto(stored)
      : emptyTargetForm(primaryBlocked ? "copy" : "primary"),
  });
  const create = useCreateTarget();
  const update = useUpdateTarget(target?.id ?? "");
  const storedTest = useTestTarget();
  const probe = useProbeSettings();
  const [probedKey, setProbedKey] = React.useState<string | null>(null);
  const [submitError, setSubmitError] = React.useState<unknown>(null);

  const values = useWatch({ control: form.control }) as TargetFormValues;
  const probeIsCurrent = probedKey === connectionKey(values);
  const credentialsAgain = stored !== null && needsCredentialsAgain(values, stored);
  const insecureEndpoint = kind === "s3" && values.endpoint.trim().startsWith("http:");

  const message = (name: keyof TargetFormValues) => {
    const key = fieldMessageKey(form.formState.errors[name]);
    return key ? tc(key) : undefined;
  };
  const describedBy = (id: string) => messageId(id);

  /** Put API field problems on their fields; report whether any matched. */
  const applyFieldProblems = (error: unknown): boolean => {
    let matched = false;
    for (const problem of problemFields(error)) {
      const field = formFieldOf(problem.field);
      if (field) {
        form.setError(field, { message: problem.reason }, { shouldFocus: !matched });
        matched = true;
      }
    }
    return matched;
  };

  const runProbe = async () => {
    const fields: (keyof TargetFormValues)[] =
      kind === "local" ? ["basePath"] : ["bucket", "endpoint", "region"];
    if (!(await form.trigger(fields))) {
      return;
    }
    const current = form.getValues();
    const input = toProbeInput(kind, current, stored);
    if (!input) {
      form.setError("accessKeyId", {
        message: stored?.s3?.hasCredentials ? "credentials_again" : "required",
      });
      return;
    }
    setProbedKey(connectionKey(current));
    probe.mutate(input, { onError: (error) => applyFieldProblems(error) });
  };

  const selectPreset = (preset: S3Preset) => {
    form.setValue("preset", preset);
    const defaults = PRESET_DEFAULTS[preset];
    form.setValue("endpoint", defaults.endpoint, { shouldValidate: form.formState.isSubmitted });
    form.setValue("region", defaults.region);
    form.setValue("forcePathStyle", defaults.forcePathStyle);
  };

  const onSubmit = form.handleSubmit(async (submitted) => {
    setSubmitError(null);
    try {
      if (!stored) {
        const created = await create.mutateAsync(toCreateTargetInput(kind, submitted));
        toast.success(t("toasts.created", { name: created.name }));
        onDone();
        storedTest.mutate(created.id);
        return;
      }
      const patch = toUpdateTargetInput(kind, submitted, stored);
      if (Object.keys(patch).length === 0) {
        onDone();
        return;
      }
      await update.mutateAsync(patch);
      toast.success(t("toasts.updated", { name: submitted.name.trim() }));
      onDone();
      if (patch.config || patch.credentials) {
        storedTest.mutate(stored.id);
      }
    } catch (error) {
      if (!applyFieldProblems(error)) {
        setSubmitError(error);
      }
    }
  });

  const busy = form.formState.isSubmitting;
  const probeResult = probeIsCurrent ? probe.data : undefined;

  return (
    <>
      <form id="storage-target-form" onSubmit={onSubmit} noValidate className="space-y-4">
        <Field id="target-name" label={t("form.name")} error={message("name")}>
          <Input
            id="target-name"
            autoComplete="off"
            placeholder={t(`form.namePlaceholder.${kind}`)}
            aria-invalid={form.formState.errors.name !== undefined}
            aria-describedby={describedBy("target-name")}
            {...form.register("name")}
          />
        </Field>

        {stored ? null : (
          <RoleField
            value={values.role}
            onChange={(role) => form.setValue("role", role)}
            migrationMode={values.migrationMode}
            onMigrationModeChange={(mode) => form.setValue("migrationMode", mode)}
            primaryBlocked={primaryBlocked}
          />
        )}

        {kind === "local" ? (
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
              <Select
                value={values.preset}
                onValueChange={(value) => selectPreset(value as S3Preset)}
              >
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
        )}

        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">{t(`form.testHint.${kind}`)}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runProbe()}
              loading={probe.isPending}
              disabled={busy}
              className="shrink-0"
            >
              {probe.isPending ? null : <PlugZap />}
              {t("actions.testSettings")}
            </Button>
          </div>
          {probeResult ? (
            <div className="space-y-2">
              <ProbeResult probe={probeResult.probe} compact />
              {kind === "s3" && probeResult.objectLock ? (
                <ObjectLockLine kind={kind} capability={probeResult.objectLock} />
              ) : null}
            </div>
          ) : null}
          {probeIsCurrent && probe.error && problemFields(probe.error).length === 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {tc(storageErrorKey(probe.error))}
            </p>
          ) : null}
        </div>

        {submitError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(storageErrorKey(submitError))}</AlertDescription>
          </Alert>
        ) : null}
      </form>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={busy}>
          {tc("actions.cancel")}
        </Button>
        <Button type="submit" form="storage-target-form" loading={busy}>
          {stored ? tc("actions.save") : t("actions.create")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Copy, or primary — offered as "Replace the primary" once the tenant
 * already has one, which then asks how the changeover should happen
 * (docs/STORAGE.md, "Replace the primary"): `move` copies every existing
 * backup across in a verified background migration before switching, `keep`
 * switches at once and leaves the old target attached read-only.
 */
export function RoleField({
  value,
  onChange,
  migrationMode,
  onMigrationModeChange,
  primaryBlocked,
}: {
  value: AssignableRole;
  onChange: (role: AssignableRole) => void;
  migrationMode: MigrationMode;
  onMigrationModeChange: (mode: MigrationMode) => void;
  primaryBlocked: "primaryExists" | "tenantHasData" | null;
}) {
  const { t } = useTranslation("storage");
  const replacing = primaryBlocked !== null && value === "primary";
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="target-role">{t("form.role")}</Label>
        <Select value={value} onValueChange={(next) => onChange(next as AssignableRole)}>
          <SelectTrigger id="target-role" className="w-full" aria-describedby="target-role-hint">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="primary">
              {t(primaryBlocked ? "role.replacePrimary" : "role.primary")}
            </SelectItem>
            <SelectItem value="copy">{t("role.copy")}</SelectItem>
          </SelectContent>
        </Select>
        <p id="target-role-hint" className="text-xs text-muted-foreground">
          {primaryBlocked && value === "copy"
            ? t(`form.primaryBlocked.${primaryBlocked}`)
            : t(replacing ? "role.replacePrimaryHint" : `role.${value}Hint`)}
        </p>
      </div>
      {replacing ? (
        <RadioGroup
          value={migrationMode}
          onValueChange={(next) => onMigrationModeChange(next as MigrationMode)}
          className="gap-3 rounded-lg border border-border p-3"
          aria-label={t("form.migrationMode")}
        >
          <div className="flex items-start gap-2.5">
            <RadioGroupItem value="move" id="migration-mode-move" className="mt-0.5" />
            <Label htmlFor="migration-mode-move" className="flex-1 cursor-pointer font-normal">
              <span className="block font-medium text-foreground">
                {t("form.migrationModeMove")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("form.migrationModeMoveHint")}
              </span>
            </Label>
          </div>
          <div className="flex items-start gap-2.5">
            <RadioGroupItem
              value="keep"
              id="migration-mode-keep"
              className="mt-0.5"
              aria-describedby="migration-mode-keep-hint"
            />
            <Label htmlFor="migration-mode-keep" className="flex-1 cursor-pointer font-normal">
              <span className="block font-medium text-foreground">
                {t("form.migrationModeKeep")}
              </span>
              <span id="migration-mode-keep-hint" className="block text-xs text-muted-foreground">
                {t("form.migrationModeKeepHint")}
              </span>
            </Label>
          </div>
        </RadioGroup>
      ) : null}
    </div>
  );
}
