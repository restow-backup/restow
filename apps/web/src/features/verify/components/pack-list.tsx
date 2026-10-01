import type { PackCheck } from "@/features/verify/api";
import { targetLabel, targetStatusKey } from "@/features/verify/presenters";
import type { VerifyFormat } from "@/features/verify/use-verify";

/** How many packs are listed by path; the count is always complete. */
const LISTED_PACKS = 5;

/** Damaged or repaired pack files with what each storage target reported. */
export function PackList({
  packs,
  format,
  limit = LISTED_PACKS,
}: {
  packs: readonly PackCheck[];
  format: VerifyFormat;
  limit?: number;
}) {
  const { t } = format;
  return (
    <ul className="mt-2 space-y-1.5">
      {packs.slice(0, limit).map((pack) => (
        <li key={pack.path} className="text-xs">
          <code className="break-all font-mono">{pack.path}</code>
          <span className="block text-muted-foreground">
            {pack.targets
              .filter((target) => target.status !== "ok")
              .map((target) => {
                const label = targetLabel(target.target);
                const values = {
                  target: t(label.key, label.values),
                  status: t(targetStatusKey(target.status)),
                };
                return t(
                  target.repaired ? "storage.targetRepaired" : "storage.targetFailed",
                  values,
                );
              })
              .join(" · ")}
          </span>
        </li>
      ))}
      {packs.length > limit ? (
        <li className="text-xs text-muted-foreground">
          {t("storage.morePacks", { count: packs.length - limit })}
        </li>
      ) : null}
    </ul>
  );
}
