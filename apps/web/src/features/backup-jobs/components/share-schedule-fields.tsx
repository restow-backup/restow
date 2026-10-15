import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import type { FormProblem } from "../form.js";
import type {
  ShareScheduleDraft,
  ShareScheduleKind,
  ShareScheduleProblems,
} from "../share-form.js";

/**
 * When a file share or copy job runs (docs/FILESHARES.md 7.5): every day at a time, every few
 * hours (at least one), or a cron expression, in the job's time zone.
 */
export function ShareScheduleFields({
  idPrefix,
  draft,
  onChange,
  problems,
  disabled = false,
}: {
  idPrefix: string;
  draft: ShareScheduleDraft;
  onChange: (next: ShareScheduleDraft) => void;
  problems: ShareScheduleProblems;
  disabled?: boolean;
}) {
  const { t } = useTranslation("backupjobs");
  const id = (name: string) => `${idPrefix}-${name}`;
  const text = (problem: FormProblem | undefined) =>
    problem ? t(`problems.form.${problem.code}`, problem.values ?? {}) : undefined;
  const set = (patch: Partial<ShareScheduleDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="grid gap-3" data-slot="share-schedule">
      <RadioGroup
        value={draft.kind}
        onValueChange={(value) => set({ kind: value as ShareScheduleKind })}
        className="flex flex-wrap gap-4"
        disabled={disabled}
        aria-label={t("shareEditor.schedule.kind")}
      >
        {(["daily", "interval", "cron"] as const).map((kind) => (
          <Label key={kind} htmlFor={id(kind)} className="flex items-center gap-2 font-normal">
            <RadioGroupItem id={id(kind)} value={kind} />
            {t(`shareEditor.schedule.kinds.${kind}`)}
          </Label>
        ))}
      </RadioGroup>
      <div className="grid gap-3 sm:grid-cols-2">
        {draft.kind === "daily" ? (
          <Field
            id={id("time")}
            label={t("shareEditor.schedule.time")}
            error={text(problems.timeOfDay)}
          >
            <Input
              id={id("time")}
              type="time"
              value={draft.timeOfDay}
              onChange={(event) => set({ timeOfDay: event.target.value })}
              disabled={disabled}
              aria-describedby={messageId(id("time"))}
            />
          </Field>
        ) : draft.kind === "interval" ? (
          <Field
            id={id("hours")}
            label={t("shareEditor.schedule.hours")}
            hint={t("shareEditor.schedule.hoursHint")}
            error={text(problems.intervalHours)}
          >
            <Input
              id={id("hours")}
              inputMode="numeric"
              value={draft.intervalHours}
              onChange={(event) => set({ intervalHours: event.target.value })}
              disabled={disabled}
              aria-describedby={messageId(id("hours"))}
            />
          </Field>
        ) : (
          <Field
            id={id("cron")}
            label={t("shareEditor.schedule.cron")}
            hint={t("shareEditor.schedule.cronHint")}
            error={text(problems.cron)}
          >
            <Input
              id={id("cron")}
              value={draft.cron}
              onChange={(event) => set({ cron: event.target.value })}
              disabled={disabled}
              className="font-mono"
              aria-describedby={messageId(id("cron"))}
            />
          </Field>
        )}
        <Field
          id={id("zone")}
          label={t("shareEditor.schedule.zone")}
          error={text(problems.timeZone)}
        >
          <Input
            id={id("zone")}
            value={draft.timeZone}
            onChange={(event) => set({ timeZone: event.target.value })}
            disabled={disabled}
            aria-describedby={messageId(id("zone"))}
          />
        </Field>
      </div>
    </div>
  );
}
