import { useTranslation } from "react-i18next";

import { SectionNav, type SectionNavItem } from "@/components/layout/section-nav";

import { useAvailableUpdate } from "@/features/updates/available";
import { UPDATES_SECTION } from "@/features/updates/settings-link";

import { installationSectionPath } from "./paths";
import type { SectionState } from "./presenters";

/**
 * The installation page's sub-navigation: the shared section navigation
 * (components/layout/section-nav.tsx) over the sections of the installation
 * page. A section an extension locked stays in the list, greyed out with a
 * lock, and leads where its lock says.
 */
export function InstallationSubNav({
  states,
  activeId,
}: {
  states: readonly SectionState[];
  activeId: string;
}) {
  const { t } = useTranslation();
  // A newer release puts a dot on "Updates" (provider administrators only, like this page).
  const update = useAvailableUpdate();
  const items = states.map(
    ({ spec, locked }): SectionNavItem => ({
      id: spec.id,
      label: t(spec.labelKey),
      icon: spec.icon,
      to: installationSectionPath(spec.id),
      updateLabel:
        spec.id === UPDATES_SECTION && update
          ? t("shell.updateTo", { version: update.latest })
          : undefined,
      locked:
        locked && spec.lock
          ? { to: spec.lock.to, search: spec.lock.search, hint: t(spec.lock.hintKey) }
          : undefined,
    }),
  );
  return (
    <SectionNav
      items={items}
      activeId={activeId}
      label={t("installation:sections.label")}
      selectLabel={t("installation:sections.select")}
      selectId="installation-section-select"
    />
  );
}
