import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { relativeLabel } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorMessageKey } from "@/lib/api";

import {
  OBJECT_SCOPED_KINDS,
  OFFERED_KINDS,
  type OfferedKind,
  type PreviewRequest,
  type ScheduleItem,
} from "../api.js";
import { useCreateSchedule, useSchedulePreview, useUpdateSchedule } from "../hooks.js";
import {
  type DraftField,
  KIND_ICON,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  type ScheduleDraft,
  type ScopeMode,
  WEEK,
  browserTimeZone,
  checkDraft,
  draftFromSchedule,
  fieldProblem,
  formatRun,
  inputFromDraft,
  intervalRuns,
  needsDisableConfirmation,
  newDraft,
  patchFromDraft,
  weekdayLabel,
} from "../presenters.js";
import {
  MAX_PRESET_DAY_OF_MONTH,
  PRESET_TYPES,
  type PresetType,
  type Weekday,
} from "../presets.js";
import { DisableScheduleDialog } from "./schedule-dialogs.js";
import { ScopePicker } from "./scope-picker.js";
import { TimezonePicker } from "./timezone-picker.js";

export interface ScheduleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The schedule to edit; null creates a new one. */
  schedule: ScheduleItem | null;
  /** A schedule was created or changed (the page shows the toast). */
  onSaved: (change: "created" | "updated", item: ScheduleItem) => void;
}

/** Create or edit a schedule: what runs, how often (preset or cron), in which zone, for whom. */
export function ScheduleSheet({ open, onOpenChange, schedule, onSaved }: ScheduleSheetProps) {
  const { t } = useTranslation("schedules");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border p-6 pr-12">
          <SheetTitle className="text-lg">
            {schedule ? t("form.editTitle") : t("form.createTitle")}
          </SheetTitle>
          <SheetDescription>{t("form.description")}</SheetDescription>
        </SheetHeader>
        {open ? (
          <ScheduleForm
            key={schedule?.id ?? "new"}
            schedule={schedule}
            onDone={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface ScheduleFormProps {
  schedule: ScheduleItem | null;
  onDone: () => void;
  onSaved: ScheduleSheetProps["onSaved"];
}

/** Which form field a request field the API named belongs to. */
function formFieldOf(apiField: string, draft: ScheduleDraft): DraftField | "timezone" | "cadence" {
  switch (apiField) {
    case "timezone":
      return "timezone";
    case "protectedObjectId":
      return "object";
    case "cron":
      return draft.presetType === "custom" ? "cron" : "cadence";
    case "intervalMinutes":
      return draft.presetType === "every_minutes"
        ? "minutes"
        : draft.presetType === "every_hours"
          ? "hours"
          : "cadence";
    default:
      return "cadence";
  }
}

const INTERVAL_PRESETS: readonly PresetType[] = ["every_minutes", "every_hours"];

function ScheduleForm({ schedule, onDone, onSaved }: ScheduleFormProps) {
  const { t, i18n } = useTranslation("schedules");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const [draft, setDraft] = React.useState<ScheduleDraft>(() =>
    schedule ? draftFromSchedule(schedule) : newDraft(browserTimeZone()),
  );
  const [attempted, setAttempted] = React.useState(false);
  const [confirmingDisable, setConfirmingDisable] = React.useState(false);
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const saving = create.isPending || update.isPending;
  const formId = React.useId();
  const ids = (name: string) => `${formId}-${name}`;

  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const check = checkDraft(draft);
  const isInterval = INTERVAL_PRESETS.includes(draft.presetType);
  const previewRequest: PreviewRequest | null = check.ok
    ? { ...check.cadence, timezone: draft.timezone }
    : null;
  // The API judges every cadence (interval limits, cron syntax, zone) while typing.
  const preview = useSchedulePreview(previewRequest);

  const saveError = create.error ?? update.error;
  const saveProblem = fieldProblem(saveError);
  const previewProblem = previewRequest ? fieldProblem(preview.error) : null;
  const problem = saveProblem ?? previewProblem;
  const problemField = problem ? formFieldOf(problem.field, draft) : null;

  /** The message shown under a field: the API's verdict first, then the form's own check. */
  const errorFor = (field: DraftField | "timezone" | "cadence"): string | undefined => {
    if (problem && problemField === field) {
      return t(problem.key);
    }
    if (field !== "timezone" && field !== "cadence" && !check.ok && check.field === field) {
      // Required fields complain only after a save attempt; out-of-range values at once.
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

  /** Save the draft. Failures stay on the mutation and show in the form. */
  const persist = async (): Promise<void> => {
    if (!check.ok) {
      return;
    }
    try {
      if (schedule) {
        const patch = patchFromDraft(schedule, draft, check.cadence);
        if (Object.keys(patch).length > 0) {
          onSaved("updated", await update.mutateAsync({ id: schedule.id, patch }));
        }
      } else {
        onSaved("created", await create.mutateAsync(inputFromDraft(draft, check.cadence)));
      }
      onDone();
    } catch {
      // Shown by the form: field problems at their field, anything else above the buttons.
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!check.ok) {
      return;
    }
    // Switching off backups or verification is asked about, as on the table's switch.
    if (schedule && needsDisableConfirmation(schedule) && !draft.enabled) {
      setConfirmingDisable(true);
      return;
    }
    void persist();
  };

  const scoped = OBJECT_SCOPED_KINDS.includes(draft.kind);
  const KindIcon = KIND_ICON[draft.kind];
  const runs: Date[] | null = !check.ok
    ? null
    : isInterval && check.cadence.intervalMinutes !== null
      ? intervalRuns(check.cadence.intervalMinutes, schedule?.lastRunAt ?? null, Date.now())
      : preview.data
        ? preview.data.next.map((instant) => new Date(instant))
        : null;
  const nonFieldError = saveError && !saveProblem ? saveError : null;

  return (
    <>
      <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit} noValidate>
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          <Field id={ids("kind")} label={t("form.kind")} hint={t(`kindHints.${draft.kind}`)}>
            <Select
              value={draft.kind}
              onValueChange={(value) => set("kind", value as OfferedKind)}
              disabled={schedule !== null}
            >
              <SelectTrigger
                id={ids("kind")}
                className="w-full"
                aria-describedby={messageId(ids("kind"))}
              >
                <SelectValue>
                  <span className="flex items-center gap-2">
                    <KindIcon aria-hidden="true" className="text-muted-foreground" />
                    {t(`kinds.${draft.kind}`)}
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {OFFERED_KINDS.map((kind) => {
                  const Icon = KIND_ICON[kind];
                  return (
                    <SelectItem key={kind} value={kind}>
                      <Icon aria-hidden="true" />
                      {t(`kinds.${kind}`)}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </Field>

          <fieldset className="space-y-4">
            <legend className="sr-only">{t("form.cadence")}</legend>
            <Field id={ids("preset")} label={t("form.preset")} error={errorFor("cadence")}>
              <Select
                value={draft.presetType}
                onValueChange={(value) => {
                  const presetType = value as PresetType;
                  setDraft((current) => ({
                    ...current,
                    presetType,
                    // Switching to a custom expression starts from what was described so far.
                    cron:
                      presetType === "custom" && current.cron.trim() === "" && check.ok
                        ? (check.cadence.cron ?? current.cron)
                        : current.cron,
                  }));
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
                {schedule?.lastRunAt ? t("form.intervalFromLastRun") : t("form.intervalStartsNow")}
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

          {scoped ? (
            <div className="space-y-3">
              <Label id={ids("scope-label")}>{t("form.scope")}</Label>
              <RadioGroup
                aria-labelledby={ids("scope-label")}
                value={draft.scope}
                onValueChange={(value) => set("scope", value as ScopeMode)}
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={ids("scope-all")} value="all" />
                  <Label htmlFor={ids("scope-all")} className="font-normal">
                    {t("scope.allObjects")}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={ids("scope-object")} value="object" />
                  <Label htmlFor={ids("scope-object")} className="font-normal">
                    {t("form.scopeObject")}
                  </Label>
                </div>
              </RadioGroup>
              {draft.scope === "object" ? (
                <Field id={ids("object")} label={t("form.object")} error={errorFor("object")}>
                  <ScopePicker
                    id={ids("object")}
                    value={draft.object}
                    onChange={(object) => set("object", object)}
                    invalid={Boolean(errorFor("object"))}
                    describedBy={messageId(ids("object"))}
                  />
                </Field>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("form.scopeTenant")}</p>
          )}

          <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor={ids("enabled")}>{t("form.enabled")}</Label>
              <p id={messageId(ids("enabled"))} className="text-xs text-muted-foreground">
                {t("form.enabledHint")}
              </p>
            </div>
            <Switch
              id={ids("enabled")}
              checked={draft.enabled}
              onCheckedChange={(checked) => set("enabled", checked)}
              aria-describedby={messageId(ids("enabled"))}
            />
          </div>

          {nonFieldError ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t(`common:${errorMessageKey(nonFieldError)}`)}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" onClick={onDone} disabled={saving}>
            {t("common:actions.cancel")}
          </Button>
          <Button type="submit" loading={saving}>
            {schedule ? t("form.save") : t("form.create")}
          </Button>
        </SheetFooter>
      </form>
      {/* Outside the form: the dialog's own submit must not bubble into the sheet's form. */}
      <DisableScheduleDialog
        schedule={confirmingDisable ? schedule : null}
        onCancel={() => setConfirmingDisable(false)}
        onConfirm={async () => {
          setConfirmingDisable(false);
          await persist();
        }}
      />
    </>
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
