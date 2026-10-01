import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";

import { useEdition } from "../edition";

/** The edition in effect, in the sidebar footer (slot `shell.sidebarFooter`). */
export function EditionBadge() {
  const { t } = useTranslation("license");
  const edition = useEdition();
  if (!edition) {
    return null;
  }
  return (
    <Badge variant="outline" title={t("edition.label")}>
      {t(`edition.${edition}`)}
    </Badge>
  );
}
