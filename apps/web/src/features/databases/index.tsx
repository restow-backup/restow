import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Database } from "lucide-react";

import { RequireRole } from "@/components/require-role";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import { ConnectionPage } from "./connection-page.js";
import { DatabasePage } from "./database-page.js";
import { DatabasesPage } from "./databases-page.js";
import { CONNECTION_PATTERN, DATABASE_PATTERN, DATABASE_ROLES, DATABASES_PATH } from "./paths.js";

/**
 * The module "Databases" (docs/DATABASES.md 2): in "Servers & clients" below file shares, shown
 * while the module is on. The list with the add dialog, one page per connection and per
 * database. Administrators change; restore operators read.
 */

function DatabasesRoute() {
  const search = useSearch({ strict: false }) as { add?: unknown };
  const navigate = useNavigate();
  const adding = search.add === 1 || search.add === "1" || search.add === true;
  return (
    <RequireRole roles={DATABASE_ROLES}>
      <DatabasesPage
        adding={adding}
        onAddChange={(open) =>
          void navigate({
            to: DATABASES_PATH as never,
            search: (open ? { add: 1 } : {}) as never,
            replace: !open,
          })
        }
      />
    </RequireRole>
  );
}

function ConnectionRoute() {
  const { connectionId } = useParams({ strict: false }) as { connectionId?: string };
  if (!connectionId) {
    return null;
  }
  return (
    <RequireRole roles={DATABASE_ROLES}>
      <ConnectionPage key={connectionId} connectionId={connectionId} />
    </RequireRole>
  );
}

function DatabaseRoute() {
  const { databaseId } = useParams({ strict: false }) as { databaseId?: string };
  if (!databaseId) {
    return null;
  }
  return (
    <RequireRole roles={DATABASE_ROLES}>
      <DatabasePage key={databaseId} databaseId={databaseId} />
    </RequireRole>
  );
}

export const databasesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: DATABASES_PATH,
  validateSearch: (search: Record<string, unknown>) => search,
  component: DatabasesRoute,
});

export const connectionRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: CONNECTION_PATTERN,
  component: ConnectionRoute,
});

export const databaseRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: DATABASE_PATTERN,
  component: DatabaseRoute,
});

export const routes = [databasesRoute, connectionRoute, databaseRoute];

export const navItems: NavItem[] = [
  {
    id: "databases",
    modules: ["databases"],
    path: DATABASES_PATH,
    labelKey: "databases:nav.label",
    icon: Database,
    roles: [...DATABASE_ROLES],
    group: "endpoints",
    order: 28,
  },
];
