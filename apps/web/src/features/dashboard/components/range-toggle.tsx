import { useTranslation } from "react-i18next";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import { STORAGE_RANGES, type StorageRange } from "../ranges.js";
import "../i18n.js";

/**
 * A segmented control for a chart's window: a radio group (Radix ToggleGroup
 * of type "single": `role="radiogroup"`, each option `role="radio"` with
 * `aria-checked`), Tab reaches the chosen option, the arrow keys move between
 * them. Pressing the chosen option again keeps it: a chart always has a window.
 */
export function RangeToggle<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  /** The accessible name of the group ("Period"). */
  label: string;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value}
      aria-label={label}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) {
          onChange(option.value);
        }
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="px-3 tabular-nums">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * The window of a storage growth chart: 1 week, 1 month, 3 months or 1 year,
 * for the history and the estimate alike. The start page's storage growth
 * chart uses it; the capacity planning page is meant to use the same one.
 */
export function StorageRangeToggle({
  value,
  onChange,
  disabled,
}: {
  value: StorageRange;
  onChange: (value: StorageRange) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <RangeToggle
      value={value}
      options={STORAGE_RANGES.map((range) => ({
        value: range,
        label: t(`storageGrowth.ranges.${range}`),
      }))}
      onChange={onChange}
      label={t("storageGrowth.range")}
      disabled={disabled}
    />
  );
}
