import { useTranslation } from "react-i18next";

import { DefaultStorageSection } from "./default-storage-section";
import { MountsSection } from "./mounts-section";

/**
 * Installation, Default repository & network shares: where data is kept for
 * every tenant without a repository of its own, and the NFS shares mounted
 * into the server that a repository can point at (maintainer decision
 * 2026-10-11: one section, side by side on a wide screen, one below the other
 * on a narrow one). The old address of the shares (`/installation/mounts`)
 * leads here (installation-page.tsx).
 */
export function RepositorySection() {
  const { t } = useTranslation("installation");
  return (
    <div className="grid items-start gap-8 2xl:grid-cols-2" data-slot="repository-section">
      <section aria-labelledby="installation-default-storage" className="min-w-0 space-y-4">
        <h2 id="installation-default-storage" className="text-base font-semibold">
          {t("sections.defaultStorage")}
        </h2>
        <DefaultStorageSection />
      </section>
      <section aria-labelledby="installation-mounts" className="min-w-0 space-y-4">
        {/* The shares' own introduction says what they are for. */}
        <h2 id="installation-mounts" className="text-base font-semibold">
          {t("sections.mounts")}
        </h2>
        <MountsSection />
      </section>
    </div>
  );
}
