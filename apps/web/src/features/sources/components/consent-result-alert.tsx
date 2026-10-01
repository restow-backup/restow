import { CircleCheck, CircleX, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ConsentMessage } from "../presenters";

const ICONS = { ok: CircleCheck, warning: TriangleAlert, destructive: CircleX } as const;

/** A granted consent is plain information (Lapis), not the green of a passed restore check. */
const VARIANT = { ok: "info", warning: "warning", destructive: "destructive" } as const;

/** What happened in the admin-consent round trip, shown once after Entra sent the admin back. */
export function ConsentResultAlert({
  message,
  onDismiss,
}: {
  message: ConsentMessage;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const Icon = ICONS[message.tone];
  return (
    <Alert variant={VARIANT[message.tone]}>
      <Icon />
      <AlertDescription className="flex items-start justify-between gap-3">
        <span className="pt-0.5">{t(message.key, message.values)}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label={tc("actions.close")}
          className="-my-1 shrink-0"
        >
          <X />
        </Button>
      </AlertDescription>
    </Alert>
  );
}
