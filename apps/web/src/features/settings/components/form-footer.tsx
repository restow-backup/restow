import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";

interface FormFooterProps {
  formId: string;
  dirty: boolean;
  saving: boolean;
  onDiscard: () => void;
}

/** Save and discard for one settings card; says plainly when there is something unsaved. */
export function FormFooter({ formId, dirty, saving, onDiscard }: FormFooterProps) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  return (
    <CardFooter className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {dirty ? t("form.unsaved") : t("form.saved")}
      </p>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
        <Button variant="outline" onClick={onDiscard} disabled={!dirty || saving}>
          {t("form.discard")}
        </Button>
        <Button type="submit" form={formId} loading={saving} disabled={!dirty}>
          {tc("actions.save")}
        </Button>
      </div>
    </CardFooter>
  );
}
