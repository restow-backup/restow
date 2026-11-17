import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { vi } from "vitest";

import {
  flush,
  type Mounted,
  mount,
  newQueryClient,
  type RecordedRequest,
  routedFetch,
  sessionAs,
} from "@/features/updates/testing";
import type { SessionContextValue, SessionTenant } from "@/lib/session";

import type { DbConnection, DbDatabase, DbProbe } from "./api.js";

/**
 * A harness for the database tests (imported only by `*.test.*`): one component on a page of a
 * memory router, a session and a fetch that answers by `METHOD /path` and records what was asked.
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

export function sessionWithRole(role: "tenant_admin" | "tenant_restore"): SessionContextValue {
  return sessionAs({
    role,
    isProviderAdmin: false,
    providerRole: null,
    activeTenant: { ...TENANT, role },
    tenants: [{ ...TENANT, role }],
  });
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export interface Rendered {
  mounted: Mounted;
  requests: RecordedRequest[];
  where: () => { pathname: string };
}

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
      stub("/databases"),
      stub("/databases/$databaseId"),
      stub("/databases/connections/$connectionId"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/here"] }),
  });
  await router.load();
  const mounted = mount(<RouterProvider router={router} />, {
    session: options.session ?? sessionWithRole("tenant_admin"),
    queryClient: newQueryClient(),
  });
  await flush(5);
  return { mounted, requests, where: () => ({ pathname: router.state.location.pathname }) };
}

export const slot = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);
export const action = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLElement>(`[data-action="${name}"]`);
export const text = () => document.body.textContent ?? "";

export const FINGERPRINT =
  "3A:91:5C:0E:7B:22:D4:18:F6:60:A9:4B:CE:13:57:9D:02:EE:71:B8:46:3F:A0:5D:C9:12:8E:64:BB:07:F3:2C";

export function probeFixture(over: Partial<DbProbe> = {}): DbProbe {
  return {
    id: "probe-1",
    status: "done",
    executor: { kind: "server", endpointId: null },
    address: "db.example.com",
    engine: "postgresql",
    serverVersion: "16.4",
    port: 5432,
    tls: {
      offered: true,
      used: true,
      fingerprintSha256: FINGERPRINT,
      subject: "CN=db.example.com",
      issuer: "CN=Example CA",
      notAfter: "2027-11-17T00:00:00.000Z",
    },
    login: "ok",
    error: null,
    rights: {
      engine: "postgresql",
      admin: false,
      capabilities: {
        backup: { state: "granted", missing: [], note: null },
        verifyOnInstance: { state: "missing", missing: ["CREATEDB"], note: null },
        pitr: { state: "missing", missing: ["REPLICATION"], note: null },
      },
      grantSql:
        "CREATE ROLE restow_backup LOGIN PASSWORD '<password>';\nGRANT pg_read_all_data TO restow_backup;\nALTER ROLE restow_backup CREATEDB;",
      adminExtras: [],
    },
    databases: [
      { name: "erp", sizeBytes: 734003200, accessible: true },
      { name: "shop", sizeBytes: 4096, accessible: true },
    ],
    identityKnown: true,
    createdAt: "2026-11-17T10:00:00.000Z",
    finishedAt: "2026-11-17T10:00:01.000Z",
    expiresAt: "2026-11-18T10:00:00.000Z",
    ...over,
  };
}

export function connectionFixture(over: Partial<DbConnection> = {}): DbConnection {
  return {
    id: "conn-1",
    name: "ERP",
    engine: "postgresql",
    address: "db.example.com:5432",
    host: "db.example.com",
    port: 5432,
    path: null,
    executor: { kind: "server", endpointId: null, hostname: null, online: null, lastSeenAt: null },
    authMethod: "password",
    credential: "set",
    allowUnencrypted: false,
    tls: {
      fingerprint: FINGERPRINT,
      subject: "CN=db.example.com",
      issuer: "CN=Example CA",
      notAfter: "2027-11-17T00:00:00.000Z",
      confirmedAt: "2026-11-17T10:00:02.000Z",
      confirmedBy: "admin@mueller.example",
    },
    privateNetworkApproval: null,
    mode: "backup",
    schedule: { kind: "interval", intervalMinutes: 60, timeZone: "Europe/Berlin" },
    selection: { mode: "all", names: [], exclude: [] },
    identityKnown: true,
    serverVersion: "16.4",
    lastCheck: null,
    state: "ok",
    notices: [],
    enabled: true,
    databaseCount: 2,
    createdAt: "2026-11-17T10:00:02.000Z",
    updatedAt: "2026-11-17T10:00:02.000Z",
    ...over,
  };
}

export function databaseFixture(over: Partial<DbDatabase> = {}): DbDatabase {
  return {
    id: "db-1",
    name: "erp",
    connectionId: "conn-1",
    connectionName: "ERP",
    engine: "postgresql",
    mode: "backup",
    sizeBytes: 734003200,
    identityByName: false,
    accessible: true,
    excluded: false,
    droppedAt: null,
    lastBackupAt: null,
    lastCheckAt: null,
    reachable: true,
    rating: "not_protected",
    firstSeenAt: "2026-11-17T10:00:02.000Z",
    ...over,
  };
}
