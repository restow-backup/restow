import { useTranslation } from "react-i18next";

import { usePageWidth } from "@/components/kit";
import { PageHeader } from "@/components/page-header";
import { SecuritySection } from "./sections/security-section";

/**
 * The signed-in person's own sign-in security, for every role: passkeys, the
 * authenticator app that protects the emergency password, other sessions.
 */
export function AccountSecurityPage() {
  const { t } = useTranslation("settings");
  usePageWidth("readable");
  return (
    <div className="space-y-6">
      <PageHeader title={t("account.title")} description={t("account.description")} />
      <SecuritySection />
    </div>
  );
}
