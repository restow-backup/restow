import { Link, useRouter } from "@tanstack/react-router";
import { Layers } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import "./i18n";
import { installationSectionTo } from "./paths";

/** Id of the Community build's Edition section (sections.tsx `EDITION_SECTION`). */
export const EDITION_SECTION_ID = "edition";

/**
 * Whether the viewer may open Installation › Edition: a provider admin whose
 * role covers every tenant (the installation page's own rule).
 */
export function useMayOpenEdition(): boolean {
  return providerMay(useSession(), "read_only", { everyTenant: true });
}

/**
 * A link to Installation › Edition: through the router where there is one,
 * a plain link elsewhere (a component rendered on its own, in a test).
 */
function EditionAnchor({
  className,
  label,
  children,
  slot,
}: {
  className?: string;
  label?: string;
  children: React.ReactNode;
  slot: string;
}) {
  const router = useRouter({ warn: false });
  const to = installationSectionTo(EDITION_SECTION_ID);
  return router ? (
    <Link to={to} className={className} aria-label={label} data-slot={slot}>
      {children}
    </Link>
  ) : (
    <a href={String(to)} className={className} aria-label={label} data-slot={slot}>
      {children}
    </a>
  );
}

/**
 * A link to Installation › Edition, for the Community build's own notes on
 * what the full build adds (the core's fallbacks of slots the full build
 * fills itself). Nothing for a viewer who may not open the installation page.
 */
export function EditionLink({ className }: { className?: string }) {
  const { t } = useTranslation("installation");
  if (!useMayOpenEdition()) {
    return null;
  }
  return (
    <EditionAnchor
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0", className)}
      slot="edition-link"
    >
      <Layers />
      {t("editionLink")}
    </EditionAnchor>
  );
}

/**
 * "Community" in the sidebar footer (the core's fallback of the slot
 * `shell.sidebarFooter`, which the full build fills with its own edition
 * badge): which build runs, linked to Installation › Edition for whoever may
 * open it.
 */
export function CommunityEditionBadge() {
  const { t } = useTranslation("installation");
  const mayOpen = useMayOpenEdition();
  const badge = (
    <Badge variant="outline" title={t("editionBadgeTitle")} data-slot="community-edition-badge">
      {t("editionBadge")}
    </Badge>
  );
  return mayOpen ? (
    <EditionAnchor label={t("editionBadgeTitle")} slot="community-edition-link">
      {badge}
    </EditionAnchor>
  ) : (
    badge
  );
}
