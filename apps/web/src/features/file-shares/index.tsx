import { createRoute, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Network } from "lucide-react";

import { RequireRole } from "@/components/require-role";
import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n.js";
import {
  FILE_SHARES_PATH,
  FILE_SHARE_PATTERN,
  FILE_SHARE_ROLES,
  type ShareTab,
  parseShareTab,
} from "./paths.js";
import { ShareDetailPage } from "./share-detail-page.js";
import { SharesPage } from "./shares-page.js";

/**
 * File shares (docs/FILESHARES.md): SMB shares and NFS exports backed up from the server side,
 * in "Servers & endpoints" between "VMs & containers" and "File restore". The list with the
 * add dialog, one page per share (overview, restore points, runs, settings). For tenant admins
 * and provider admins in a tenant.
 */

export { FILE_SHARE_ROLES };

function SharesRoute() {
  const search = useSearch({ strict: false }) as { add?: unknown };
  const navigate = useNavigate();
  const adding = search.add === 1 || search.add === "1" || search.add === true;
  return (
    <RequireRole roles={FILE_SHARE_ROLES}>
      <SharesPage
        adding={adding}
        onAddChange={(open) =>
          void navigate({
            to: FILE_SHARES_PATH as never,
            search: (open ? { add: 1 } : {}) as never,
            replace: !open,
          })
        }
      />
    </RequireRole>
  );
}

function ShareRoute() {
  const { shareId } = useParams({ strict: false }) as { shareId?: string };
  const search = useSearch({ strict: false }) as { tab?: unknown };
  const navigate = useNavigate();
  if (!shareId) {
    return null;
  }
  const tab = parseShareTab(search.tab);
  return (
    <RequireRole roles={FILE_SHARE_ROLES}>
      <ShareDetailPage
        key={shareId}
        shareId={shareId}
        tab={tab}
        onTabChange={(next: ShareTab) =>
          void navigate({
            to: `${FILE_SHARES_PATH}/${encodeURIComponent(shareId)}` as never,
            search: (next === "overview" ? {} : { tab: next }) as never,
            replace: true,
          })
        }
      />
    </RequireRole>
  );
}

export const fileSharesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: FILE_SHARES_PATH,
  validateSearch: (search: Record<string, unknown>) => search,
  component: SharesRoute,
});

export const fileShareRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: FILE_SHARE_PATTERN,
  validateSearch: (search: Record<string, unknown>) => search,
  component: ShareRoute,
});

export const routes = [fileSharesRoute, fileShareRoute];

export const navItems: NavItem[] = [
  {
    id: "file-shares",
    path: FILE_SHARES_PATH,
    labelKey: "fileshares:nav.label",
    icon: Network,
    roles: [...FILE_SHARE_ROLES],
    group: "endpoints",
    order: 27,
  },
];
