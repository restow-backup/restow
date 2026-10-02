import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { SETUP_LANGUAGES, type SetupLanguage } from "@/routes/setup/schema";

interface LanguageStepProps {
  /** The language the wizard runs in right now. */
  value: SetupLanguage;
  /** The operator picked a language; the app switches to it at once. */
  onSelect: (language: SetupLanguage) => void;
}

/**
 * First wizard step: the language of the wizard, and of the mails and reports
 * of the operator's own organisation. Both choices name themselves in their own
 * language, whatever language the page is in right now, so a visitor finds
 * theirs at a glance. The wizard starts with the browser's language selected.
 */
export function LanguageStep({ value, onSelect }: LanguageStepProps) {
  const { t } = useTranslation("setup");

  return (
    <div role="radiogroup" aria-label={t("step.language")} className="grid gap-3 sm:grid-cols-2">
      {SETUP_LANGUAGES.map((language) => {
        const selected = value === language;
        return (
          <label
            key={language}
            lang={language}
            className={cn(
              "flex cursor-pointer flex-col gap-2 rounded-lg border p-4 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              selected ? "border-primary ring-1 ring-ring" : "border-border hover:bg-accent",
            )}
          >
            <input
              type="radio"
              name="setup-language"
              value={language}
              className="sr-only"
              checked={selected}
              onChange={() => onSelect(language)}
            />
            <span aria-hidden="true" className="font-mono text-sm font-semibold text-primary">
              {language.toUpperCase()}
            </span>
            <span className="font-medium">{t("language.card.title", { lng: language })}</span>
            <span className="text-xs text-muted-foreground">
              {t("language.card.description", { lng: language })}
            </span>
          </label>
        );
      })}
    </div>
  );
}
