import { ArchiveRestore, MailSearch } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageTabs } from "@/components/kit/page-tabs";

import { RECENT_RESTORES_SEARCH, RESTORE_PATHS, type RestoreTab } from "./navigation";

/**
 * The tabs of the restore explorer: Browse (restore points, the explorer
 * itself) and Recent restores (every restore and download the viewer may
 * see, `?tab=recent`). End users have both: their own restores are listed
 * in the second tab.
 */
export function RestoreTabs({ current }: { current: RestoreTab }) {
  const { t } = useTranslation("restore");
  return (
    <PageTabs
      className="shrink-0"
      label={t("tabs.label")}
      current={current}
      tabs={[
        {
          id: "browse",
          label: t("tabs.browse"),
          to: RESTORE_PATHS.explorer,
          search: {},
          icon: MailSearch,
        },
        {
          id: "recent",
          label: t("tabs.recent"),
          to: RESTORE_PATHS.explorer,
          search: RECENT_RESTORES_SEARCH,
          icon: ArchiveRestore,
        },
      ]}
    />
  );
}
