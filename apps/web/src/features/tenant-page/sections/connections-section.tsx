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
import { type ModuleId, withShownModules } from "@/lib/modules";
import { useSession } from "@/lib/session";
import { CONNECTION_TABS, type ConnectionTab, tenantPageTo } from "@/lib/tenant-paths";

import { cn } from "@/lib/utils";
import { parseConnectionsSearch, SUB_PAGES } from "../presenters";

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
  const { tab: asked } = parseConnectionsSearch(raw);
  // Whether the address itself names a tab (the first one is the default and stays out of it).
  const named = (CONNECTION_TABS as readonly unknown[]).includes(raw.tab) ? raw.tab : null;
  const { modules } = useSession();
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

  // The kinds of connection on offer follow the installation's modules (lib/modules.ts): the tab
  // of a module that is off is left out, unless the address opened it.
  const allTabs: {
    id: ConnectionTab;
    label: string;
    badge?: React.ReactNode;
    modules: readonly ModuleId[];
  }[] = [
    {
      id: "microsoft365",
      label: t("connections.tabs.microsoft365"),
      modules: ["microsoft365"],
    },
    { id: "imap", label: t("connections.tabs.imap"), modules: ["imap"] },
    {
      id: "google",
      label: t("connections.tabs.google"),
      // Until it has a connection of its own its mailboxes come in through IMAP.
      modules: ["imap"],
      badge: (
        <>
          <SoonBadge className="ml-0.5" />
          <SoonSuffix />
        </>
      ),
    },
    {
      id: "imports",
      label: t("connections.tabs.imports"),
      modules: ["microsoft365", "imap", "archive"],
    },
  ];
  const offered = withShownModules(allTabs, modules);
  // Without a tab in the address the first one on offer opens; a tab the address names opens
  // whatever its module, and is then listed too.
  const tab = named !== null || offered.length === 0 ? asked : (offered[0]?.id ?? asked);
  const tabs = allTabs.filter((entry) => entry.id === tab || offered.includes(entry));

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
          // The first tab on offer is the default and stays out of the address.
          search: entry.id === offered[0]?.id ? {} : { tab: entry.id },
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
