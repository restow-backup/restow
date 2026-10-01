import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { Input } from "@/components/ui/input";

/** Why the entered setup token was not accepted, when it was not. */
export type TokenStepError = "required" | "invalid" | "changed" | "failed";

/** The command that shows the token in the api log (docker compose installations). */
export const SETUP_TOKEN_LOG_COMMAND = "docker compose logs api | grep 'SETUP TOKEN'";

interface TokenStepProps {
  value: string;
  onChange: (value: string) => void;
  /** Where the operator finds the token: the api log, or RESTOW_SETUP_TOKEN. */
  source: "log" | "environment" | null;
  /** The token is being checked. */
  checking: boolean;
  error: TokenStepError | null;
}

/**
 * First wizard step: the one-time setup token (apps/api lib/setup-token.ts).
 * Only someone who can read the server's log (or its environment) has it, so
 * whoever merely reaches the address of a fresh installation cannot set it
 * up. Continuing checks the token on the server; the setup request sends it
 * again.
 */
export function TokenStep({ value, onChange, source, checking, error }: TokenStepProps) {
  const { t } = useTranslation("setup");

  return (
    <div className="space-y-4">
      {source === "environment" ? (
        <p className="text-sm text-muted-foreground">{t("token.whereEnvironment")}</p>
      ) : (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{t("token.whereLog")}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {SETUP_TOKEN_LOG_COMMAND}
          </pre>
          <p>{t("token.restart")}</p>
        </div>
      )}
      <Field
        id="setup-token"
        label={t("token.label")}
        error={error ? t(`token.error.${error}`) : undefined}
        hint={t("token.hint")}
      >
        <Input
          id="setup-token"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          disabled={checking}
          placeholder={t("token.placeholder")}
          className="font-mono tracking-wider"
          aria-invalid={error !== null}
          aria-describedby={messageId("setup-token")}
        />
      </Field>
    </div>
  );
}
