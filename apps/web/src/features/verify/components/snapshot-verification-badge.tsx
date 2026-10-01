import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { HintTooltip, StatusBadge, absoluteLabel, toDate } from "@/components/kit";
import type { SnapshotVerification, VerificationState } from "@/features/verify/api";
import "@/features/verify/i18n";
import { snapshotVerificationView } from "@/features/verify/presenters";

const ICON = {
  green: ShieldCheck,
  yellow: ShieldAlert,
  red: ShieldX,
  unverified: ShieldQuestion,
} as const satisfies Record<VerificationState, unknown>;

export interface SnapshotVerificationBadgeProps {
  verification: SnapshotVerification;
  /**
   * Whether the badge is a tab stop that opens its tooltip (default true).
   * Inside a select option, where nothing can take focus, pass false: the
   * tooltip then opens on hover and its text is read out with the label.
   */
  focusable?: boolean;
  className?: string;
}

/**
 * The verification of one backup, as every snapshot list shows it: "Verified"
 * with the check date in a tooltip, or "Not verified yet" in the warning tone.
 * A backup no check has read back is never shown in a success tone.
 */
export function SnapshotVerificationBadge({
  verification,
  focusable = true,
  className,
}: SnapshotVerificationBadgeProps) {
  const { t, i18n } = useTranslation("verify");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const view = snapshotVerificationView(verification, (iso) => {
    const date = toDate(iso);
    return date ? absoluteLabel(date, language) : iso;
  });
  const hint = t(view.hint.key, view.hint.values);
  return (
    <HintTooltip content={hint}>
      <StatusBadge
        tone={view.tone}
        icon={ICON[verification.state] ?? ShieldQuestion}
        tabIndex={focusable ? 0 : undefined}
        className={className}
        data-verification={verification.state}
      >
        {t(view.label.key)}
        {focusable ? null : <span className="sr-only">. {hint}</span>}
      </StatusBadge>
    </HintTooltip>
  );
}
