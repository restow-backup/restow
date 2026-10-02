import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { relativeLabel } from "@/components/kit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import type { PreviewRequest } from "../api.js";
import { useSchedulePreview } from "../hooks.js";
import {
  type CadenceDraft,
  type CadenceField,
  type FieldProblem,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  WEEK,
  checkCadence,
  fieldProblem,
  formatRun,
  intervalRuns,
  weekdayLabel,
} from "../presenters.js";
import {
  MAX_PRESET_DAY_OF_MONTH,
  PRESET_TYPES,
  type PresetType,
  type Weekday,
} from "../presets.js";
import { TimezonePicker } from "./timezone-picker.js";

/** Which form field a request field the API named belongs to; null for a field outside the cadence. */
function formFieldOf(
  apiField: string,
  draft: CadenceDraft,
): CadenceField | "timezone" | "cadence" | null {
  switch (apiField) {
    case "timezone":
    case "timeZone":
      return "timezone";
    case "cron":
      return draft.presetType === "custom" ? "cron" : "cadence";
    case "intervalMinutes":
      return draft.presetType === "every_minutes"
        ? "minutes"
        : draft.presetType === "every_hours"
          ? "hours"
          : "cadence";
    case "cadence":
    case "timeOfDay":
    case "kind":
      return "cadence";
    default:
      return null;
  }
}

const INTERVAL_PRESETS: readonly PresetType[] = ["every_minutes", "every_hours"];

export interface CadenceFieldsProps {
  /** Prefix of the element ids, unique on the page. */
  idPrefix: string;
  draft: CadenceDraft;
  onChange: (next: CadenceDraft) => void;
  /** Required fields complain only after a save attempt; out-of-range values at once. */
  attempted: boolean;
  /** What the API said about the cadence when saving was refused. */
  saveProblem?: FieldProblem | null;
  /** When the thing last ran, so an interval can be shown counting from it. */
  lastRunAt?: string | null;
  disabled?: boolean;
}

/**
 * How often something runs: a preset (every few hours or minutes, daily, on
 * chosen weekdays, monthly) or a cron expression, the time zone it is read in
 * and the next five runs as the scheduler will run them. The schedule form and
 * the backup job editor are built on it, so a cadence reads and validates the
 * same everywhere.
 */
export function CadenceFields({
  idPrefix,
  draft,
  onChange,
  attempted,
  saveProblem = null,
  lastRunAt = null,
  disabled = false,
}: CadenceFieldsProps) {
  const { t, i18n } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const ids = (name: string) => `${idPrefix}-${name}`;
  const set = <K extends keyof CadenceDraft>(key: K, value: CadenceDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const check = checkCadence(draft);
  const isInterval = INTERVAL_PRESETS.includes(draft.presetType);
  const previewRequest: PreviewRequest | null = check.ok
    ? { ...check.cadence, timezone: draft.timezone }
    : null;
  // The API judges every cadence (interval limits, cron syntax, zone) while typing.
  const preview = useSchedulePreview(previewRequest);
  const previewProblem = previewRequest ? fieldProblem(preview.error) : null;
  const problem = saveProblem ?? previewProblem;
  const problemField = problem ? formFieldOf(problem.field, draft) : null;

  /** The message shown under a field: the API's verdict first, then the form's own check. */
  const errorFor = (field: CadenceField | "timezone" | "cadence"): string | undefined => {
    if (problem && problemField === field) {
      return t(problem.key);
    }
    if (field !== "timezone" && field !== "cadence" && !check.ok && check.field === field) {
      if (check.reason === "range" || attempted) {
        return t(`validation.${check.reason}.${field}`, {
          min: MIN_INTERVAL_MINUTES,
          max: field === "hours" ? MAX_INTERVAL_MINUTES / 60 : MAX_INTERVAL_MINUTES,
          maxDay: MAX_PRESET_DAY_OF_MONTH,
        });
      }
    }
    return undefined;
  };

  const runs: Date[] | null = !check.ok
    ? null
    : isInterval && check.cadence.intervalMinutes !== null
      ? intervalRuns(check.cadence.intervalMinutes, lastRunAt, Date.now())
      : preview.data
        ? preview.data.next.map((instant) => new Date(instant))
        : null;

  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">{t("form.cadence")}</legend>
      <Field id={ids("preset")} label={t("form.preset")} error={errorFor("cadence")}>
        <Select
          value={draft.presetType}
          onValueChange={(value) => {
            const presetType = value as PresetType;
            onChange({
              ...draft,
              presetType,
              // Switching to a custom expression starts from what was described so far.
              cron:
                presetType === "custom" && draft.cron.trim() === "" && check.ok
                  ? (check.cadence.cron ?? draft.cron)
                  : draft.cron,
            });
          }}
        >
          <SelectTrigger
            id={ids("preset")}
            className="w-full"
            aria-describedby={messageId(ids("preset"))}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRESET_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`presets.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {draft.presetType === "every_hours" ? (
        <Field id={ids("hours")} label={t("form.hours")} error={errorFor("hours")}>
          <Input
            id={ids("hours")}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_INTERVAL_MINUTES / 60}
            value={draft.hours}
            onChange={(event) => set("hours", event.target.value)}
            aria-invalid={Boolean(errorFor("hours")) || undefined}
            aria-describedby={messageId(ids("hours"))}
            className="tabular-nums"
          />
        </Field>
      ) : null}

      {draft.presetType === "every_minutes" ? (
        <Field id={ids("minutes")} label={t("form.minutes")} error={errorFor("minutes")}>
          <Input
            id={ids("minutes")}
            type="number"
            inputMode="numeric"
            min={MIN_INTERVAL_MINUTES}
            max={MAX_INTERVAL_MINUTES}
            value={draft.minutes}
            onChange={(event) => set("minutes", event.target.value)}
            aria-invalid={Boolean(errorFor("minutes")) || undefined}
            aria-describedby={messageId(ids("minutes"))}
            className="tabular-nums"
          />
        </Field>
      ) : null}

      {draft.presetType === "weekly" ? (
        <div className="space-y-1.5">
          <Label id={ids("days-label")}>{t("form.days")}</Label>
          <ToggleGroup
            type="multiple"
            variant="outline"
            aria-labelledby={ids("days-label")}
            aria-describedby={messageId(ids("days"))}
            value={draft.days.map(String)}
            onValueChange={(values: string[]) =>
              set(
                "days",
                values.map((value) => Number.parseInt(value, 10) as Weekday),
              )
            }
            className="flex-wrap"
          >
            {WEEK.map((day) => (
              <ToggleGroupItem key={day} value={String(day)} className="min-w-11">
                {weekdayLabel(day, language)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {errorFor("days") ? (
            <p id={messageId(ids("days"))} role="alert" className="text-xs text-destructive">
              {errorFor("days")}
            </p>
          ) : null}
        </div>
      ) : null}

      {draft.presetType === "monthly" ? (
        <Field
          id={ids("dayOfMonth")}
          label={t("form.dayOfMonth")}
          hint={t("form.dayOfMonthHint", { max: MAX_PRESET_DAY_OF_MONTH })}
          error={errorFor("dayOfMonth")}
        >
          <Input
            id={ids("dayOfMonth")}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_PRESET_DAY_OF_MONTH}
            value={draft.dayOfMonth}
            onChange={(event) => set("dayOfMonth", event.target.value)}
            aria-invalid={Boolean(errorFor("dayOfMonth")) || undefined}
            aria-describedby={messageId(ids("dayOfMonth"))}
            className="tabular-nums"
          />
        </Field>
      ) : null}

      {draft.presetType === "daily" ||
      draft.presetType === "weekly" ||
      draft.presetType === "monthly" ? (
        <Field id={ids("time")} label={t("form.time")} error={errorFor("time")}>
          <Input
            id={ids("time")}
            type="time"
            value={draft.time}
            onChange={(event) => set("time", event.target.value)}
            aria-invalid={Boolean(errorFor("time")) || undefined}
            aria-describedby={messageId(ids("time"))}
            className="w-36 tabular-nums"
          />
        </Field>
      ) : null}

      {draft.presetType === "custom" ? (
        <Field
          id={ids("cron")}
          label={t("form.cron")}
          hint={t("form.cronHint")}
          error={errorFor("cron")}
        >
          <Input
            id={ids("cron")}
            value={draft.cron}
            onChange={(event) => set("cron", event.target.value)}
            placeholder="30 4 * * *"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-invalid={Boolean(errorFor("cron")) || undefined}
            aria-describedby={messageId(ids("cron"))}
            className="font-mono"
          />
        </Field>
      ) : null}

      {isInterval ? (
        <p className="text-sm text-muted-foreground">
          {lastRunAt ? t("form.intervalFromLastRun") : t("form.intervalStartsNow")}
        </p>
      ) : (
        <Field
          id={ids("timezone")}
          label={t("form.timezone")}
          hint={t("form.timezoneHint")}
          error={errorFor("timezone")}
        >
          <TimezonePicker
            id={ids("timezone")}
            value={draft.timezone}
            onChange={(zone) => set("timezone", zone)}
            describedBy={messageId(ids("timezone"))}
          />
        </Field>
      )}

      <RunPreview
        id={ids("preview")}
        runs={runs}
        loading={!isInterval && check.ok && (preview.isPending || preview.isPlaceholderData)}
        refused={problem !== null && problem === previewProblem}
        timeZone={isInterval ? undefined : draft.timezone}
        language={language}
      />
    </fieldset>
  );
}

interface RunPreviewProps {
  id: string;
  runs: Date[] | null;
  loading: boolean;
  /** The API refused the cadence (the reason shows at the field). */
  refused: boolean;
  timeZone: string | undefined;
  language: string;
}

/** The next five runs, as the scheduler will run them. */
function RunPreview({ id, runs, loading, refused, timeZone, language }: RunPreviewProps) {
  const { t } = useTranslation("schedules");
  const now = Date.now();
  return (
    <section
      aria-labelledby={id}
      aria-busy={loading || undefined}
      className="rounded-lg border bg-muted/40 p-4"
    >
      <h3 id={id} className="text-sm font-medium">
        {t("form.previewTitle")}
      </h3>
      {refused ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("form.previewRefused")}</p>
      ) : runs === null && !loading ? (
        <p className="mt-2 text-sm text-muted-foreground">{t("form.previewIncomplete")}</p>
      ) : loading && runs === null ? (
        <ul className="mt-2 space-y-2" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((index) => (
            <li key={index}>
              <Skeleton className="h-4 w-48" />
            </li>
          ))}
        </ul>
      ) : (
        <ol className={loading ? "mt-2 space-y-1 opacity-60" : "mt-2 space-y-1"}>
          {(runs ?? []).map((run) => (
            <li key={run.toISOString()} className="flex flex-wrap gap-x-2 text-sm tabular-nums">
              <time dateTime={run.toISOString()}>{formatRun(run, language, timeZone)}</time>
              <span className="text-muted-foreground">
                {relativeLabel(run, now, language) ?? t("form.previewNow")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
