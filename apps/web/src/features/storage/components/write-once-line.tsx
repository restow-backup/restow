import { useTranslation } from "react-i18next";

import type { WriteOnceFinding } from "../types";
import { ToneLine } from "./status";

/**
 * What the last test found about overwriting and deleting (docs/STORAGE.md, "Write-once
 * storage"). Only a write-once finding is shown: it changes what Restow does on the repository,
 * and the card says what (no retention, repositories grow, lock files stay, restores and checks
 * work). Warning tone, never green: nothing is wrong with the backups, but space never comes back.
 */
export function WriteOnceLine({ finding }: { finding: WriteOnceFinding | null | undefined }) {
  const { t } = useTranslation("storage");
  if (!finding?.writeOnce) {
    return null;
  }
  const refused = finding.refused.includes("overwrite")
    ? finding.refused.includes("delete")
      ? "both"
      : "overwrite"
    : "delete";
  return (
    <ToneLine tone="warning">
      <span className="font-medium">{t("writeOnce.title")}</span>{" "}
      <span className="text-muted-foreground">
        {t(`writeOnce.refused.${refused}`, { code: finding.code ?? "" })}
      </span>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
        <li>{t("writeOnce.noRetention")}</li>
        <li>{t("writeOnce.grows")}</li>
        <li>{t("writeOnce.locks")}</li>
        <li>{t("writeOnce.newChain")}</li>
        <li>{t("writeOnce.works")}</li>
      </ul>
    </ToneLine>
  );
}
