import {
  Archive,
  BellRing,
  Boxes,
  Building2,
  CalendarClock,
  HardDrive,
  Hourglass,
  LayoutDashboard,
  type LucideIcon,
  Plug,
  Shield,
  Users,
  Webhook,
} from "lucide-react";

import type { TenantSectionId } from "@/lib/tenant-paths";

/**
 * The core's sections of the tenant page without their components, so that
 * the command palette and the redirects can name them without importing the
 * pages behind them. The order is the sub-navigation's; the sections the
 * extensions add (the audit log) take the places between
 * (features/tenant-page/sections.tsx):
 *
 *   10 Overview   20 Connections   30 Protection   40 Jobs & schedules
 *   50 Backup retention   60 Storage   70 Agents   80 Archive
 *   90 Notifications   100 Integrations   110 Members   120 Audit log (extension)
 *   130 Master data
 */

export interface TenantSectionMeta {
  readonly id: TenantSectionId;
  /** i18n key with namespace of the label (sub-navigation, title, palette). */
  readonly labelKey: string;
  /** i18n key with namespace of the one-line description under the title. */
  readonly descriptionKey: string;
  readonly icon: LucideIcon;
  readonly order: number;
}

export const TENANT_SECTION_META: readonly TenantSectionMeta[] = [
  {
    id: "overview",
    labelKey: "tenantpage:sections.overview",
    descriptionKey: "tenantpage:descriptions.overview",
    icon: LayoutDashboard,
    order: 10,
  },
  {
    id: "connections",
    labelKey: "tenantpage:sections.connections",
    descriptionKey: "tenantpage:descriptions.connections",
    icon: Plug,
    order: 20,
  },
  {
    id: "protection",
    labelKey: "tenantpage:sections.protection",
    descriptionKey: "tenantpage:descriptions.protection",
    icon: Shield,
    order: 30,
  },
  {
    id: "jobs",
    labelKey: "tenantpage:sections.jobs",
    descriptionKey: "tenantpage:descriptions.jobs",
    icon: CalendarClock,
    order: 40,
  },
  {
    id: "retention",
    labelKey: "tenantpage:sections.retention",
    descriptionKey: "tenantpage:descriptions.retention",
    icon: Hourglass,
    order: 50,
  },
  {
    id: "storage",
    labelKey: "tenantpage:sections.storage",
    descriptionKey: "tenantpage:descriptions.storage",
    icon: HardDrive,
    order: 60,
  },
  {
    id: "agents",
    labelKey: "tenantpage:sections.agents",
    descriptionKey: "tenantpage:descriptions.agents",
    icon: Boxes,
    order: 70,
  },
  {
    id: "archive",
    labelKey: "tenantpage:sections.archive",
    descriptionKey: "tenantpage:descriptions.archive",
    icon: Archive,
    order: 80,
  },
  {
    id: "notifications",
    labelKey: "tenantpage:sections.notifications",
    descriptionKey: "tenantpage:descriptions.notifications",
    icon: BellRing,
    order: 90,
  },
  {
    id: "integrations",
    labelKey: "tenantpage:sections.integrations",
    descriptionKey: "tenantpage:descriptions.integrations",
    icon: Webhook,
    order: 100,
  },
  {
    id: "members",
    labelKey: "tenantpage:sections.members",
    descriptionKey: "tenantpage:descriptions.members",
    icon: Users,
    order: 110,
  },
  {
    id: "master-data",
    labelKey: "tenantpage:sections.masterData",
    descriptionKey: "tenantpage:descriptions.masterData",
    icon: Building2,
    order: 130,
  },
];

export function sectionMeta(id: string): TenantSectionMeta | undefined {
  return TENANT_SECTION_META.find((meta) => meta.id === id);
}
