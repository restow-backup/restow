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
  // Narrow: default, its test, then the shares, one below the other. Wide: the
  // default on the left over both rows, the shares and under them the test on
  // the right, so both columns end about level and the page fits a 1080p screen.
  return (
    <div
      className="grid items-start gap-6 2xl:grid-cols-2 2xl:grid-rows-[auto_1fr] 2xl:gap-x-8"
      data-slot="repository-section"
    >
      <section
        aria-labelledby="installation-default-storage"
        className="min-w-0 space-y-4 2xl:row-span-2"
      >
        <h2 id="installation-default-storage" className="text-base font-semibold">
          {t("sections.defaultStorage")}
        </h2>
        <DefaultStorageSection parts="main" />
      </section>
      <div className="min-w-0 empty:hidden 2xl:col-start-2 2xl:row-start-2">
        <DefaultStorageSection parts="test" />
      </div>
      <section
        aria-labelledby="installation-mounts"
        className="min-w-0 space-y-4 2xl:col-start-2 2xl:row-start-1"
      >
        {/* The shares' own introduction says what they are for. */}
        <h2 id="installation-mounts" className="text-base font-semibold">
          {t("sections.mounts")}
        </h2>
        <MountsSection />
      </section>
    </div>
  );
}
