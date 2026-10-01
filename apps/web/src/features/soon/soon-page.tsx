import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/kit";
import { SoonBadge } from "@/components/layout/soon-badge";
import { RequireRole } from "@/components/require-role";
import type { NavItem } from "@/lib/navigation";

import { SOON_CONTENT } from "./items";

/**
 * The page behind a "Soon" menu entry: what the feature will do, the release
 * that brings it and the way to the public roadmap. In the normal layout,
 * with the entry's breadcrumbs and icon; nothing on it pretends to work.
 */
export function SoonPage({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  const content = SOON_CONTENT[item.id] ?? item.id;
  const titleId = `soon-${item.id}-release`;

  return (
    <RequireRole roles={item.roles}>
      <div className="space-y-6" data-slot="soon-page">
        <PageHeader title={t(item.labelKey)} description={t(`soon.${content}.description`)} />
        <section
          aria-labelledby={titleId}
          className="max-w-prose space-y-3 rounded-lg border border-dashed border-border p-5"
        >
          <h2 id={titleId} className="flex flex-wrap items-center gap-2 text-base font-medium">
            <SoonBadge />
            {t("nav.soon.release", { version: item.soon ?? "" })}
          </h2>
          <p className="text-sm text-muted-foreground">{t("nav.soon.notYet")}</p>
          <a
            href={t("nav.soon.roadmapUrl")}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {t("nav.soon.roadmap")}
            <ExternalLink aria-hidden="true" className="size-3.5" />
            <span className="sr-only">{t("nav.soon.newTab")}</span>
          </a>
        </section>
      </div>
    </RequireRole>
  );
}
