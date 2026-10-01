import { ShieldQuestion } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ObjectReadiness } from "@/features/verify/api";
import type { VerifyFormat } from "@/features/verify/use-verify";

/**
 * "The latest backup is not verified yet": shown while any object has a
 * backup no check has read back, with the one action that resolves it.
 * Objects whose check is already queued or running are counted, not queued
 * again.
 */
export function UnverifiedCallout({
  items,
  format,
  starting,
  disabled,
  onVerify,
}: {
  items: readonly ObjectReadiness[];
  format: VerifyFormat;
  starting: boolean;
  disabled: boolean;
  onVerify: () => void;
}) {
  const { t } = format;
  const unverified = items.filter((item) => item.state === "unverified");
  if (unverified.length === 0) {
    return null;
  }
  const running = unverified.filter((item) => item.running !== null).length;
  const waiting = unverified.length - running;
  return (
    <Alert variant="warning">
      <ShieldQuestion aria-hidden="true" />
      <AlertTitle>{t("unverified.title", { count: unverified.length })}</AlertTitle>
      <AlertDescription>
        <p>{t("unverified.description", { count: unverified.length })}</p>
        {running > 0 ? <p>{t("unverified.running", { count: running })}</p> : null}
        {waiting > 0 ? (
          <Button
            size="sm"
            className="mt-2"
            onClick={onVerify}
            loading={starting}
            disabled={disabled || starting}
          >
            {t("actions.verifyNow")}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
