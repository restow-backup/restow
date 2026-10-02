import { type TenantSectionSpec, extensionTenantSections } from "@/lib/extensions";

import { TENANT_SECTION_META } from "./meta";
import { AgentsSection } from "./sections/agents-section";
import { ArchiveSection } from "./sections/archive-section";
import { ConnectionsSection } from "./sections/connections-section";
import { MasterDataSection } from "./sections/master-data-section";
import { NotificationsSection } from "./sections/notifications-section";
import { OverviewSection } from "./sections/overview-section";
import {
  IntegrationsSection,
  JobsSection,
  MembersSection,
  ProtectionSection,
  RetentionSection,
  StorageSection,
} from "./sections/wrappers";

/**
 * The sections of the tenant page (`/tenants/<id>/<section>`), in the order of
 * its sub-navigation: the core's own (meta.ts has their names, icons and
 * order) joined with their components, and the ones the extensions add (the
 * audit log, Business and Service Provider) in the places between
 * (lib/extensions.tsx `TenantSectionSpec`).
 */

const COMPONENTS: Readonly<Record<string, TenantSectionSpec["component"]>> = {
  overview: OverviewSection,
  connections: ConnectionsSection,
  protection: ProtectionSection,
  jobs: JobsSection,
  retention: RetentionSection,
  storage: StorageSection,
  agents: AgentsSection,
  archive: ArchiveSection,
  notifications: NotificationsSection,
  integrations: IntegrationsSection,
  members: MembersSection,
  "master-data": MasterDataSection,
};

export const CORE_TENANT_SECTIONS: readonly TenantSectionSpec[] = TENANT_SECTION_META.map(
  (meta): TenantSectionSpec => ({
    id: meta.id,
    labelKey: meta.labelKey,
    descriptionKey: meta.descriptionKey,
    icon: meta.icon,
    order: meta.order,
    component: COMPONENTS[meta.id] as TenantSectionSpec["component"],
  }),
);

/** The core's sections and the ones the extensions add, in sub-navigation order; a core id cannot be replaced. */
export function tenantSections(): TenantSectionSpec[] {
  const taken = new Set(CORE_TENANT_SECTIONS.map((spec) => spec.id));
  const added = extensionTenantSections().filter((spec) => {
    if (taken.has(spec.id)) {
      return false;
    }
    taken.add(spec.id);
    return true;
  });
  return [...CORE_TENANT_SECTIONS, ...added].sort((a, b) => a.order - b.order);
}
