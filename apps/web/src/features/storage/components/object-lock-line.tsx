import { useTranslation } from "react-i18next";

import { defaultRetention, objectLockSummary } from "../presenters";
import type { ObjectLockCapability, StorageKind } from "../types";
import { ToneLine } from "./status";

/**
 * Whether a target can hold WORM archive data. Said plainly for a mounted
 * filesystem: there is no hardware WORM, whatever the path points at.
 */
export function ObjectLockLine({
  kind,
  capability,
}: {
  kind: StorageKind;
  capability: ObjectLockCapability | null;
}) {
  const { t } = useTranslation("storage");
  const summary = objectLockSummary(kind, capability);
  const retention = defaultRetention(capability);
  const mode = capability?.status === "enabled" ? capability.mode : null;

  return (
    <ToneLine tone={summary.tone}>
      <span className="font-medium">{t(summary.key, summary.values)}</span>
      {mode || retention ? (
        <span className="text-muted-foreground">
          {" "}
          {t("objectLock.defaults", {
            mode: mode ? t(`objectLock.modes.${mode}`) : t("objectLock.noMode"),
            retention: retention
              ? t(`objectLock.retention.${retention.unit}`, { count: retention.count })
              : t("objectLock.noRetention"),
          })}
        </span>
      ) : null}
      <p className="mt-0.5 text-xs text-muted-foreground">{t(`${summary.key}Hint`)}</p>
    </ToneLine>
  );
}
