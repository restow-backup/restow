import { Check, Plus, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { messageId } from "@/components/forms/field";
import { HintTooltip } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Toggle } from "@/components/ui/toggle";

import { LIMITS } from "../api.js";
import {
  EXCLUSION_PRESETS,
  addOwnPattern,
  ownPatterns,
  patternProblem,
  patternsOfText,
  presetIsOn,
  removePattern,
  togglePreset,
} from "../exclusions.js";

export interface ExclusionsValue {
  excludes: string[];
  largerEnabled: boolean;
  largerGib: string;
}

export interface ExclusionsFieldProps {
  idPrefix: string;
  value: ExclusionsValue;
  onChange: (next: ExclusionsValue) => void;
  /** What is wrong with the list of patterns, shown under the chips. */
  excludesError?: string;
  /** What is wrong with the size limit. */
  largerError?: string;
  disabled?: boolean;
}

/**
 * What a machine job leaves out: file types as chips that stand for stored
 * patterns, patterns of its own, and an optional size limit. The stored value is
 * the plain list of patterns; a chip is on when all of its patterns are in the
 * list. Only exclusions: restic backs up everything it is not told to skip.
 */
export function ExclusionsField({
  idPrefix,
  value,
  onChange,
  excludesError,
  largerError,
  disabled = false,
}: ExclusionsFieldProps) {
  const { t } = useTranslation("backupjobs");
  const [typed, setTyped] = React.useState("");
  const [typedProblem, setTypedProblem] = React.useState<string | null>(null);
  const own = ownPatterns(value.excludes);
  const inputId = `${idPrefix}-pattern`;
  const largerId = `${idPrefix}-larger`;
  const set = (patch: Partial<ExclusionsValue>) => onChange({ ...value, ...patch });

  const commit = (lines: string[]) => {
    if (lines.length === 0) {
      return;
    }
    let next = value.excludes;
    for (const line of lines) {
      const problem = patternProblem(line);
      if (problem && problem !== "empty") {
        setTypedProblem(
          t(`problems.form.excludes.${problem}`, { value: line, max: LIMITS.excludeLength }),
        );
        return;
      }
      next = addOwnPattern(next, line);
    }
    if (next.length > LIMITS.excludes) {
      setTypedProblem(t("problems.form.excludes.tooMany", { max: LIMITS.excludes }));
      return;
    }
    set({ excludes: next });
    setTyped("");
    setTypedProblem(null);
  };
  const add = () => commit(patternsOfText(typed));

  const message = excludesError ?? typedProblem;
  return (
    <div className="space-y-4" data-slot="exclusions-field">
      <div className="space-y-2">
        <fieldset className="m-0 min-w-0 space-y-2 border-0 p-0">
          <legend className="text-sm leading-none font-medium">{t("exclusions.types")}</legend>
          <div className="flex flex-wrap gap-2">
            {EXCLUSION_PRESETS.map((preset) => {
              const on = presetIsOn(value.excludes, preset);
              const patternsText = preset.patterns.join("  ");
              return (
                <HintTooltip
                  key={preset.id}
                  content={<span className="font-mono text-xs break-all">{patternsText}</span>}
                >
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={on}
                    disabled={disabled}
                    aria-describedby={`${idPrefix}-${preset.id}-patterns`}
                    onPressedChange={() => set({ excludes: togglePreset(value.excludes, preset) })}
                    className="data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-foreground"
                  >
                    {on ? <Check aria-hidden="true" /> : null}
                    {t(`exclusions.presets.${preset.id}`)}
                  </Toggle>
                </HintTooltip>
              );
            })}
          </div>
        </fieldset>
        {EXCLUSION_PRESETS.map((preset) => (
          <span key={preset.id} id={`${idPrefix}-${preset.id}-patterns`} className="sr-only">
            {preset.patterns.join(", ")}
          </span>
        ))}
        <p className="text-xs text-muted-foreground">{t("exclusions.typesHint")}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={inputId}>{t("exclusions.own")}</Label>
        {own.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("exclusions.ownList")}>
            {own.map((pattern) => (
              <li
                key={pattern}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 font-mono text-xs"
              >
                <span className="min-w-0 break-all">{pattern}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={t("exclusions.remove", { pattern })}
                  onClick={() => set({ excludes: removePattern(value.excludes, pattern) })}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-48 flex-1">
            <Input
              id={inputId}
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
                setTypedProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  add();
                }
              }}
              onPaste={(event) => {
                // Several lines pasted at once are several patterns.
                const text = event.clipboardData.getData("text");
                if (/\r?\n/.test(text)) {
                  event.preventDefault();
                  commit(patternsOfText(text));
                }
              }}
              disabled={disabled}
              placeholder={t("exclusions.placeholder")}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
              aria-invalid={Boolean(message) || undefined}
              aria-describedby={messageId(inputId)}
            />
          </div>
          <Button type="button" variant="outline" disabled={disabled} onClick={add}>
            <Plus aria-hidden="true" />
            {t("exclusions.add")}
          </Button>
        </div>
        <p
          id={messageId(inputId)}
          role={message ? "alert" : undefined}
          className={message ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {message ?? t("exclusions.ownHint")}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <Switch
            id={`${largerId}-on`}
            checked={value.largerEnabled}
            disabled={disabled}
            onCheckedChange={(checked) => set({ largerEnabled: checked })}
          />
          <Label htmlFor={`${largerId}-on`} className="font-normal">
            {t("exclusions.largerThan")}
          </Label>
          <Input
            id={largerId}
            value={value.largerGib}
            onChange={(event) => set({ largerGib: event.target.value })}
            disabled={disabled || !value.largerEnabled}
            inputMode="decimal"
            autoComplete="off"
            aria-label={t("exclusions.largerSize")}
            aria-invalid={Boolean(largerError) || undefined}
            aria-describedby={messageId(largerId)}
            className="w-24 tabular-nums"
          />
          <span className="text-sm text-muted-foreground">{t("exclusions.gb")}</span>
        </div>
        <p
          id={messageId(largerId)}
          role={largerError ? "alert" : undefined}
          className={largerError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {largerError ?? t("exclusions.largerHint")}
        </p>
      </div>
    </div>
  );
}
