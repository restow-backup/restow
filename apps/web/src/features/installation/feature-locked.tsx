import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";
import type { GatedFeature } from "@/lib/api";
import { ExtensionSlot } from "@/lib/extensions";

import { EditionLink } from "./edition-link";
import "./i18n";

/**
 * Says that a part of a page is closed because the installation does not enable `feature`
 * (slot `feature.locked`, 0.5.0). The full build names the edition that unlocks it and leads to
 * the license page; the core itself says only that this build does not offer it and, to whom
 * may open it, where the editions are explained. The core never names an edition.
 */
export function FeatureLocked({ feature }: { feature: GatedFeature }) {
  const { t } = useTranslation("installation");
  return (
    <ExtensionSlot
      name="feature.locked"
      props={{ feature }}
      fallback={
        <span
          className="flex flex-wrap items-center gap-2"
          data-slot="feature-locked"
          data-feature={feature}
        >
          <StatusBadge tone="muted" icon={Lock}>
            {t("featureLocked")}
          </StatusBadge>
          <EditionLink />
        </span>
      }
    />
  );
}
