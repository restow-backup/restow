import { Link } from "@tanstack/react-router";
import { EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useShellEntry } from "@/components/layout/shell-entry";
import { installationSectionTo, MODULES_SECTION_ID } from "@/features/installation/paths";
import { hiddenModulesOf, type ModuleId, moduleTitleKey } from "@/lib/modules";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * One discreet line on a page whose module is off (lib/modules.ts): the page was opened by its
 * address, its menu entry is hidden, and nothing else about it changed. It names the module and,
 * for a provider administrator, leads to Installation > Modules. Nothing while one of the
 * page's modules is on, or the page belongs to none.
 */
export function ModuleHiddenHint({
  modules,
  className,
}: {
  modules: readonly ModuleId[] | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const hidden = hiddenModulesOf(modules, session.modules);
  if (hidden.length === 0) {
    return null;
  }
  const names = hidden.map((id) => t(moduleTitleKey(id))).join(", ");
  return (
    <p
      className={cn("flex items-start gap-2 text-xs text-muted-foreground", className)}
      data-slot="module-hidden-hint"
      data-modules={hidden.join(" ")}
    >
      <EyeOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {t("modules.hidden.hint", { count: hidden.length, names })}{" "}
        {session.isProviderAdmin ? (
          <Link
            to={installationSectionTo(MODULES_SECTION_ID)}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t("modules.hidden.manage")}
          </Link>
        ) : null}
      </span>
    </p>
  );
}

/**
 * The hint for the page the shell shows, from the menu entry the location belongs to: the page
 * of a module that is off was opened by its address (its entry is not in the sidebar). Decided
 * here for every page at once, not page by page; the page itself works as always.
 */
export function ShellModuleHint() {
  const entry = useShellEntry();
  return <ModuleHiddenHint modules={entry?.item.modules} className="mb-4" />;
}
