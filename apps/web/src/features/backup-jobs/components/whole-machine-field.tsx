import { Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { excludesAll, type SettingsDraft, toggledExcludes, withWholeMachine } from "../form.js";

export interface WholeMachineDefaults {
  excludes: readonly string[];
  containerImageExcludes: readonly string[];
}

export interface WholeMachineFieldProps {
  idPrefix: string;
  draft: Pick<SettingsDraft, "wholeMachine" | "excludes" | "previousExcludes">;
  defaults: WholeMachineDefaults;
  onChange: (next: Pick<SettingsDraft, "wholeMachine" | "excludes" | "previousExcludes">) => void;
  /**
   * The installation has the preview off, but the job kept the switch: it can only be turned off,
   * and the agents back up the folders meanwhile.
   */
  offOnly?: boolean;
}

/**
 * "Whole machine (bare metal, preview)" of a machine job (docs/BAREMETAL.md 5.1, 5.3): every local
 * file system of a Linux machine with its disk layout instead of the folders. Switching it on
 * replaces the exclusions with the whole machine list (the previous ones can be put back); the
 * container images of the btrfs storage driver can be left to download again after a restore.
 * The folders stay: an agent older than 0.5.0 backs them up.
 */
export function WholeMachineField({
  idPrefix,
  draft,
  defaults,
  onChange,
  offOnly = false,
}: WholeMachineFieldProps) {
  const { t } = useTranslation("backupjobs");
  const switchId = `${idPrefix}-switch`;
  const hintId = `${idPrefix}-hint`;
  const imagesId = `${idPrefix}-images`;
  const images = excludesAll(draft.excludes, defaults.containerImageExcludes);
  const previous = draft.previousExcludes;
  const canRestore =
    draft.wholeMachine &&
    previous !== null &&
    (previous.length !== draft.excludes.length ||
      previous.some((pattern, index) => draft.excludes[index] !== pattern));

  return (
    <div className="space-y-3" data-slot="whole-machine-field">
      <div className="flex items-start gap-3">
        <Switch
          id={switchId}
          checked={draft.wholeMachine}
          disabled={offOnly && !draft.wholeMachine}
          aria-describedby={hintId}
          onCheckedChange={(checked) =>
            onChange(withWholeMachine(draft, checked === true, defaults))
          }
        />
        <div className="space-y-1">
          <Label htmlFor={switchId}>{t("wholeMachine.label")}</Label>
          <p id={hintId} className="text-xs text-muted-foreground">
            {offOnly ? t("wholeMachine.previewOff") : t("wholeMachine.hint")}
          </p>
        </div>
      </div>
      {draft.wholeMachine && !offOnly ? (
        <div className="space-y-2 pl-12">
          <div className="flex items-start gap-2">
            <Checkbox
              id={imagesId}
              checked={images}
              onCheckedChange={(checked) =>
                onChange({
                  ...draft,
                  excludes: toggledExcludes(
                    draft.excludes,
                    defaults.containerImageExcludes,
                    checked === true,
                  ),
                })
              }
            />
            <Label htmlFor={imagesId} className="text-sm font-normal">
              {t("wholeMachine.containerImages")}
            </Label>
          </div>
          {canRestore && previous ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange({ ...draft, excludes: [...previous] })}
            >
              <Undo2 aria-hidden="true" />
              {t("wholeMachine.restoreExcludes")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
