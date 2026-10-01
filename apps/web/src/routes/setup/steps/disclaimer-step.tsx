import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DisclaimerNotice } from "@/features/disclaimer/disclaimer-notice";

/** Why the server did not take the acceptance with the setup request, when it did not. */
export type DisclaimerStepError = "versionChanged" | "serverRequired";

interface DisclaimerStepProps {
  /** The version of the text the server asks to be accepted. */
  version: string;
  /** The notice counts as accepted already (demo mode). */
  accepted: boolean;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  error: DisclaimerStepError | null;
  /** Read the current text again (the version moved on while the page was open). */
  onReload: () => void;
}

/**
 * The operator responsibility notice, right after the setup token. The box
 * must be ticked to continue; the acceptance is sent with the setup request
 * and recorded with the new administrator, and the server refuses the setup
 * without it.
 */
export function DisclaimerStep({
  version,
  accepted,
  checked,
  onCheckedChange,
  error,
  onReload,
}: DisclaimerStepProps) {
  const { t } = useTranslation("setup");

  return (
    <div className="space-y-5">
      <DisclaimerNotice
        version={version}
        checked={checked}
        onCheckedChange={onCheckedChange}
        accepted={accepted}
      />
      {error ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {error === "versionChanged"
                ? t("disclaimer.versionChanged")
                : t("disclaimer.serverRequired")}
            </span>
            {error === "versionChanged" ? (
              <Button type="button" size="sm" variant="outline" onClick={onReload}>
                {t("disclaimer.reload")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
