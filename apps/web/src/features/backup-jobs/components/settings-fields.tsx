import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Textarea } from "@/components/ui/textarea";
import { TimezonePicker } from "@/features/schedules/components/timezone-picker";

import { LIMITS } from "../api.js";
import {
  ENDPOINT_SCHEDULE_KINDS,
  type EndpointScheduleDraft,
  type EndpointScheduleField,
  type EndpointScheduleKind,
  type FormProblem,
  MASKED_HOOK,
  type SettingsDraft,
} from "../form.js";

/** The text of a form problem (the checks of form.ts) in the backupjobs namespace. */
export function useProblemText() {
  const { t } = useTranslation("backupjobs");
  return (problem: FormProblem | undefined): string | undefined =>
    problem ? t(`problems.form.${problem.code}`, problem.values) : undefined;
}

// --- Schedule of a machine job -----------------------------------------------------------

export interface EndpointScheduleFieldsProps {
  idPrefix: string;
  draft: EndpointScheduleDraft;
  onChange: (next: EndpointScheduleDraft) => void;
  /** What is wrong with the fields, by field. */
  problems?: Partial<Record<EndpointScheduleField, string>>;
  disabled?: boolean;
}

/**
 * When the agent starts a backup: daily at a fixed time, at a fixed interval, or
 * whenever the machine is online (at most every so many minutes), in a time
 * zone. The agent contract (docs/AGENT.md) knows these three.
 */
export function EndpointScheduleFields({
  idPrefix,
  draft,
  onChange,
  problems = {},
  disabled = false,
}: EndpointScheduleFieldsProps) {
  const { t } = useTranslation("backupjobs");
  const ids = (name: string) => `${idPrefix}-${name}`;
  const set = <K extends keyof EndpointScheduleDraft>(key: K, value: EndpointScheduleDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">{t("schedule.legend")}</legend>
      <Field id={ids("kind")} label={t("schedule.endpoint.kind")}>
        <Select
          value={draft.kind}
          onValueChange={(value) => set("kind", value as EndpointScheduleKind)}
        >
          <SelectTrigger id={ids("kind")} className="w-full sm:w-80">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENDPOINT_SCHEDULE_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(`schedule.endpoint.kinds.${kind}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {draft.kind === "daily" ? (
        <Field
          id={ids("time")}
          label={t("schedule.endpoint.timeOfDay")}
          hint={t("schedule.endpoint.timeHint")}
          error={problems.timeOfDay}
        >
          <Input
            id={ids("time")}
            type="time"
            value={draft.timeOfDay}
            onChange={(event) => set("timeOfDay", event.target.value)}
            aria-invalid={Boolean(problems.timeOfDay) || undefined}
            aria-describedby={messageId(ids("time"))}
            className="w-40 tabular-nums"
          />
        </Field>
      ) : (
        <Field
          id={ids("minutes")}
          label={t(`schedule.endpoint.minutes.${draft.kind}`)}
          hint={t(`schedule.endpoint.minutesHint.${draft.kind}`, {
            min: LIMITS.endpointIntervalMin,
          })}
          error={problems.intervalMinutes}
        >
          <Input
            id={ids("minutes")}
            value={draft.intervalMinutes}
            onChange={(event) => set("intervalMinutes", event.target.value)}
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={Boolean(problems.intervalMinutes) || undefined}
            aria-describedby={messageId(ids("minutes"))}
            className="w-40 tabular-nums"
          />
        </Field>
      )}

      <Field
        id={ids("zone")}
        label={t("schedule.endpoint.timeZone")}
        hint={t("schedule.endpoint.timeZoneHint")}
        error={problems.timeZone}
      >
        <TimezonePicker
          id={ids("zone")}
          value={draft.timeZone}
          onChange={(zone) => set("timeZone", zone)}
          describedBy={messageId(ids("zone"))}
        />
      </Field>
    </fieldset>
  );
}

// --- Bandwidth -----------------------------------------------------------------------------------

export function BandwidthField({
  id,
  value,
  onChange,
  error,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("backupjobs");
  return (
    <Field id={id} label={t("bandwidth.label")} hint={t("bandwidth.hint")} error={error}>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="numeric"
        autoComplete="off"
        disabled={disabled}
        placeholder={t("bandwidth.unlimited")}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={messageId(id)}
        className="w-56 tabular-nums"
      />
    </Field>
  );
}

// --- Hooks ---------------------------------------------------------------------------------------

export function HooksField({
  idPrefix,
  settings,
  onChange,
  error,
  disabled = false,
}: {
  idPrefix: string;
  settings: Pick<SettingsDraft, "preHook" | "postHook" | "hooksHidden">;
  onChange: (patch: Partial<SettingsDraft>) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("backupjobs");
  const hidden = settings.hooksHidden;
  const locked = disabled || hidden;
  const field = (kind: "pre" | "post") => {
    const id = `${idPrefix}-${kind}`;
    const key = kind === "pre" ? "preHook" : "postHook";
    return (
      <Field
        id={id}
        label={t(`hooks.${kind}`)}
        hint={t(kind === "pre" ? "hooks.preHint" : "hooks.postHint")}
        error={kind === "pre" ? error : undefined}
      >
        <Textarea
          id={id}
          value={hidden ? MASKED_HOOK : settings[key]}
          onChange={(event) => onChange({ [key]: event.target.value })}
          rows={3}
          disabled={locked}
          spellCheck={false}
          placeholder={kind === "pre" ? t("hooks.prePlaceholder") : undefined}
          className="font-mono text-sm"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={messageId(id)}
        />
      </Field>
    );
  };

  return (
    <div className="space-y-4" data-slot="hooks-field">
      <Alert variant="warning">
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>{t("hooks.warningTitle")}</AlertTitle>
        <AlertDescription>
          <p>{t("hooks.warningRoot")}</p>
          <p>{t("hooks.warningMachines")}</p>
          <p>{t("hooks.warningFailure")}</p>
        </AlertDescription>
      </Alert>
      {hidden ? <p className="text-sm text-muted-foreground">{t("hooks.hidden")}</p> : null}
      {field("pre")}
      {field("post")}
      <p className="text-xs text-muted-foreground">{t("hooks.stepUp")}</p>
    </div>
  );
}

// --- Retention of a machine job ----------------------------------------------------------------

export function RetentionField({
  idPrefix,
  settings,
  onChange,
  problems,
  disabled = false,
}: {
  idPrefix: string;
  settings: Pick<SettingsDraft, "retentionOwn" | "keepDaily" | "keepWeekly" | "keepMonthly">;
  onChange: (patch: Partial<SettingsDraft>) => void;
  problems: Partial<Record<"keepDaily" | "keepWeekly" | "keepMonthly", string>>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("backupjobs");
  const ids = (name: string) => `${idPrefix}-${name}`;
  return (
    <div className="space-y-4" data-slot="retention-field">
      <RadioGroup
        aria-label={t("retention.mode")}
        value={settings.retentionOwn ? "job" : "machine"}
        onValueChange={(value) => onChange({ retentionOwn: value === "job" })}
        disabled={disabled}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem id={ids("machine")} value="machine" />
          <Label htmlFor={ids("machine")} className="font-normal">
            {t("retention.machineOwn")}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={ids("job")} value="job" />
          <Label htmlFor={ids("job")} className="font-normal">
            {t("retention.jobSets")}
          </Label>
        </div>
      </RadioGroup>
      {settings.retentionOwn ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {(["keepDaily", "keepWeekly", "keepMonthly"] as const).map((field) => (
            <Field
              key={field}
              id={ids(field)}
              label={t(`retention.${field}`)}
              error={problems[field]}
            >
              <Input
                id={ids(field)}
                value={settings[field]}
                onChange={(event) => onChange({ [field]: event.target.value })}
                inputMode="numeric"
                autoComplete="off"
                disabled={disabled}
                aria-invalid={Boolean(problems[field]) || undefined}
                aria-describedby={messageId(ids(field))}
                className="tabular-nums"
              />
            </Field>
          ))}
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("retention.note")}</p>
    </div>
  );
}
