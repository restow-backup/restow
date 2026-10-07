import { Navigate, useNavigate, useParams, useSearch } from "@tanstack/react-router";

import { RequireRole } from "@/components/require-role";
import { explorerAt } from "@/features/restore/navigation";

import { EndpointDetailPage } from "./endpoint-detail-page.js";
import { EndpointsPage } from "./endpoints-page.js";
import { FileRestorePage } from "./file-restore-page.js";
import {
  type EndpointProfile,
  type EndpointTab,
  INVENTORY_PATH,
  areaOfKind,
  endpointDetailTo,
  parseFileRestoreSearch,
  parseInventorySearch,
  parseTab,
} from "./paths.js";

/** Servers and clients are administered by tenant admins and provider admins. */
export const ENDPOINT_ROLES = ["provider_admin", "tenant_admin"] as const;

/** The inventory behind the role gate; the filter chip comes from `?kind=`. */
export function InventoryRoute() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const { kind } = parseInventorySearch(raw);
  const navigate = useNavigate();
  const changeKind = (next: EndpointProfile | undefined) => {
    void navigate({
      to: INVENTORY_PATH as never,
      search: (next ? { kind: next } : {}) as never,
      replace: true,
    });
  };
  return (
    <RequireRole roles={ENDPOINT_ROLES}>
      <EndpointsPage area={areaOfKind(kind)} onKindChange={changeKind} />
    </RequireRole>
  );
}

/** The page of one machine: the id comes from the path, the tab from `?tab=`. */
export function EndpointDetailRoute() {
  const { endpointId } = useParams({ strict: false }) as { endpointId?: string };
  const search = useSearch({ strict: false }) as { tab?: unknown };
  const navigate = useNavigate();
  if (!endpointId) {
    return null;
  }
  const changeTab = (next: EndpointTab) => {
    void navigate({
      to: endpointDetailTo(endpointId),
      // The overview is the default and stays out of the URL.
      search: (next === "overview" ? {} : { tab: next }) as never,
      replace: true,
    });
  };
  return (
    <RequireRole roles={ENDPOINT_ROLES}>
      {/* Keyed by id so moving to another machine starts from a clean state. */}
      <EndpointDetailPage
        key={endpointId}
        endpointId={endpointId}
        tab={parseTab(search.tab)}
        onTabChange={changeTab}
      />
    </RequireRole>
  );
}

/**
 * File restore: the machine comes from `?machine=`. A mailbox link of an earlier
 * version (`?mailbox=`) opens the restore explorer at that mailbox instead.
 */
export function FileRestoreRoute() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const { machine, mailbox } = parseFileRestoreSearch(raw);
  if (!machine && mailbox) {
    const explorer = explorerAt(mailbox);
    return <Navigate to={explorer.to} search={explorer.search as never} replace />;
  }
  return (
    <RequireRole roles={ENDPOINT_ROLES}>
      <FileRestorePage machineId={machine ?? null} />
    </RequireRole>
  );
}
