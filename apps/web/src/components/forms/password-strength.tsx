import { useTranslation } from "react-i18next";

import { assessPassword } from "@/lib/password";
import { cn } from "@/lib/utils";

const SEGMENTS = [1, 2, 3, 4] as const;

/** Four-segment meter with a translated verdict; purely advisory. */
export function PasswordStrength({ password }: { password: string }) {
  const { t } = useTranslation("setup");
  const assessment = assessPassword(password);
  // A strong password is good, not a passed restore check: Lapis, never green.
  const tone =
    assessment.score >= 3 ? "bg-info" : assessment.score === 2 ? "bg-warning" : "bg-destructive";

  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex gap-1" aria-hidden="true">
        {SEGMENTS.map((segment) => (
          <span
            key={segment}
            className={cn(
              "h-1.5 flex-1 rounded-full bg-muted transition-colors",
              segment <= assessment.score && tone,
            )}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("admin.strength.label")}: {t(`admin.strength.${assessment.strength}`)}
      </p>
    </div>
  );
}
