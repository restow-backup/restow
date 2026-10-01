import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The "Soon" mark of a menu entry whose feature does not exist yet
 * (lib/navigation.ts `NavItem.soon`): a word on the amber warning tint, never
 * colour alone and never green (green means proof). The visible word is
 * hidden from assistive technology; the entry adds ", coming soon" to its
 * name instead ({@link SoonSuffix}), so a screen reader hears "Jobs, coming
 * soon" rather than "Jobs Soon".
 */
export function SoonBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="warning"
      aria-hidden="true"
      data-slot="soon-badge"
      className={cn("px-1.5 py-0 text-[0.6875rem] leading-4", className)}
    >
      {t("nav.soon.badge")}
    </Badge>
  );
}

/** The spoken part of the "Soon" mark: ", coming soon" after the entry's label. */
export function SoonSuffix() {
  const { t } = useTranslation();
  return <span className="sr-only">{t("nav.soon.spoken")}</span>;
}
