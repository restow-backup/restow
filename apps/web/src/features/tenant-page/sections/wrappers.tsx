import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { TenantJobsCard } from "@/features/backup-jobs/components/tenant-jobs-card";
import { DirectoryPage } from "@/features/directory/directory-page";
import { IntegrationsPage } from "@/features/integrations/integrations-page";
import { WebhookDetailPage } from "@/features/integrations/webhooks/webhook-detail-page";
import { BackupPage } from "@/features/jobs/pages/backup-page";
import { RetentionPage } from "@/features/retention/retention-page";
import { SchedulesPage } from "@/features/schedules/schedules-page";
import { StoragePage } from "@/features/storage/storage-page";
import { MembersPanel } from "@/features/tenants/components/members-panel";
import type { TenantSectionProps } from "@/lib/extensions";
import { useSession } from "@/lib/session";
import { tenantPageTo } from "@/lib/tenant-paths";

import { SUB_PAGES } from "../presenters";

/**
 * The sections that are an existing page of the product, shown inside the tenant
 * page as they are: the page's own heading becomes the section heading (a
 * page inside `EmbeddedPage` does not claim the title), and everything it does
 * stays where it was. The tenant page makes the tenant the active one before
 * any of them renders, so each keeps reading "the active tenant".
 */

const BACK_LINK =
  "inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/** A link from a page below a section back to the section. */
export function BackToSection({
  tenantId,
  section,
  search,
  label,
}: {
  tenantId: string;
  section: string;
  search?: Record<string, string>;
  label: string;
}) {
  return (
    <Link to={tenantPageTo(tenantId, section)} search={search as never} className={BACK_LINK}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      {label}
    </Link>
  );
}

/** Protected objects, rules and directory sync; "Back up now" per object below it. */
export function ProtectionSection({ tenant, sub }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  if (sub === SUB_PAGES.backup) {
    return (
      <div className="space-y-6">
        <BackToSection
          tenantId={tenant.id}
          section="protection"
          label={t("protection.backToObjects")}
        />
        <BackupPage />
      </div>
    );
  }
  return <DirectoryPage />;
}

/**
 * The tenant's backup jobs (a compact list with the way into each one and into the
 * editor) and, below them, the schedules that are left: maintenance (retention
 * runs, integrity checks, directory sync). Backups and restore checks are backup jobs
 * since 0.2.0 and no longer schedules.
 */
export function JobsSection() {
  return (
    <div className="space-y-10">
      <TenantJobsCard />
      <SchedulesPage />
    </div>
  );
}

export function RetentionSection() {
  return <RetentionPage />;
}

export function StorageSection() {
  return <StoragePage />;
}

/** API keys and webhooks of the tenant; one webhook below them. */
export function IntegrationsSection({ tenant, sub }: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  const { webhookId } = useParams({ strict: false }) as { webhookId?: string };
  if (sub === SUB_PAGES.webhook && webhookId) {
    return (
      <div className="space-y-6">
        <BackToSection
          tenantId={tenant.id}
          section="integrations"
          search={{ tab: "webhooks" }}
          label={t("integrations.backToList")}
        />
        <WebhookDetailPage key={webhookId} webhookId={webhookId} />
      </div>
    );
  }
  return <IntegrationsPage />;
}

/** Who can sign in to the tenant and with which role, and the open invitations. */
export function MembersSection({ tenant }: TenantSectionProps) {
  const { isProviderAdmin } = useSession();
  return (
    // Keyed by tenant so switching tenants never shows the previous list.
    <MembersPanel
      key={tenant.id}
      tenantId={tenant.id}
      tenantName={tenant.name}
      showProviderNote={isProviderAdmin}
    />
  );
}
