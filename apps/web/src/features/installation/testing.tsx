import type { QueryClient } from "@tanstack/react-query";
import {
  type AnyRoute,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { Info } from "lucide-react";

import type { InstallationSettings } from "@/features/settings/api";
import { type Mounted, SESSION, mount, newQueryClient } from "@/features/updates/testing";
import { queryKeys } from "@/lib/api";
import type { InstallationSectionSpec } from "@/lib/extensions";
import type { SessionContextValue } from "@/lib/session";

import { InstallationPage } from "./installation-page";
import { parseInstallationSearch } from "./presenters";
import type { DefaultStorageView } from "./sections/default-storage-api";

/**
 * Fixtures and a harness for the installation page tests (not part of the app
 * bundle: nothing imports this file outside `*.test.*`): the page mounted on
 * `/installation/$section` in a memory router, with a session, a query client
 * and, optionally, the sections an extension adds.
 */

export const SETTINGS: InstallationSettings = {
  operatingMode: "public",
  publicUrl: "https://restow.example.com",
  passkeyReady: { ready: true, reasons: [], rpId: "restow.example.com", origin: null },
  environment: { publicUrl: "https://restow.example.com", publicUrlMismatch: false },
  mail: {
    transport: "smtp",
    smtp: {
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      from: "restow@example.com",
      username: "restow",
      passwordStored: true,
    },
  },
  capabilities: { graphMail: { appConfigured: true, defaultTenantId: null } },
  disclaimer: {
    acceptedVersion: "2026-10-01",
    acceptedAt: "2026-09-20T07:00:00.000Z",
    currentVersion: "2026-10-01",
  },
  updatedAt: "2026-09-20T08:00:00.000Z",
};

export const DEFAULT_STORAGE: DefaultStorageView = {
  configured: true,
  kind: "local",
  location: "/data/chunks",
  copyLocation: null,
  tenants: { total: 5, usingDefault: 3 },
  lastTest: null,
};

/** The features of an installation that manages tenants (Service Provider). */
export const TENANT_FEATURES = ["tenants.additional", "apiKeys.provider"] as const;

/** A section as an extension would add it. */
export function extensionSection(
  overrides: Partial<InstallationSectionSpec> = {},
): InstallationSectionSpec {
  return {
    id: "example",
    labelKey: "installation:sections.providerApi",
    icon: Info,
    order: 45,
    component: ({ requires }) => <p data-slot="example-section">example:{requires ?? "none"}</p>,
    ...overrides,
  };
}

export interface OpenOptions {
  session?: SessionContextValue;
  queryClient?: QueryClient;
  /** Public demo mode (the setup state says so). */
  demo?: boolean;
  /** Further routes, e.g. the targets of locked sections. */
  routes?: (root: AnyRoute) => AnyRoute[];
}

/** The installation page at `path`, inside a memory router, mounted into the document. */
export async function openInstallation(path: string, options: OpenOptions = {}): Promise<Mounted> {
  const root = createRootRoute();
  const section = createRoute({
    getParentRoute: () => root,
    path: "/installation/$section",
    validateSearch: (search: Record<string, unknown>) => parseInstallationSearch(search),
    component: InstallationPage,
  });
  const router = createRouter({
    routeTree: root.addChildren([section, ...(options.routes?.(root) ?? [])]),
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

/** A provider admin of the given team role (`null`: an installation without a team table, an owner). */
export function providerSession(
  providerRole: SessionContextValue["providerRole"],
  overrides: Partial<SessionContextValue> = {},
): SessionContextValue {
  return { ...SESSION, providerRole, providerAllTenants: true, ...overrides };
}
