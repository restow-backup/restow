import { KeyRound, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PasskeyReady } from "@/lib/api";

interface PasskeyReadinessProps {
  readiness: PasskeyReady;
}

/**
 * States plainly whether passkeys will be offered and why not, instead of
 * hiding the gate (docs/ARCHITECTURE.md: the wizard states the condition
 * plainly instead of obscuring it).
 */
export function PasskeyReadiness({ readiness }: PasskeyReadinessProps) {
  const { t } = useTranslation("setup");

  return (
    <Alert variant={readiness.ready ? "default" : "info"}>
      {readiness.ready ? <KeyRound /> : <ShieldAlert />}
      <AlertTitle>{t("mode.passkey.title")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{readiness.ready ? t("mode.passkey.ready") : t("mode.passkey.notReady")}</p>
        {readiness.reasons.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {readiness.reasons.map((reason) => (
              <li key={reason}>{t(`mode.passkey.reasons.${reason}`)}</li>
            ))}
          </ul>
        ) : null}
        {readiness.rpId ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <dt>{t("mode.passkey.rpId")}</dt>
            <dd className="font-mono">{readiness.rpId}</dd>
            {readiness.origin ? (
              <>
                <dt>{t("mode.passkey.origin")}</dt>
                <dd className="font-mono">{readiness.origin}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
