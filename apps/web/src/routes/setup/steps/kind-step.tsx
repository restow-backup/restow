import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { SETUP_KINDS, type SetupKind } from "@/routes/setup/schema";

interface KindStepProps {
  value: SetupKind;
  onSelect: (kind: SetupKind) => void;
  /** A restore needs the opt-in updater here; without it the option explains the other way. */
  restoreInWizard: boolean;
}

/**
 * The wizard's first question after the language: a new installation, a restore of an
 * installation from a database dump, or a worker for an existing installation on another host
 * (docs/SIZING.md, "Several hosts: worker nodes"). Real replication is in development; the third
 * option says so.
 */
export function KindStep({ value, onSelect, restoreInWizard }: KindStepProps) {
  const { t } = useTranslation("setup");

  return (
    <div role="radiogroup" aria-label={t("step.kind")} className="grid gap-3">
      {SETUP_KINDS.map((kind) => {
        const selected = value === kind;
        return (
          <label
            key={kind}
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-lg border p-4 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
              selected ? "border-primary ring-1 ring-ring" : "border-border hover:bg-accent",
            )}
          >
            <input
              type="radio"
              name="setup-kind"
              value={kind}
              className="sr-only"
              checked={selected}
              onChange={() => onSelect(kind)}
            />
            <span className="font-medium">{t(`kind.${kind}.title`)}</span>
            <span className="text-xs text-muted-foreground">{t(`kind.${kind}.description`)}</span>
            {kind === "restore" && !restoreInWizard ? (
              <span className="text-xs text-muted-foreground">
                {t("kind.restore.withoutUpdater")}
              </span>
            ) : null}
            {kind === "worker" ? (
              <span className="text-xs text-muted-foreground">{t("kind.worker.note")}</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}
