import { Cable } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Step 5: sets the expectation for connecting a source. No source form is
 * embedded here: the real, working "Connect a source now" link appears on
 * the success screen, once the tenant — and so a place to connect a source
 * into — actually exists. The wizard shell already renders this step's
 * subtitle (`wizard.source.description`) above the step body, so this only
 * adds the one practical detail the subtitle does not: where to go next.
 */
export function SourceStep() {
  const { t } = useTranslation("tenants");
  return (
    <Alert>
      <Cable aria-hidden="true" />
      <AlertDescription>{t("wizard.source.notice")}</AlertDescription>
    </Alert>
  );
}
