import { cn } from "cn";
import { Loader2Icon } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Activity indicator for small, inline waits (a picker loading options, a
 * probe running). Page content loads behind skeletons instead. `label` is
 * shown next to the icon; without it, screen readers still hear "Loading".
 */
function Spinner({ className, label }: { className?: string; label?: string }) {
  const { t } = useTranslation();
  return (
    <output data-slot="spinner" aria-live="polite" className="inline-flex items-center gap-2">
      <Loader2Icon
        className={cn("size-4 animate-spin text-muted-foreground", className)}
        aria-hidden="true"
      />
      {label ? (
        <span className="text-sm text-muted-foreground">{label}</span>
      ) : (
        <span className="sr-only">{t("loading.label")}</span>
      )}
    </output>
  );
}

export { Spinner };
