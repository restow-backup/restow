import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { errorMessageKey } from "@/lib/api";

import {
  DEFAULT_NEW_KIND,
  OBJECT_SCOPED_KINDS,
  OFFERED_KINDS,
  type OfferedKind,
  type ScheduleItem,
} from "../api.js";
import { useCreateSchedule, useUpdateSchedule } from "../hooks.js";
import {
  KIND_ICON,
  type ScheduleDraft,
  type ScopeMode,
  browserTimeZone,
  checkDraft,
  draftFromSchedule,
  fieldProblem,
  inputFromDraft,
  needsDisableConfirmation,
  newDraft,
  patchFromDraft,
} from "../presenters.js";
import { CadenceFields } from "./cadence-fields.js";
import { DisableScheduleDialog } from "./schedule-dialogs.js";
import { ScopePicker } from "./scope-picker.js";

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

function ScheduleForm({ schedule, onDone, onSaved }: ScheduleFormProps) {
  const { t } = useTranslation("schedules");
  const [draft, setDraft] = React.useState<ScheduleDraft>(() =>
    schedule ? draftFromSchedule(schedule) : newDraft(browserTimeZone(), DEFAULT_NEW_KIND),
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

  const saveError = create.error ?? update.error;
  const saveProblem = fieldProblem(saveError);
  // Only the object is this form's own field; the cadence fields show the rest.
  const objectProblem = saveProblem?.field === "protectedObjectId" ? saveProblem : null;
  const cadenceProblem = saveProblem && !objectProblem ? saveProblem : null;
  const objectError = objectProblem
    ? t(objectProblem.key)
    : !check.ok && check.field === "object" && attempted
      ? t("validation.required.object")
      : undefined;

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

          <CadenceFields
            idPrefix={ids("cadence")}
            draft={draft}
            onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
            attempted={attempted}
            saveProblem={cadenceProblem}
            lastRunAt={schedule?.lastRunAt ?? null}
          />

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
                <Field id={ids("object")} label={t("form.object")} error={objectError}>
                  <ScopePicker
                    id={ids("object")}
                    value={draft.object}
                    onChange={(object) => set("object", object)}
                    invalid={Boolean(objectError)}
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
