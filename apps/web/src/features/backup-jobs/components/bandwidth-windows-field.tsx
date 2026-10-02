import { Plus, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import "../i18n.js";
import {
  WEEKDAYS,
  WINDOW_LIMITS,
  type WindowDraft,
  type WindowListCheck,
  type WindowProblem,
  checkWindowDrafts,
  daysText,
  endsNextDay,
  newWindowDraft,
  weekdayName,
  windowLength,
} from "../bandwidth-windows.js";

export interface BandwidthWindowsFieldProps {
  idPrefix: string;
  rows: WindowDraft[];
  onChange: (rows: WindowDraft[]) => void;
  /** The time zone the times are read in: the one of the schedule. */
  zone: string;
  /** What is wrong, row by row; the editor passes it only after a save was tried. */
  check?: WindowListCheck | null;
  /** What the server refused about the list, as text. */
  serverError?: string;
  disabled?: boolean;
}

/** The text of a problem of the windows in the backupjobs namespace. */
function useWindowProblemText() {
  const { t } = useTranslation("backupjobs");
  return (problem: WindowProblem | undefined): string | undefined =>
    problem ? t(`problems.form.windows.${problem.code}`, problem.values) : undefined;
}

/**
 * One sentence about a window, as the rows and the read-only views say it: "Mon-Fri, 22:00 to
 * 06:00 the next day: unlimited". A window whose end is not after its start says that it ends on
 * the next day; the same time twice says that it lasts 24 hours.
 */
export function useWindowSummary() {
  const { t, i18n } = useTranslation("backupjobs");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (window: { days: readonly number[]; from: string; to: string; kbps: number }): string => {
    const limit =
      window.kbps === 0
        ? t("bandwidth.windows.unlimited")
        : t("bandwidth.windows.limitValue", { kbps: window.kbps });
    const values = {
      days: daysText(window.days, language),
      from: window.from,
      to: window.to,
      limit,
    };
    if (windowLength(window.from, window.to) === 24 * 60) {
      return t("bandwidth.windows.summaryWholeDay", values);
    }
    return endsNextDay(window.from, window.to)
      ? t("bandwidth.windows.summaryNextDay", values)
      : t("bandwidth.windows.summary", values);
  };
}

/**
 * The time windows of the upload limit: a list of rows, each with the days it starts on, a start
 * and an end, and a limit (0 is unlimited), and a button to add one. Everything is reachable with
 * the keyboard (the days are one group that the arrow keys move through and Space switches),
 * every row names itself ("Window 2") for the buttons and the messages, and the sentence under a
 * row says what the window does in words, including that it ends on the next day.
 */
export function BandwidthWindowsField({
  idPrefix,
  rows,
  onChange,
  zone,
  check = null,
  serverError,
  disabled = false,
}: BandwidthWindowsFieldProps) {
  const { t, i18n } = useTranslation("backupjobs");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const problemText = useWindowProblemText();
  const summary = useWindowSummary();
  const addRef = React.useRef<HTMLButtonElement>(null);
  const [focusKey, setFocusKey] = React.useState<string | null>(null);
  const atMost = rows.length >= WINDOW_LIMITS.windows;
  const describedBy = `${idPrefix}-description`;

  // A row that was just added takes the focus on its first time field.
  React.useEffect(() => {
    if (focusKey) {
      document.getElementById(`${idPrefix}-${focusKey}-from`)?.focus();
      setFocusKey(null);
    }
  }, [focusKey, idPrefix]);

  const set = (key: string, patch: Partial<WindowDraft>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const add = () => {
    const row = newWindowDraft(rows);
    onChange([...rows, row]);
    setFocusKey(row.key);
  };

  const remove = (key: string) => {
    onChange(rows.filter((row) => row.key !== key));
    // The row that had the focus is gone: the button that adds one is the next stop.
    addRef.current?.focus();
  };

  const listProblem = problemText(check?.list) ?? serverError;
  return (
    <fieldset
      className="m-0 min-w-0 space-y-3 border-0 p-0"
      disabled={disabled}
      data-slot="bandwidth-windows"
    >
      <legend className="text-sm leading-none font-semibold">{t("bandwidth.windows.title")}</legend>
      <div id={describedBy} className="space-y-1 text-xs text-muted-foreground">
        <p>{t("bandwidth.windows.description")}</p>
        <p data-slot="windows-applies">{t("bandwidth.windows.applies")}</p>
        <p data-slot="windows-zone">{t("bandwidth.windows.zone", { zone })}</p>
        <p>{t("bandwidth.windows.rules")}</p>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {t("bandwidth.windows.empty")}
        </p>
      ) : (
        <ol className="space-y-3" aria-label={t("bandwidth.windows.list")}>
          {rows.map((row, index) => {
            const number = index + 1;
            const problems = check?.rows[index] ?? {};
            const id = (name: string) => `${idPrefix}-${row.key}-${name}`;
            const sound = Object.keys(problems).length === 0;
            const daysError = problemText(problems.days);
            const overlap = problemText(problems.window);
            const complete =
              row.days.length > 0 &&
              /^\d{2}:\d{2}$/.test(row.from) &&
              /^\d{2}:\d{2}$/.test(row.to) &&
              /^\d+$/.test(row.kbps.trim());
            return (
              <li
                key={row.key}
                data-slot="bandwidth-window"
                className="space-y-3 rounded-md border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">{t("bandwidth.windows.row", { number })}</h4>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("bandwidth.windows.remove", { number })}
                    onClick={() => remove(row.key)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <span id={id("days-label")} className="text-sm leading-none font-medium">
                    {t("bandwidth.windows.days")}
                  </span>
                  <ToggleGroup
                    type="multiple"
                    variant="outline"
                    size="sm"
                    aria-labelledby={id("days-label")}
                    aria-describedby={daysError ? messageId(id("days")) : undefined}
                    value={row.days.map(String)}
                    onValueChange={(values) =>
                      set(row.key, { days: values.map(Number).sort((a, b) => a - b) })
                    }
                    spacing={1}
                    className="flex-wrap"
                  >
                    {WEEKDAYS.map((day) => (
                      <ToggleGroupItem
                        key={day}
                        value={String(day)}
                        aria-label={weekdayName(day, language, "long")}
                        // A day that is on is filled, so that the week reads at a glance.
                        className="min-w-11 data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90"
                      >
                        {weekdayName(day, language, "short")}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  {daysError ? (
                    <p id={messageId(id("days"))} role="alert" className="text-xs text-destructive">
                      {daysError}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("bandwidth.windows.daysHint")}
                    </p>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Field
                    id={id("from")}
                    label={t("bandwidth.windows.from")}
                    error={problemText(problems.from)}
                  >
                    <Input
                      id={id("from")}
                      type="time"
                      value={row.from}
                      onChange={(event) => set(row.key, { from: event.target.value })}
                      aria-invalid={Boolean(problems.from) || undefined}
                      aria-describedby={messageId(id("from"))}
                      className="tabular-nums"
                    />
                  </Field>
                  <Field
                    id={id("to")}
                    label={t("bandwidth.windows.to")}
                    error={problemText(problems.to)}
                  >
                    <Input
                      id={id("to")}
                      type="time"
                      value={row.to}
                      onChange={(event) => set(row.key, { to: event.target.value })}
                      aria-invalid={Boolean(problems.to) || undefined}
                      aria-describedby={messageId(id("to"))}
                      className="tabular-nums"
                    />
                  </Field>
                  <Field
                    id={id("kbps")}
                    label={t("bandwidth.windows.limit")}
                    hint={t("bandwidth.windows.limitHint")}
                    error={problemText(problems.kbps)}
                  >
                    <Input
                      id={id("kbps")}
                      value={row.kbps}
                      onChange={(event) => set(row.key, { kbps: event.target.value })}
                      inputMode="numeric"
                      autoComplete="off"
                      aria-invalid={Boolean(problems.kbps) || undefined}
                      aria-describedby={messageId(id("kbps"))}
                      className="tabular-nums"
                    />
                  </Field>
                </div>

                {overlap ? (
                  <p role="alert" className="text-xs text-destructive" data-slot="window-overlap">
                    {overlap}
                  </p>
                ) : complete && sound ? (
                  <p className="text-xs text-muted-foreground" data-slot="window-summary">
                    {summary({
                      days: row.days,
                      from: row.from,
                      to: row.to,
                      kbps: Number.parseInt(row.kbps.trim(), 10),
                    })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {listProblem ? (
        <p role="alert" className="text-xs text-destructive">
          {listProblem}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          ref={addRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={atMost}
          aria-describedby={describedBy}
        >
          <Plus aria-hidden="true" />
          {t("bandwidth.windows.add")}
        </Button>
        {atMost ? (
          <span className="text-xs text-muted-foreground">
            {t("bandwidth.windows.max", { max: WINDOW_LIMITS.windows })}
          </span>
        ) : null}
      </div>
    </fieldset>
  );
}

/** What the editor passes as `check`: the problems of the rows, once a save was tried. */
export function windowCheckOf(rows: readonly WindowDraft[], attempted: boolean) {
  return attempted ? checkWindowDrafts(rows) : null;
}
