import type { QueryClient } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { vi } from "vitest";

import {
  type Mounted,
  type RecordedRequest,
  json,
  mount,
  newQueryClient,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import { queryKeys } from "@/lib/api";
import type { SessionContextValue, SessionTenant } from "@/lib/session";

import { RunDrawerHost } from "./components/run-drawer";
import { HistoryRoute, RunDetailRoute } from "./route-pages";

/**
 * A harness for the tests of History, the run drawer and the run page (nothing imports this
 * file outside `*.test.*`): the real routes in a memory router, a session of a tenant
 * administrator and a fetch that answers by `METHOD /path` and records what was asked.
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

export function adminSession(over: Partial<SessionContextValue> = {}): SessionContextValue {
  return sessionAs({
    role: "tenant_admin",
    isProviderAdmin: false,
    providerRole: null,
    activeTenant: TENANT,
    tenants: [TENANT],
    ...over,
  });
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export interface OpenOptions {
  routes?: Record<string, Handler>;
  session?: SessionContextValue;
  queryClient?: QueryClient;
}

export interface Opened {
  mounted: Mounted;
  requests: RecordedRequest[];
  queryClient: QueryClient;
  where: () => { pathname: string; search: Record<string, unknown> };
  navigate: (to: string, search?: Record<string, unknown>) => Promise<void>;
}

/** The pages at `url` in a memory router, mounted into the document. */
export async function openHistory(url: string, options: OpenOptions = {}): Promise<Opened> {
  const { mock, requests } = routedFetch({
    "GET /setup/state": () =>
      json({ configured: true, demo: { enabled: false, email: null, password: null } }),
    // The job list the History filter offers.
    "GET /backup-jobs": () => json({ items: [], uncovered: { mail: 0, endpoint: 0 } }),
    ...options.routes,
  });
  vi.stubGlobal("fetch", mock);

  const root = createRootRoute();
  const passThrough = (search: Record<string, unknown>) => search;
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/history",
        validateSearch: passThrough,
        component: HistoryRoute,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/history/$runId",
        component: function Detail() {
          const { runId } = detailRoute.useParams();
          return <RunDetailRoute runId={runId} />;
        },
      }),
      // A page that only hosts the drawer: any page with `?run=` does the same.
      createRoute({
        getParentRoute: () => root,
        path: "/host",
        validateSearch: passThrough,
        component: RunDrawerHost,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/jobs",
        validateSearch: passThrough,
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/jobs/definitions/$jobId",
        validateSearch: passThrough,
        component: () => null,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/inventory/$endpointId",
        component: () => null,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const detailRoute = router.routesByPath["/history/$runId"];
  await router.load();
  const queryClient = options.queryClient ?? newQueryClient();
  queryClient.setQueryData(queryKeys.setupState, {
    configured: true,
    demo: { enabled: false, email: null, password: null },
  });
  const mounted = mount(<RouterProvider router={router} />, {
    session: options.session ?? adminSession(),
    queryClient,
  });
  return {
    mounted,
    requests,
    queryClient,
    where: () => ({
      pathname: router.state.location.pathname,
      search: router.state.location.search as Record<string, unknown>,
    }),
    navigate: async (to, search) => {
      await router.navigate({ to: to as never, search: search as never });
    },
  };
}
