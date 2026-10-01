import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { RetentionTier } from "../api.js";
import { addTier as addTierTo, removeTier as removeTierFrom } from "../presenters.js";

export interface TierEditorProps {
  id: string;
  value: readonly RetentionTier[];
  onChange: (tiers: RetentionTier[]) => void;
  invalid?: boolean;
  describedBy?: string;
}

/**
 * The tier rows of a custom policy: an age range, and how thinly it keeps
 * restore points within it (every one, or one per N days). The API is the
 * final judge of whether the list is contiguous; this only edits the rows.
 */
export function TierEditor({ id, value, onChange, invalid, describedBy }: TierEditorProps) {
  const { t } = useTranslation("retention");

  const update = (index: number, patch: Partial<RetentionTier>) => {
    onChange(value.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
  };

  const addTier = () => onChange(addTierTo(value));
  const removeTier = (index: number) => onChange(removeTierFrom(value, index));

  return (
    <div id={id} aria-describedby={describedBy} className="space-y-3">
      {value.map((tier, index) => {
        const rowId = `${id}-${index}`;
        const isLast = index === value.length - 1;
        return (
          <div
            key={rowId}
            className="grid grid-cols-[1fr_1fr_1.4fr_auto] items-end gap-2 rounded-md border border-border p-3"
            data-invalid={invalid || undefined}
          >
            <div className="space-y-1">
              <Label htmlFor={`${rowId}-from`} className="text-xs font-normal">
                {t("form.tierFrom")}
              </Label>
              <Input
                id={`${rowId}-from`}
                type="number"
                inputMode="numeric"
                min={0}
                value={tier.fromDays}
                disabled={index > 0}
                onChange={(event) => update(index, { fromDays: Number(event.target.value) })}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${rowId}-to`} className="text-xs font-normal">
                {t("form.tierTo")}
              </Label>
              <Input
                id={`${rowId}-to`}
                type="number"
                inputMode="numeric"
                min={tier.fromDays + 1}
                value={tier.toDays ?? ""}
                placeholder={isLast ? t("form.tierToForever") : undefined}
                disabled={!isLast}
                onChange={(event) =>
                  update(index, {
                    toDays: event.target.value === "" ? null : Number(event.target.value),
                  })
                }
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${rowId}-keep`} className="text-xs font-normal">
                {t("form.tierKeepEvery")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`${rowId}-keep`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={tier.keepEveryDays}
                  onChange={(event) => update(index, { keepEveryDays: Number(event.target.value) })}
                  className="w-20 tabular-nums"
                />
                <span className="text-xs text-muted-foreground">
                  {tier.keepEveryDays <= 0
                    ? t("form.tierKeepEveryEvery")
                    : t("form.tierKeepEveryDays", { days: tier.keepEveryDays })}
                </span>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeTier(index)}
              aria-label={t("form.removeTier")}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={addTier}>
        <Plus aria-hidden="true" />
        {t("form.addTier")}
      </Button>
    </div>
  );
}
