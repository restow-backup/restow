import { useQuery } from "@tanstack/react-query";
import { Mail, MailCheck, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CopyButton } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";
import { setupStateQueryOptions } from "@/routes/tree";

import { setPasswordLink } from "../paths";
import { mailOutcomeView } from "../presenters";
import type { MailOutcome, ProvisionResult } from "../types";

/**
 * The absolute address a provisioned person opens: the installation's public
 * URL when one is set (the admin may be on an internal address), else the
 * current origin — same rule as the tenant invitation link. `token` is empty
 * when no link was issued (the caller does not render this field then).
 */
export function useAbsoluteSetPasswordLink(token: string): string {
  const setup = useQuery(setupStateQueryOptions);
  const base = setup.data?.publicUrl ?? window.location.origin;
  return token ? setPasswordLink(base, token) : "";
}

const MAIL_OUTCOME_ICON: Record<MailOutcome, typeof Mail> = {
  sent: MailCheck,
  not_configured: Mail,
  failed: TriangleAlert,
};

interface SetPasswordLinkFieldProps {
  id: string;
  result: ProvisionResult;
  /** The absolute address to show and copy (see {@link useAbsoluteSetPasswordLink}). */
  link: string;
}

/**
 * A freshly (re)issued set-password link: whether it could also be emailed,
 * when it expires, and a read-only field with the kit's copy button. Shown
 * exactly once per token — the server itself never lets it be read back.
 * Pure (the link is a prop, not fetched here), so it renders without a query
 * client in tests; {@link ConnectedSetPasswordLinkField} is what callers use.
 */
export function SetPasswordLinkField({ id, result, link }: SetPasswordLinkFieldProps) {
  const { t, i18n } = useTranslation("accounts");
  const expires = result.linkExpiresAt ? formatDateTime(result.linkExpiresAt, i18n.language) : null;
  const mail = mailOutcomeView(result.mailOutcome);
  const MailIcon = MAIL_OUTCOME_ICON[result.mailOutcome];
  // The server only ever hands the raw token back here when it could not also
  // mail it (accounts/service.ts, revealSetPasswordToken): once delivery to
  // the account's own address succeeds, there is nothing left to show or
  // copy — the Alert above already says the link was sent.
  const canCopy = result.setPasswordToken !== null;

  return (
    <div className="space-y-3">
      <Alert variant={mail.variant}>
        <MailIcon />
        <AlertTitle>{t(mail.titleKey, { email: result.email })}</AlertTitle>
        <AlertDescription>
          {expires ? t("provision.expires", { date: expires }) : t("provision.expiresUnknown")}
        </AlertDescription>
      </Alert>
      {canCopy ? (
        <div className="space-y-1.5">
          <Label htmlFor={id}>{t("provision.linkLabel")}</Label>
          <div className="flex gap-2">
            <Input
              id={id}
              readOnly
              value={link}
              aria-label={t("provision.linkLabel")}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopyButton value={link} label={t("provision.copyLink")} variant="outline" />
          </div>
          <p className="text-xs text-muted-foreground">{t("provision.linkHint")}</p>
        </div>
      ) : null}
    </div>
  );
}

/** {@link SetPasswordLinkField}, wired to the real absolute link. */
export function ConnectedSetPasswordLinkField({
  id,
  result,
}: Omit<SetPasswordLinkFieldProps, "link">) {
  const link = useAbsoluteSetPasswordLink(result.setPasswordToken ?? "");
  return <SetPasswordLinkField id={id} result={result} link={link} />;
}
