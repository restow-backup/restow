import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The operator responsibility notice (apps/api lib/disclaimer.ts): what the
 * operator answers for, in short paragraphs, and the explicit checkbox that
 * accepting requires. The text lives in the `setup` namespace (`disclaimer`),
 * so the wizard's first step and the dialog an installation that predates it
 * shows read exactly the same words. The product name comes from the branding
 * (`common:app.name`), never from the text.
 */

/** The points of the notice, in reading order (keys under `disclaimer.points`). */
export const DISCLAIMER_POINTS = [
  "strategy",
  "storage",
  "immutability",
  "keys",
  "security",
  "restore",
  "gobd",
  "warranty",
] as const;

interface DisclaimerNoticeProps {
  /** The version of the text the server asks to be accepted. */
  version: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** The server already holds this acceptance: the box shows ticked and stays locked. */
  accepted?: boolean;
  /** Work in progress (saving the acceptance): the box cannot change. */
  disabled?: boolean;
  /** Ids stay unique when a notice is rendered twice on one page. */
  idPrefix?: string;
  className?: string;
}

export function DisclaimerNotice({
  version,
  checked,
  onCheckedChange,
  accepted = false,
  disabled = false,
  idPrefix = "disclaimer",
  className,
}: DisclaimerNoticeProps) {
  const { t } = useTranslation("setup");
  const checkboxId = `${idPrefix}-accept`;
  const locked = accepted || disabled;

  return (
    <div className={cn("space-y-5", className)}>
      <p className="text-sm leading-relaxed">{t("disclaimer.intro")}</p>

      <ul className="space-y-3" aria-label={t("disclaimer.title")}>
        {DISCLAIMER_POINTS.map((point) => (
          <li key={point} className="rounded-md border bg-muted/30 p-3">
            <h3 className="text-sm font-medium">{t(`disclaimer.points.${point}.title`)}</h3>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t(`disclaimer.points.${point}.body`)}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-xs text-muted-foreground">{t("disclaimer.version", { version })}</p>

      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border p-4",
          checked ? "border-primary/50 bg-primary/5" : "bg-card",
        )}
      >
        <Checkbox
          id={checkboxId}
          checked={accepted || checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          disabled={locked}
          aria-required="true"
          aria-describedby={locked || checked ? undefined : `${checkboxId}-hint`}
          className="mt-0.5"
        />
        <div className="space-y-1">
          <Label htmlFor={checkboxId} className="text-sm leading-relaxed font-normal">
            {t("disclaimer.accept")}
          </Label>
          {accepted ? (
            <p className="text-xs text-muted-foreground">{t("disclaimer.accepted")}</p>
          ) : checked ? null : (
            <p id={`${checkboxId}-hint`} className="text-xs text-muted-foreground">
              {t("disclaimer.required")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
