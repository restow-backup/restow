import type { QueryClient } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createElement } from "react";

import { type Mounted, SESSION, mount, newQueryClient } from "@/features/updates/testing";
import { queryKeys } from "@/lib/api";
import type { SessionContextValue, SessionTenant } from "@/lib/session";

import { TenantPage } from "./tenant-page";

/**
 * Fixtures and a harness for the tenant page tests (not part of the app bundle:
 * nothing imports this file outside `*.test.*`): the page mounted on
 * `/tenants/$tenantId/$section` in a memory router, with a session that lists
 * tenants and records which one the page made active.
 */

export function tenantOf(id: string, over: Partial<SessionTenant> = {}): SessionTenant {
  return {
    id,
    name: `Tenant ${id}`,
    slug: id,
    kind: "customer",
    customerNumber: null,
    role: "tenant_admin",
    status: "active",
    ...over,
  };
}

export interface OpenOptions {
  session?: SessionContextValue;
  queryClient?: QueryClient;
  /** Public demo mode (the setup state says so). */
  demo?: boolean;
}

/** The tenant page at `path`, inside a memory router, mounted into the document. */
export async function openTenantPage(path: string, options: OpenOptions = {}): Promise<Mounted> {
  const root = createRootRoute();
  const section = createRoute({
    getParentRoute: () => root,
    path: "/tenants/$tenantId/$section",
    component: function Section() {
      const { tenantId, section: id } = section.useParams();
      return createElement(TenantPage, { tenantId, section: id });
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([section]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const queryClient = options.queryClient ?? newQueryClient();
  queryClient.setQueryData(queryKeys.setupState, {
    configured: true,
    demo: { enabled: options.demo === true, email: null, password: null },
  });
  return mount(<RouterProvider router={router} />, {
    session: options.session ?? SESSION,
    queryClient,
  });
}

/** One section component on `/tenants/<id>/<section>`, without the page around it. */
export async function openSection(
  Section: (props: import("@/lib/extensions").TenantSectionProps) => import("react").ReactNode,
  path: string,
  options: OpenOptions & { readOnly?: boolean; sub?: string | null; tenant?: SessionTenant } = {},
): Promise<Mounted> {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/tenants/$tenantId/$section",
    component: function Wrapped() {
      const { tenantId } = route.useParams();
      return createElement(Section, {
        tenant: options.tenant ?? tenantOf(tenantId),
        readOnly: options.readOnly ?? false,
        sub: options.sub ?? null,
      });
    },
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const queryClient = options.queryClient ?? newQueryClient();
  queryClient.setQueryData(queryKeys.setupState, {
    configured: true,
    demo: { enabled: options.demo === true, email: null, password: null },
    publicUrl: "https://restow.example.test",
  });
  return mount(<RouterProvider router={router} />, {
    session: options.session ?? SESSION,
    queryClient,
  });
}
