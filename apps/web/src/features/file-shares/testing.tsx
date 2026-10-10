import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { vi } from "vitest";

import {
  type Mounted,
  type RecordedRequest,
  flush,
  mount,
  newQueryClient,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import type { SessionContextValue, SessionTenant } from "@/lib/session";

/**
 * A harness for the file share tests (not part of the app bundle: nothing imports this file
 * outside `*.test.*`): one component on a page of a memory router (so links resolve), a
 * session of a tenant administrator and a fetch that answers by `METHOD /path` and records
 * what was asked.
 */

export const TENANT: SessionTenant = {
  id: "tenant-1",
  name: "Müller GmbH",
  slug: "mueller",
  kind: "customer",
  customerNumber: null,
  role: "tenant_admin",
  status: "active",
};

export function tenantAdmin(over: Partial<SessionContextValue> = {}): SessionContextValue {
  return sessionAs({
    role: "tenant_admin",
    isProviderAdmin: false,
    providerRole: null,
    activeTenant: TENANT,
    tenants: [TENANT],
    ...over,
  });
}

export function providerOwner(over: Partial<SessionContextValue> = {}): SessionContextValue {
  return sessionAs({
    role: "provider_admin",
    isProviderAdmin: true,
    providerRole: "owner",
    providerAllTenants: true,
    activeTenant: TENANT,
    tenants: [TENANT],
    ...over,
  });
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export interface Rendered {
  mounted: Mounted;
  requests: RecordedRequest[];
  where: () => { pathname: string; search: Record<string, unknown> };
}

/** `node` on the page `/here` of a memory router, mounted into the document. */
export async function render(
  node: ReactNode,
  options: { routes?: Record<string, Handler>; session?: SessionContextValue } = {},
): Promise<Rendered> {
  const { mock, requests } = routedFetch(options.routes ?? {});
  vi.stubGlobal("fetch", mock);
  const root = createRootRoute();
  const page = createRoute({ getParentRoute: () => root, path: "/here", component: () => node });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([
      page,
      stub("/file-shares"),
      stub("/file-shares/$shareId"),
      stub("/jobs"),
      stub("/jobs/definitions/$jobId"),
      stub("/installation/mounts"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/here"] }),
  });
  await router.load();
  const mounted = mount(<RouterProvider router={router} />, {
    session: options.session ?? tenantAdmin(),
    queryClient: newQueryClient(),
  });
  await flush(5);
  return {
    mounted,
    requests,
    where: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search as Record<string, unknown>,
    }),
  };
}

export const slot = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);
export const action = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(`[data-action="${name}"]`);
export const text = () => document.body.textContent ?? "";
