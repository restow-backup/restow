import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  daysText,
  endsNextDay,
  WEEKDAYS,
  weekdayName,
  windowLength,
} from "@/features/backup-jobs/bandwidth-windows";

import "../i18n.js";
import {
  type AgentPolicyKey,
  type AgentPolicySettings,
  type AgentPolicySource,
  type AgentPolicyValues,
  type BackupWindow,
  type CatchUpPolicy,
  MAX_CATCH_UP_AGE_HOURS,
  MAX_RETRIES,
  type MachinePolicySource,
  policyValueProblem,
  type ResolvedAgentPolicy,
  resolveOnTop,
  type SnapshotOnFailure,
  startValue,
} from "../agent-policy.js";

export type PolicyLevel = "global" | "tenant" | "job";

export interface AgentPolicyFieldsProps {
  idPrefix: string;
  /** The level that is edited. */
  level: PolicyLevel;
  /** The settings shown, in order. */
  keys: readonly AgentPolicyKey[];
  /** What the levels above decide (the installation: the defaults). */
  above: ResolvedAgentPolicy;
  /** This level's own settings: a key that is present is set here. */
  value: AgentPolicySettings;
  onChange: (next: AgentPolicySettings) => void;
  /** The installation: the settings it locks for every tenant and job. */
  locks?: readonly AgentPolicyKey[];
  onLocksChange?: (next: AgentPolicyKey[]) => void;
  /** The zone a backup window is read in, when it is known (a job's schedule). */
  zone?: string;
  disabled?: boolean;
}

/** The words for one setting's value: "Mon–Fri, 20:00 to 06:00 the next day", "5 retries". */
export function usePolicyValueText() {
  const { t, i18n } = useTranslation("endpoints");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return <K extends AgentPolicyKey>(key: K, value: AgentPolicyValues[K]): string => {
    switch (key) {
      case "backupWindow": {
        const window = value as BackupWindow | null;
        if (!window) return t("policy.backupWindow.always");
        const values = { days: daysText(window.days, language), from: window.from, to: window.to };
        if (windowLength(window.from, window.to) === 24 * 60) {
          return t("policy.backupWindow.wholeDay", values);
        }
        return endsNextDay(window.from, window.to)
          ? t("policy.backupWindow.nextDay", values)
          : t("policy.backupWindow.sameDay", values);
      }
      case "catchUp": {
        const catchUp = value as CatchUpPolicy;
        if (!catchUp.enabled) return t("policy.catchUp.off");
        const mode = t(`policy.catchUp.modes.${catchUp.mode}`);
        return catchUp.maxAgeHours === null
          ? mode
          : t("policy.catchUp.withMaxAge", { mode, count: catchUp.maxAgeHours });
      }
      case "bandwidthKbps":
        return value === null
          ? t("policy.bandwidthKbps.unlimited")
          : t("policy.bandwidthKbps.value", { kbps: value as number });
      case "onlyOnAcPower":
        return value ? t("policy.onlyOnAcPower.on") : t("policy.onlyOnAcPower.off");
      case "snapshotOnFailure":
        return t(`policy.snapshotOnFailure.modes.${value as SnapshotOnFailure}`);
      default:
        return t("policy.retries.value", { count: value as number });
    }
  };
}

/** Where a value comes from, in words. */
export function useSourceText() {
  const { t } = useTranslation("endpoints");
  return (source: AgentPolicySource | MachinePolicySource) => t(`policy.source.${source}`);
}

/**
 * The settings of an agent policy at one level (installation, tenant or job). Each setting says
 * what applies and where it comes from (installation, tenant, job or the default) and whether the
 * installation locked it; a switch sets the value at this level, or lets it inherit. A setting the
 * installation locked cannot be set below it. The installation also locks settings here.
 */
export function AgentPolicyFields({
  idPrefix,
  level,
  keys,
  above,
  value,
  onChange,
  locks = [],
  onLocksChange,
  zone,
  disabled = false,
}: AgentPolicyFieldsProps) {
  const { t } = useTranslation("endpoints");
  const valueText = usePolicyValueText();
  const sourceText = useSourceText();
  const effective = resolveOnTop(above, value, level);

  const setKey = <K extends AgentPolicyKey>(key: K, next: AgentPolicyValues[K] | undefined) => {
    const copy: AgentPolicySettings = { ...value };
    if (next === undefined) {
      delete copy[key];
    } else {
      (copy as Record<string, unknown>)[key] = next;
    }
    onChange(copy);
  };

  return (
    <div className="space-y-3" data-slot="agent-policy-fields">
      {keys.map((key) => {
        const id = (name: string) => `${idPrefix}-${key}-${name}`;
        const lockedAbove = level !== "global" && above[key].locked;
        const own = value[key] !== undefined && !lockedAbove;
        const result = effective[key];
        const problem = own ? policyValueProblem(key, value[key]) : null;
        return (
          <section
            key={key}
            data-slot="policy-setting"
            data-key={key}
            aria-labelledby={id("title")}
            className="min-w-0 space-y-3 rounded-md border p-3"
          >
            <header className="space-y-1">
              <h4 id={id("title")} className="text-sm font-medium">
                {t(`policy.${key}.title`)}
              </h4>
              <p className="text-xs text-muted-foreground">{t(`policy.${key}.description`)}</p>
            </header>

            <p className="flex flex-wrap items-center gap-2 text-sm" data-slot="policy-effective">
              <span className="text-muted-foreground">{t("policy.applies")}</span>
              <span className="font-medium">{valueText(key, result.value as never)}</span>
              <Badge variant="outline" data-slot="policy-source">
                {sourceText(result.source)}
              </Badge>
              {result.locked || (level === "global" && locks.includes(key)) ? (
                <Badge variant="outline" data-slot="policy-locked">
                  <Lock aria-hidden="true" />
                  {t("policy.locked")}
                </Badge>
              ) : null}
            </p>

            {lockedAbove ? (
              <p className="text-xs text-muted-foreground" data-slot="policy-locked-note">
                {t("policy.lockedNote")}
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Switch
                    id={id("own")}
                    checked={own}
                    disabled={disabled}
                    onCheckedChange={(on) =>
                      setKey(
                        key,
                        on ? startValue(key, level === "global" ? null : above) : undefined,
                      )
                    }
                  />
                  <Label htmlFor={id("own")}>{t(`policy.own.${level}`)}</Label>
                </div>
                {own ? (
                  <ValueEditor
                    idPrefix={id("value")}
                    settingKey={key}
                    value={value[key] as AgentPolicyValues[typeof key]}
                    onChange={(next) => setKey(key, next)}
                    zone={zone}
                    error={problem ? t(`policy.problems.${problem}`) : undefined}
                    disabled={disabled}
                  />
                ) : null}
              </div>
            )}

            {level === "global" && onLocksChange ? (
              <div className="flex items-center gap-3 border-t pt-3">
                <Switch
                  id={id("lock")}
                  checked={locks.includes(key)}
                  disabled={disabled}
                  onCheckedChange={(on) =>
                    onLocksChange(
                      on
                        ? [...locks.filter((k) => k !== key), key]
                        : locks.filter((k) => k !== key),
                    )
                  }
                />
                <Label htmlFor={id("lock")}>{t("policy.lock")}</Label>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function wholeOrNull(text: string): number | null {
  if (text.trim() === "") return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : Number.NaN;
}

function ValueEditor<K extends AgentPolicyKey>({
  idPrefix,
  settingKey,
  value,
  onChange,
  zone,
  error,
  disabled,
}: {
  idPrefix: string;
  settingKey: K;
  value: AgentPolicyValues[K];
  onChange: (next: AgentPolicyValues[K]) => void;
  zone?: string;
  error?: string;
  disabled: boolean;
}) {
  const { t, i18n } = useTranslation("endpoints");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const set = (next: unknown) => onChange(next as AgentPolicyValues[K]);

  switch (settingKey) {
    case "backupWindow": {
      const window = value as BackupWindow | null;
      return (
        <div className="space-y-3">
          <RadioGroup
            value={window ? "window" : "always"}
            onValueChange={(choice) =>
              set(
                choice === "always"
                  ? null
                  : (window ?? { days: [1, 2, 3, 4, 5], from: "20:00", to: "06:00" }),
              )
            }
            disabled={disabled}
            aria-label={t("policy.backupWindow.title")}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${idPrefix}-always`} value="always" />
              <Label htmlFor={`${idPrefix}-always`}>{t("policy.backupWindow.always")}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`${idPrefix}-window`} value="window" />
              <Label htmlFor={`${idPrefix}-window`}>{t("policy.backupWindow.onlyIn")}</Label>
            </div>
          </RadioGroup>
          {window ? (
            <div className="space-y-3 pl-6">
              <div className="space-y-1.5">
                <span id={`${idPrefix}-days-label`} className="text-sm leading-none font-medium">
                  {t("policy.backupWindow.days")}
                </span>
                <ToggleGroup
                  type="multiple"
                  variant="outline"
                  size="sm"
                  aria-labelledby={`${idPrefix}-days-label`}
                  value={window.days.map(String)}
                  onValueChange={(values) =>
                    set({ ...window, days: values.map(Number).sort((a, b) => a - b) })
                  }
                  spacing={1}
                  className="flex-wrap"
                  disabled={disabled}
                >
                  {WEEKDAYS.map((day) => (
                    <ToggleGroupItem
                      key={day}
                      value={String(day)}
                      aria-label={weekdayName(day, language, "long")}
                      className="min-w-11 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90"
                    >
                      {weekdayName(day, language, "short")}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="flex flex-wrap gap-3">
                <Field id={`${idPrefix}-from`} label={t("policy.backupWindow.from")}>
                  <Input
                    id={`${idPrefix}-from`}
                    type="time"
                    value={window.from}
                    disabled={disabled}
                    onChange={(event) => set({ ...window, from: event.target.value })}
                    className="w-32 tabular-nums"
                  />
                </Field>
                <Field id={`${idPrefix}-to`} label={t("policy.backupWindow.to")}>
                  <Input
                    id={`${idPrefix}-to`}
                    type="time"
                    value={window.to}
                    disabled={disabled}
                    onChange={(event) => set({ ...window, to: event.target.value })}
                    className="w-32 tabular-nums"
                  />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                {zone
                  ? t("policy.backupWindow.zone", { zone })
                  : t("policy.backupWindow.zoneOfSchedule")}{" "}
                {t("policy.backupWindow.rules")}
              </p>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      );
    }
    case "catchUp": {
      const catchUp = value as CatchUpPolicy;
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch
              id={`${idPrefix}-enabled`}
              checked={catchUp.enabled}
              disabled={disabled}
              onCheckedChange={(enabled) => set({ ...catchUp, enabled })}
            />
            <Label htmlFor={`${idPrefix}-enabled`}>{t("policy.catchUp.enabled")}</Label>
          </div>
          {catchUp.enabled ? (
            <div className="space-y-3 pl-6">
              <RadioGroup
                value={catchUp.mode}
                onValueChange={(mode) => set({ ...catchUp, mode })}
                disabled={disabled}
                aria-label={t("policy.catchUp.when")}
              >
                {(["asap", "next_window"] as const).map((mode) => (
                  <div key={mode} className="flex items-center gap-2">
                    <RadioGroupItem id={`${idPrefix}-${mode}`} value={mode} />
                    <Label htmlFor={`${idPrefix}-${mode}`}>
                      {t(`policy.catchUp.modes.${mode}`)}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
              <Field
                id={`${idPrefix}-age`}
                label={t("policy.catchUp.maxAge")}
                hint={t("policy.catchUp.maxAgeHint", { max: MAX_CATCH_UP_AGE_HOURS })}
                error={error}
              >
                <Input
                  id={`${idPrefix}-age`}
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={disabled}
                  placeholder={t("policy.catchUp.anyAge")}
                  value={catchUp.maxAgeHours === null ? "" : String(catchUp.maxAgeHours)}
                  onChange={(event) =>
                    set({ ...catchUp, maxAgeHours: wholeOrNull(event.target.value) })
                  }
                  aria-invalid={Boolean(error) || undefined}
                  aria-describedby={messageId(`${idPrefix}-age`)}
                  className="w-40 tabular-nums"
                />
              </Field>
            </div>
          ) : null}
        </div>
      );
    }
    case "bandwidthKbps":
      return (
        <Field
          id={`${idPrefix}-kbps`}
          label={t("policy.bandwidthKbps.label")}
          hint={t("policy.bandwidthKbps.hint")}
          error={error}
        >
          <Input
            id={`${idPrefix}-kbps`}
            inputMode="numeric"
            autoComplete="off"
            disabled={disabled}
            placeholder={t("policy.bandwidthKbps.unlimited")}
            value={value === null ? "" : Number.isNaN(value) ? "" : String(value)}
            onChange={(event) => set(wholeOrNull(event.target.value))}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={messageId(`${idPrefix}-kbps`)}
            className="w-56 tabular-nums"
          />
        </Field>
      );
    case "onlyOnAcPower":
      return (
        <div className="flex items-center gap-3">
          <Switch
            id={`${idPrefix}-ac`}
            checked={value as boolean}
            disabled={disabled}
            onCheckedChange={(on) => set(on)}
          />
          <Label htmlFor={`${idPrefix}-ac`}>{t("policy.onlyOnAcPower.on")}</Label>
        </div>
      );
    case "snapshotOnFailure":
      return (
        <RadioGroup
          value={value as SnapshotOnFailure}
          onValueChange={(next) => {
            if (next === "continue" || next === "fail") set(next);
          }}
          disabled={disabled}
          aria-label={t("policy.snapshotOnFailure.title")}
          className="grid gap-2"
        >
          {(["continue", "fail"] as const).map((mode) => (
            <div key={mode} className="flex items-start gap-2">
              <RadioGroupItem value={mode} id={`${idPrefix}-snapshot-${mode}`} className="mt-0.5" />
              <Label htmlFor={`${idPrefix}-snapshot-${mode}`} className="grid gap-0.5 font-normal">
                <span className="text-sm">{t(`policy.snapshotOnFailure.modes.${mode}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`policy.snapshotOnFailure.hints.${mode}`)}
                </span>
              </Label>
            </div>
          ))}
        </RadioGroup>
      );
    default:
      return (
        <Field
          id={`${idPrefix}-retries`}
          label={t("policy.retries.label")}
          hint={t("policy.retries.hint", { max: MAX_RETRIES })}
          error={error}
        >
          <Input
            id={`${idPrefix}-retries`}
            type="number"
            min={0}
            max={MAX_RETRIES}
            disabled={disabled}
            value={Number.isNaN(value) ? "" : String(value)}
            onChange={(event) => set(wholeOrNull(event.target.value) ?? Number.NaN)}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={messageId(`${idPrefix}-retries`)}
            className="w-28 tabular-nums"
          />
        </Field>
      );
  }
}
