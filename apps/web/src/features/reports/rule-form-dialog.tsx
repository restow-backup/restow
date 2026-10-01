import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useWebhooks } from "@/features/integrations/hooks";

import type { ReportEvent, ReportRule, ReportSection, ReportTrigger } from "./api";
import { REPORT_SECTIONS } from "./api";
import { useCreateRule, useReportsScope, useUpdateRule } from "./hooks";
import {
  EVENT_GROUPS,
  type Frequency,
  type RuleFormErrors,
  type RuleFormState,
  THROTTLE_OPTIONS,
  emptyRuleForm,
  eventGroupsFor,
  formToInput,
  ruleToForm,
  validateRuleForm,
} from "./presenters";
import { reportErrorMessage } from "./report-errors";

interface RuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The rule to edit; omit to create one of `trigger`. */
  rule?: ReportRule;
  trigger?: ReportTrigger;
  periods: readonly number[];
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;

/** Create or edit an alert (event rule) or a report (schedule rule). */
export function RuleFormDialog({
  open,
  onOpenChange,
  rule,
  trigger,
  periods,
}: RuleFormDialogProps) {
  const { t } = useTranslation("reports");
  const kind: ReportTrigger = rule?.trigger ?? trigger ?? "event";
  const [form, setForm] = React.useState<RuleFormState>(() =>
    rule ? ruleToForm(rule) : emptyRuleForm(kind),
  );
  const [errors, setErrors] = React.useState<RuleFormErrors>({});
  const create = useCreateRule();
  const update = useUpdateRule();
  const webhooks = useWebhooks();
  const { isProviderAdmin } = useReportsScope();
  const pending = create.isPending || update.isPending;

  React.useEffect(() => {
    if (open) {
      setForm(rule ? ruleToForm(rule) : emptyRuleForm(kind));
      setErrors({});
    }
  }, [open, rule, kind]);

  const set = <K extends keyof RuleFormState>(key: K, value: RuleFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggle = <T extends string>(list: readonly T[], value: T, on: boolean): T[] =>
    on ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateRuleForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const input = formToInput(form);
    const done = {
      onSuccess: () => {
        toast.success(t(rule ? "toasts.updated" : "toasts.created"));
        onOpenChange(false);
      },
      onError: (error: unknown) => toast.error(reportErrorMessage(error, t)),
    };
    if (rule) {
      const { trigger: _trigger, ...patch } = input;
      update.mutate({ id: rule.id, patch }, done);
    } else {
      create.mutate(input, done);
    }
  };

  const error = (key: keyof RuleFormErrors) => (errors[key] ? t(errors[key] as string) : undefined);
  const hooks = webhooks.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit} className="grid gap-6" noValidate>
          <DialogHeader>
            <DialogTitle>
              {t(rule ? `editor.title.edit.${kind}` : `editor.title.create.${kind}`)}
            </DialogTitle>
            <DialogDescription>{t(`editor.description.${kind}`)}</DialogDescription>
          </DialogHeader>

          <Field id="rule-name" label={t("editor.name")} error={error("name")}>
            <Input
              id="rule-name"
              value={form.name}
              maxLength={120}
              placeholder={t(`editor.namePlaceholder.${kind}`)}
              aria-invalid={errors.name !== undefined}
              aria-describedby={messageId("rule-name")}
              onChange={(e) => set("name", e.target.value)}
            />
          </Field>

          {kind === "event" ? (
            <>
              <fieldset className="space-y-3" aria-describedby="rule-events-message">
                <legend className="text-sm font-medium">{t("editor.events")}</legend>
                {eventGroupsFor(isProviderAdmin).map((group) => (
                  <div key={group} className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t(`eventGroups.${group}`)}
                    </p>
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {EVENT_GROUPS[group].map((name: ReportEvent) => {
                        const id = `rule-event-${name.replace(".", "-")}`;
                        return (
                          <li key={name}>
                            <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
                              <Checkbox
                                id={id}
                                checked={form.events.includes(name)}
                                onCheckedChange={(checked) =>
                                  set("events", toggle(form.events, name, checked === true))
                                }
                                className="mt-0.5"
                              />
                              <span className="space-y-0.5">
                                <span className="block text-sm">{t(`events.${name}`)}</span>
                                <span className="block text-xs text-muted-foreground">
                                  {t(`eventHints.${name}`)}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                <p
                  id="rule-events-message"
                  role={errors.events ? "alert" : undefined}
                  className={
                    errors.events ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                  }
                >
                  {error("events") ?? t("editor.eventsHint")}
                </p>
              </fieldset>

              <Field
                id="rule-throttle"
                label={t("editor.throttle")}
                hint={t("editor.throttleHint")}
              >
                <Select
                  value={String(form.throttleMinutes)}
                  onValueChange={(value) => set("throttleMinutes", Number(value))}
                >
                  <SelectTrigger id="rule-throttle" className="w-full sm:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {THROTTLE_OPTIONS.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {t(`editor.throttleOptions.${minutes}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id="rule-frequency" label={t("editor.frequency")}>
                  <Select
                    value={form.frequency}
                    onValueChange={(value) => set("frequency", value as Frequency)}
                  >
                    <SelectTrigger id="rule-frequency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["daily", "weekly", "monthly", "custom"] as const).map((frequency) => (
                        <SelectItem key={frequency} value={frequency}>
                          {t(`editor.frequencies.${frequency}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {form.frequency === "weekly" ? (
                  <Field id="rule-weekday" label={t("editor.weekday")}>
                    <Select
                      value={String(form.weekday)}
                      onValueChange={(value) => set("weekday", Number(value))}
                    >
                      <SelectTrigger id="rule-weekday" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((day) => (
                          <SelectItem key={day} value={String(day)}>
                            {t(`weekdays.${day}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                {form.frequency === "custom" ? (
                  <Field
                    id="rule-cron"
                    label={t("editor.cron")}
                    error={error("cron")}
                    hint={t("editor.cronHint")}
                    className="sm:col-span-2"
                  >
                    <Input
                      id="rule-cron"
                      className="font-mono"
                      value={form.cron}
                      placeholder="0 7 * * 1"
                      aria-invalid={errors.cron !== undefined}
                      aria-describedby={messageId("rule-cron")}
                      onChange={(e) => set("cron", e.target.value)}
                    />
                  </Field>
                ) : (
                  <Field id="rule-time" label={t("editor.time")} error={error("time")}>
                    <Input
                      id="rule-time"
                      type="time"
                      value={form.time}
                      aria-invalid={errors.time !== undefined}
                      aria-describedby={messageId("rule-time")}
                      onChange={(e) => set("time", e.target.value)}
                    />
                  </Field>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="rule-timezone"
                  label={t("editor.timezone")}
                  hint={t("editor.timezoneHint")}
                >
                  <Input
                    id="rule-timezone"
                    value={form.timezone}
                    className="font-mono"
                    onChange={(e) => set("timezone", e.target.value)}
                  />
                </Field>
                <Field id="rule-period" label={t("editor.period")}>
                  <Select
                    value={String(form.periodDays)}
                    onValueChange={(value) => set("periodDays", Number(value))}
                  >
                    <SelectTrigger id="rule-period" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {periods.map((days) => (
                        <SelectItem key={days} value={String(days)}>
                          {t("editor.periodDays", { count: days })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <fieldset className="space-y-2" aria-describedby="rule-sections-message">
                <legend className="text-sm font-medium">{t("editor.sections")}</legend>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {REPORT_SECTIONS.map((section: ReportSection) => {
                    const id = `rule-section-${section}`;
                    return (
                      <li key={section}>
                        <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
                          <Checkbox
                            id={id}
                            checked={form.sections.includes(section)}
                            onCheckedChange={(checked) =>
                              set("sections", toggle(form.sections, section, checked === true))
                            }
                            className="mt-0.5"
                          />
                          <span className="space-y-0.5">
                            <span className="block text-sm">{t(`sections.${section}`)}</span>
                            <span className="block text-xs text-muted-foreground">
                              {t(`sectionHints.${section}`)}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <p
                  id="rule-sections-message"
                  role={errors.sections ? "alert" : undefined}
                  className={errors.sections ? "text-xs text-destructive" : "sr-only"}
                >
                  {error("sections") ?? ""}
                </p>
              </fieldset>
            </>
          )}

          <fieldset className="space-y-4">
            <legend className="text-sm font-medium">{t("editor.channels")}</legend>
            <Field
              id="rule-recipients"
              label={t("editor.recipients")}
              error={error("recipients")}
              hint={t("editor.recipientsHint")}
            >
              <Textarea
                id="rule-recipients"
                rows={3}
                value={form.recipientsText}
                placeholder={t("editor.recipientsPlaceholder")}
                aria-invalid={errors.recipients !== undefined}
                aria-describedby={messageId("rule-recipients")}
                onChange={(e) => set("recipientsText", e.target.value)}
              />
            </Field>
            {kind === "schedule" ? (
              <div className="flex items-start gap-3">
                <Switch
                  id="rule-inapp"
                  checked={form.inApp}
                  onCheckedChange={(checked) => set("inApp", checked)}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="rule-inapp">{t("editor.inApp")}</Label>
                  <p className="text-xs text-muted-foreground">{t("editor.inAppHint")}</p>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("editor.bellAlways")}</p>
            )}
            <Field id="rule-webhook" label={t("editor.webhook")} hint={t("editor.webhookHint")}>
              <Select
                value={form.webhookId ?? "none"}
                onValueChange={(value) => set("webhookId", value === "none" ? null : value)}
              >
                <SelectTrigger id="rule-webhook" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("editor.noWebhook")}</SelectItem>
                  {hooks.map((hook) => (
                    <SelectItem key={hook.id} value={hook.id}>
                      {hook.name || hook.url}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {errors.channels ? (
              <p role="alert" className="text-xs text-destructive">
                {error("channels")}
              </p>
            ) : null}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="rule-language" label={t("editor.language")}>
              <Select
                value={form.language ?? "tenant"}
                onValueChange={(value) =>
                  set("language", value === "tenant" ? null : (value as "de" | "en"))
                }
              >
                <SelectTrigger id="rule-language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tenant">{t("editor.languageTenant")}</SelectItem>
                  <SelectItem value="de">{t("common:language.de")}</SelectItem>
                  <SelectItem value="en">{t("common:language.en")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="flex items-center gap-3 self-end pb-2">
              <Switch
                id="rule-enabled"
                checked={form.enabled}
                onCheckedChange={(checked) => set("enabled", checked)}
              />
              <Label htmlFor="rule-enabled">{t("editor.enabled")}</Label>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("editor.cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {t(rule ? "editor.save" : "editor.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
