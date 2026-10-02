import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";
import { dashboardKeys, fetchSetup } from "@/features/dashboard/api";
import { sessionScope, useSession } from "@/lib/session";

import { canSeeStart, justCompleted, startView } from "./presenters";

/** How often the checklist refreshes itself while the app is open. */
export const START_REFRESH_MS = 60_000;

/**
 * The checklist behind the sidebar's Start entry: the active tenant's setup, the
 * same judgement the tenant page shows ("Show setup steps"), asked for alone
 * (`/dashboard?widgets=setup`). Only the admins of the tenant get it, and never
 * under "All tenants". It is read again whenever the page changes, because a step
 * is usually done on another page, and when the last one is done a toast says so,
 * once: the entry then disappears from the menu.
 */
export function useStart() {
  const { t } = useTranslation("dashboard");
  const session = useSession();
  const queryClient = useQueryClient();
  const tenantId = session.activeTenant?.id ?? null;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const enabled =
    session.status === "authenticated" &&
    tenantId !== null &&
    canSeeStart(session.role) &&
    sessionScope(session) !== "all";

  const query = useQuery({
    queryKey: dashboardKeys.setup(tenantId),
    queryFn: fetchSetup,
    enabled,
    refetchInterval: START_REFRESH_MS,
    staleTime: 15_000,
  });

  const result = query.data?.widgets.setup;
  const setup = enabled && result?.state === "ok" ? result.data : null;

  // A step is mostly done on another page: look again when the page changes.
  const lastPath = React.useRef(pathname);
  React.useEffect(() => {
    if (lastPath.current === pathname) {
      return;
    }
    lastPath.current = pathname;
    if (enabled) {
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.setup(tenantId) });
    }
  }, [pathname, enabled, queryClient, tenantId]);

  // The one toast when the last step is completed in this session.
  const previous = React.useRef<{ tenantId: string | null; complete: boolean } | null>(null);
  const complete = setup?.complete ?? null;
  React.useEffect(() => {
    if (complete === null) {
      return;
    }
    const next = { tenantId, complete };
    if (justCompleted(previous.current, next)) {
      toast.success(t("start.complete"));
    }
    previous.current = next;
  }, [complete, tenantId, t]);

  return {
    setup,
    view: startView(setup),
    tenantName: session.activeTenant?.name ?? "",
    invalidate: () => queryClient.invalidateQueries({ queryKey: dashboardKeys.setup(tenantId) }),
  };
}
