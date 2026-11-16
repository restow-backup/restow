import { useTranslation } from "react-i18next";

import type { BaremetalMinimumSizes } from "../api.js";
import { useEndpointFormat } from "../hooks.js";

/**
 * What replacement hardware needs at least (docs/BAREMETAL.md 10.9, 14.6): each disk with its
 * size now and its minimum, each file system with what a restore writes into it and its minimum,
 * as the restore planner worked them out from the newest restore point's restore sizes.
 */
export function MinimumSizes({ sizes }: { sizes: BaremetalMinimumSizes }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  if (sizes.disks.length === 0 && sizes.filesystems.length === 0) {
    return null;
  }
  return (
    <section className="space-y-1" data-slot="baremetal-minimum-sizes">
      <h3 className="text-sm font-medium">{t("baremetal.minimum.title")}</h3>
      <p className="text-sm text-muted-foreground">{t("baremetal.minimum.hint")}</p>
      <ul className="space-y-0.5 text-sm">
        {sizes.disks.map((disk) => (
          <li key={disk.disk} data-slot="minimum-disk">
            {t("baremetal.minimum.disk", {
              disk: disk.kname,
              size: format.bytes(disk.sizeBytes),
              min: format.bytes(disk.minBytes),
            })}
          </li>
        ))}
      </ul>
      {sizes.filesystems.length > 0 ? (
        <ul className="space-y-0.5 text-sm">
          {sizes.filesystems.map((fs) => (
            <li key={fs.fs} data-slot="minimum-filesystem">
              {t("baremetal.minimum.filesystem", {
                mount: fs.mount ?? fs.fs,
                restore: format.bytes(fs.restoreBytes),
                min: format.bytes(fs.minBytes),
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
