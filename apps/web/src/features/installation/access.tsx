import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { setupStateQueryOptions } from "@/lib/api";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

/**
 * What the signed-in provider admin may do on the installation pages. The API
 * refuses what the provider team role does not allow with a 403; the pages
 * show the same forms read-only, with a sentence on what is needed, instead
 * (clarity rule 5). The ranking mirrors apps/api lib/provider-access.ts:
 * changing installation settings is for the owner, actions that test or send
 * (a test mail, a probe of the storage) for an administrator and up.
 */

/** What a role has to reach to do something here. */
export type AccessLevel = "owner" | "administrator";

/** Why a form is closed: the public demo, or a provider role that is too low. */
export type AccessBlock = "demo" | "role";

export interface InstallationAccess {
  /** Why changing settings is closed; null when the viewer may change them. */
  change: AccessBlock | null;
  /** Why running tests is closed; null when the viewer may run them. */
  operate: AccessBlock | null;
}

/** Pure form of {@link useInstallationAccess}, for tests and for callers that already hold the facts. */
export function installationAccess(input: {
  demo: boolean;
  mayChange: boolean;
  mayOperate: boolean;
}): InstallationAccess {
  return {
    change: input.demo ? "demo" : input.mayChange ? null : "role",
    operate: input.demo ? "demo" : input.mayOperate ? null : "role",
  };
}

export function useInstallationAccess(): InstallationAccess {
  const session = useSession();
  const { data: setup } = useQuery(setupStateQueryOptions);
  return installationAccess({
    demo: setup?.demo.enabled === true,
    mayChange: providerMay(session, "owner"),
    mayOperate: providerMay(session, "administrator"),
  });
}

/** The block that applies to something that needs `level`. */
export function blockFor(access: InstallationAccess, level: AccessLevel): AccessBlock | null {
  return level === "owner" ? access.change : access.operate;
}

/**
 * Says why the controls below are closed, in one sentence, and nothing when
 * they are open. The role sentence names the provider role that is needed.
 */
export function AccessNote({
  block,
  level,
  className,
}: {
  block: AccessBlock | null;
  level: AccessLevel;
  className?: string;
}) {
  const { t } = useTranslation("installation");
  if (block === null) {
    return null;
  }
  return (
    <Alert variant="info" className={className} data-slot="access-note" data-reason={block}>
      <Info />
      <AlertDescription>
        {block === "demo" ? t("access.demo") : t(`access.${level}`)}
      </AlertDescription>
    </Alert>
  );
}

export { ReadOnlyGroup } from "@/components/kit/read-only-group";
