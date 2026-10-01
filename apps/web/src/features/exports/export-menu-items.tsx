import { FileDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

/**
 * The export entries of the restore explorer's "entire restore point" menu:
 * the folder being browsed (only while inside one) and everything. `onExport`
 * receives whether the export is limited to the current folder.
 */
export function ExportMenuItems({
  inFolder,
  onExport,
}: {
  /** The explorer is inside a folder, so that folder can be exported on its own. */
  inFolder: boolean;
  onExport: (folderOnly: boolean) => void;
}) {
  const { t } = useTranslation("exports");
  return (
    <>
      <DropdownMenuSeparator />
      {inFolder ? (
        <DropdownMenuItem onSelect={() => onExport(true)}>
          <FileDown />
          {t("action.exportFolder")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => onExport(false)}>
        <FileDown />
        {t("action.exportEverything")}
      </DropdownMenuItem>
    </>
  );
}
