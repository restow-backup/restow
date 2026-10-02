import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Mail } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/kit";
import { PageTabs } from "@/components/kit/page-tabs";
import { SoonBadge, SoonSuffix } from "@/components/layout/soon-badge";
import { buttonVariants } from "@/components/ui/button";
import { ImportJobPage } from "@/features/imports/jobs/import-job-page";
import { ImportsPage } from "@/features/imports/jobs/imports-page";
import { ImportWizardPage } from "@/features/imports/wizard/import-wizard-page";
import { SourceDetailPage } from "@/features/sources/source-detail-page";
import { SourcesPage } from "@/features/sources/sources-page";
import type { TenantSectionProps } from "@/lib/extensions";
import { type ConnectionTab, tenantPageTo } from "@/lib/tenant-paths";

import { cn } from "@/lib/utils";
import { SUB_PAGES, parseConnectionsSearch } from "../presenters";

/**
 * Connections: what the tenant's data comes from. Tabs for Microsoft 365, IMAP,
 * Google Workspace (not available yet, with the way to Gmail meanwhile) and
 * the mail file imports; below them the page of one source and the pages of
 * the import wizard and of one import, which have an address of their own.
 * Microsoft 365 keeps today's behaviour: the installation's app and the
 * admin-consent link.
 */
export function ConnectionsSection({ tenant, sub }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const { tab } = parseConnectionsSearch(raw);
  const { importId } = useParams({ strict: false }) as { importId?: string };

  if (sub === SUB_PAGES.source) {
    return <SourceDetailPage />;
  }
  if (sub === SUB_PAGES.importWizard) {
    return <ImportWizardPage />;
  }
  if (sub === SUB_PAGES.importDetail && importId) {
    return <ImportJobPage key={importId} importId={importId} />;
  }

  const tabs: { id: ConnectionTab; label: string; badge?: React.ReactNode }[] = [
    { id: "microsoft365", label: t("connections.tabs.microsoft365") },
    { id: "imap", label: t("connections.tabs.imap") },
    {
      id: "google",
      label: t("connections.tabs.google"),
      badge: (
        <>
          <SoonBadge className="ml-0.5" />
          <SoonSuffix />
        </>
      ),
    },
    { id: "imports", label: t("connections.tabs.imports") },
  ];

  return (
    <div className="space-y-6">
      <PageTabs
        label={t("connections.tabsLabel")}
        current={tab}
        tabs={tabs.map((entry) => ({
          id: entry.id,
          label: entry.label,
          badge: entry.badge,
          to: tenantPageTo(tenant.id, "connections") as string,
          // The first tab is the default and stays out of the address.
          search: entry.id === "microsoft365" ? {} : { tab: entry.id },
        }))}
      />
      {tab === "microsoft365" ? <SourcesPage kind="m365" /> : null}
      {tab === "imap" ? <SourcesPage kind="imap" /> : null}
      {tab === "google" ? <GooglePane tenantId={tenant.id} /> : null}
      {tab === "imports" ? <ImportsPage /> : null}
    </div>
  );
}

/**
 * Google Workspace as a source comes after this release. Until then Gmail
 * mailboxes are backed up through IMAP; the pane says so and leads there.
 */
function GooglePane({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("tenantpage");
  return (
    <EmptyState
      icon={Mail}
      title={t("connections.google.title")}
      description={t("connections.google.description")}
      actions={
        <Link
          to={tenantPageTo(tenantId, "connections")}
          search={{ tab: "imap" } as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          {t("connections.google.action")}
        </Link>
      }
    />
  );
}
