import { useTranslation } from "react-i18next";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import "../i18n";
import type { WarningRef } from "../api";
import { WarningDetailView } from "./warning-detail";

/**
 * The warning of one object or machine in a side sheet: opened from the warnings list, from the
 * backup column of the protected objects and from the start page, so that a warning badge always
 * leads to its reasons.
 */
export function WarningSheet({
  target,
  name,
  onOpenChange,
}: {
  /** The object or machine to explain; null closes the sheet. */
  target: WarningRef | null;
  name: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("warnings");
  return (
    <Sheet open={target !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl" data-slot="warning-sheet">
        <SheetHeader>
          <SheetTitle>{name ?? t("detail.title")}</SheetTitle>
          <SheetDescription>{t("detail.title")}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{target ? <WarningDetailView target={target} /> : null}</div>
      </SheetContent>
    </Sheet>
  );
}
