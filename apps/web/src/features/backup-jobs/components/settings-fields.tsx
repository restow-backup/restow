import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
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
import { WriteOnceRetentionNotice } from "@/features/storage";

import { LIMITS } from "../api.js";
import {
  ENDPOINT_SCHEDULE_KINDS,
  type EndpointScheduleDraft,
  type EndpointScheduleField,
  type EndpointScheduleKind,
  type FormProblem,
  MASKED_HOOK,
  type SettingsDraft,
  type SqlDraft,
  sqlSlotTooClose,
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

/**
 * The upload limit of a machine job (or of one member): a number, empty for the agent policy's
 * limit, or "unlimited" chosen explicitly, which also sets a policy's limit aside (only a lock of
 * the installation overrides it).
 */
export function BandwidthField({
  id,
  value,
  onChange,
  unlimited,
  onUnlimitedChange,
  error,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  unlimited: boolean;
  onUnlimitedChange: (unlimited: boolean) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("backupjobs");
  return (
    <div className="space-y-3">
      <Field id={id} label={t("bandwidth.label")} hint={t("bandwidth.hint")} error={error}>
        <Input
          id={id}
          value={unlimited ? "" : value}
          onChange={(event) => onChange(event.target.value)}
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled || unlimited}
          placeholder={t(unlimited ? "bandwidth.unlimited" : "bandwidth.fromPolicy")}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={messageId(id)}
          className="w-56 tabular-nums"
        />
      </Field>
      <div className="flex items-start gap-2">
        <Checkbox
          id={`${id}-unlimited`}
          checked={unlimited}
          onCheckedChange={(checked) => onUnlimitedChange(checked === true)}
          disabled={disabled}
          aria-describedby={`${id}-unlimited-hint`}
          className="mt-0.5"
        />
        <div className="grid gap-0.5">
          <Label htmlFor={`${id}-unlimited`}>{t("bandwidth.unlimitedChoice")}</Label>
          <p id={`${id}-unlimited-hint`} className="text-xs text-muted-foreground">
            {t("bandwidth.unlimitedChoiceHint")}
          </p>
        </div>
      </div>
    </div>
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
      <WriteOnceRetentionNotice context="job" />
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

// --- SQL Server (preview, Windows members) ------------------------------------------------------

const WEEKDAYS = ["1", "2", "3", "4", "5", "6", "7"] as const;

/**
 * The native SQL Server backup of the job's Windows members (preview, docs/BAREMETAL-WINDOWS.md
 * 5.1.3): copy-only fulls of every database beside the customer's own backups, each into a
 * snapshot of its own, and a weekly check that restores the newest one from the repository and
 * runs DBCC CHECKDB on it. Other systems ignore it.
 */
export function SqlField({
  idPrefix,
  sql,
  onChange,
  problems,
  dailyTime,
  disabled = false,
}: {
  idPrefix: string;
  sql: SqlDraft;
  onChange: (sql: SqlDraft) => void;
  problems: Partial<Record<"databases" | "stagingDir" | "verifyTime" | "verifyMaxGiB", string>>;
  /** The job's daily backup time, when it has one: the check slot keeps an hour off it. */
  dailyTime: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation("backupjobs");
  const ids = (name: string) => `${idPrefix}-${name}`;
  const set = (patch: Partial<SqlDraft>) => onChange({ ...sql, ...patch, present: true });
  const tooClose = sql.enabled && sql.verifyEnabled && sqlSlotTooClose(sql.verifyTime, dailyTime);
  return (
    <div className="space-y-4" data-slot="sql-field">
      <div className="flex items-start gap-2">
        <Checkbox
          id={ids("enabled")}
          checked={sql.enabled}
          onCheckedChange={(checked) => set({ enabled: checked === true })}
          disabled={disabled}
          aria-describedby={ids("enabled-hint")}
          className="mt-0.5"
        />
        <div className="grid gap-0.5">
          <Label htmlFor={ids("enabled")}>{t("sql.enabled")}</Label>
          <p id={ids("enabled-hint")} className="text-xs text-muted-foreground">
            {t("sql.enabledHint")}
          </p>
        </div>
      </div>
      {sql.enabled ? (
        <>
          <RadioGroup
            aria-label={t("sql.databases")}
            value={sql.databasesAll ? "all" : "list"}
            onValueChange={(value) => set({ databasesAll: value === "all" })}
            disabled={disabled}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id={ids("all")} value="all" />
              <Label htmlFor={ids("all")} className="font-normal">
                {t("sql.databasesAll")}
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={ids("list")} value="list" />
              <Label htmlFor={ids("list")} className="font-normal">
                {t("sql.databasesList")}
              </Label>
            </div>
          </RadioGroup>
          {!sql.databasesAll ? (
            <Field
              id={ids("databases")}
              label={t("sql.databasesListLabel")}
              hint={t("sql.linesHint")}
              error={problems.databases}
            >
              <Textarea
                id={ids("databases")}
                value={sql.databases}
                onChange={(event) => set({ databases: event.target.value })}
                rows={3}
                spellCheck={false}
                disabled={disabled}
                className="font-mono text-sm"
                aria-invalid={Boolean(problems.databases) || undefined}
                aria-describedby={messageId(ids("databases"))}
              />
            </Field>
          ) : null}
          <Field id={ids("exclude")} label={t("sql.exclude")} hint={t("sql.linesHint")}>
            <Textarea
              id={ids("exclude")}
              value={sql.exclude}
              onChange={(event) => set({ exclude: event.target.value })}
              rows={2}
              spellCheck={false}
              disabled={disabled}
              className="font-mono text-sm"
              aria-describedby={messageId(ids("exclude"))}
            />
          </Field>
          <Field
            id={ids("staging")}
            label={t("sql.stagingDir")}
            hint={t("sql.stagingDirHint")}
            error={problems.stagingDir}
          >
            <Input
              id={ids("staging")}
              value={sql.stagingDir}
              onChange={(event) => set({ stagingDir: event.target.value })}
              placeholder={t("sql.stagingDirPlaceholder")}
              spellCheck={false}
              autoComplete="off"
              disabled={disabled}
              className="w-full font-mono text-sm sm:w-96"
              aria-invalid={Boolean(problems.stagingDir) || undefined}
              aria-describedby={messageId(ids("staging"))}
            />
          </Field>
          <div className="flex items-start gap-2">
            <Checkbox
              id={ids("verify")}
              checked={sql.verifyEnabled}
              onCheckedChange={(checked) => set({ verifyEnabled: checked === true })}
              disabled={disabled}
              aria-describedby={ids("verify-hint")}
              className="mt-0.5"
            />
            <div className="grid gap-0.5">
              <Label htmlFor={ids("verify")}>{t("sql.verify")}</Label>
              <p id={ids("verify-hint")} className="text-xs text-muted-foreground">
                {t("sql.verifyHint")}
              </p>
            </div>
          </div>
          {sql.verifyEnabled ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id={ids("weekday")} label={t("sql.weekday")}>
                <Select
                  value={sql.verifyWeekday}
                  onValueChange={(verifyWeekday) => set({ verifyWeekday })}
                  disabled={disabled}
                >
                  <SelectTrigger id={ids("weekday")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((day) => (
                      <SelectItem key={day} value={day}>
                        {t(`sql.weekdays.${day}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                id={ids("time")}
                label={t("sql.time")}
                error={problems.verifyTime ?? (tooClose ? t("sql.tooClose") : undefined)}
              >
                <Input
                  id={ids("time")}
                  type="time"
                  value={sql.verifyTime}
                  onChange={(event) => set({ verifyTime: event.target.value })}
                  disabled={disabled}
                  className="w-40 tabular-nums"
                  aria-invalid={Boolean(problems.verifyTime) || tooClose || undefined}
                  aria-describedby={messageId(ids("time"))}
                />
              </Field>
              <Field
                id={ids("max")}
                label={t("sql.maxGiB")}
                hint={t("sql.maxGiBHint")}
                error={problems.verifyMaxGiB}
              >
                <Input
                  id={ids("max")}
                  value={sql.verifyMaxGiB}
                  onChange={(event) => set({ verifyMaxGiB: event.target.value })}
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={disabled}
                  className="tabular-nums"
                  aria-invalid={Boolean(problems.verifyMaxGiB) || undefined}
                  aria-describedby={messageId(ids("max"))}
                />
              </Field>
            </div>
          ) : null}
          {sql.verifyEnabled ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id={ids("physical")}
                checked={sql.verifyPhysicalOnly}
                onCheckedChange={(checked) => set({ verifyPhysicalOnly: checked === true })}
                disabled={disabled}
                className="mt-0.5"
              />
              <Label htmlFor={ids("physical")} className="font-normal">
                {t("sql.physicalOnly")}
              </Label>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("sql.note")}</p>
        </>
      ) : null}
    </div>
  );
}
