import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CatchBoundary, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Sparkles, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { CommandPaletteProvider } from "@/components/command-palette/command-palette";
import { ErrorState } from "@/components/error-state";
import {
  PageMain,
  PageProvider,
  pageContentWrapperClass,
  usePageWidthValue,
} from "@/components/kit/page-context";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { AuthLayout } from "@/components/layout/auth-layout";
import { ChooseTenantPage } from "@/components/layout/choose-tenant";
import { RouteErrorPage } from "@/components/layout/route-error";
import { useShellEntry } from "@/components/layout/shell-entry";
import { ShellSkeleton } from "@/components/layout/shell-skeleton";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/layout/skip-link";
import { StandaloneErrorPage } from "@/components/layout/standalone-error";
import { TopBar } from "@/components/layout/top-bar";
import { useFocusPageHeading } from "@/components/layout/use-focus-page-heading";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SidebarProvider } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/sonner";
import { DisclaimerDialog } from "@/features/disclaimer/disclaimer-dialog";
import { LiveChannelProvider } from "@/features/history/live/provider";
import { MaintenanceBanner, MaintenanceProvider, ShellMaintenanceModal } from "@/features/updates";
import { queryKeys, setupStateQueryOptions } from "@/lib/api";
import { LOGIN_PATH, loginRedirectFor } from "@/lib/entry";
import { onUnauthorized } from "@/lib/query";
import { isTenantOnlyPage } from "@/lib/scope";
import { sessionScope, useSession } from "@/lib/session";
import { TenantFromAddress } from "@/lib/tenant-address";

/** Route id of the authenticated shell (`appLayoutRoute` in routes/tree.ts). */
const APP_ROUTE_ID = "/app";

/**
 * Layout for the authenticated shell. The route guard already verified the
 * session; this component keeps watching it so an expired session (or a 401
 * from any query) sends the user back to the login page instead of leaving
 * a half-rendered app behind.
 */
export function AppLayout() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const href = useRouterState({ select: (state) => state.location.href });

  const redirectToLogin = React.useCallback(() => {
    queryClient.removeQueries({ queryKey: queryKeys.authSession });
    queryClient.removeQueries({ queryKey: queryKeys.me });
    const { redirect } = loginRedirectFor(href);
    void navigate({
      to: LOGIN_PATH,
      search: redirect ? { redirect } : {},
      replace: true,
    });
  }, [href, navigate, queryClient]);

  React.useEffect(() => {
    if (session.status === "unauthenticated") {
      redirectToLogin();
    }
  }, [session.status, redirectToLogin]);

  React.useEffect(
    () =>
      onUnauthorized(() => {
        toast.warning(t("errors.unauthorized"));
        redirectToLogin();
      }),
    [redirectToLogin, t],
  );

  if (session.status === "loading" || session.status === "unauthenticated") {
    return <ShellSkeleton />;
  }

  if (session.status === "error") {
    return (
      <AuthLayout>
        <ErrorState
          title={t("errors.shellTitle")}
          error={session.error}
          onRetry={() => void session.refresh()}
        />
      </AuthLayout>
    );
  }

  return (
    <>
      <ShellFrame>
        <ShellOutlet />
      </ShellFrame>
      {/* A link that names its tenant (`?forTenant=`) opens that tenant. */}
      <TenantFromAddress />
      {/* An installation that predates the operator notice asks its provider admin once. */}
      <DisclaimerDialog />
    </>
  );
}

/**
 * The shell around a page: skip link, sidebar, top bar, command palette and
 * the main region. The page context gives every `PageHeader` the icon of its
 * menu entry and carries the page title to the breadcrumbs.
 */
export function ShellFrame({ children }: { children: React.ReactNode }) {
  const { activeTenant } = useSession();
  const entry = useShellEntry();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useFocusPageHeading(pathname);

  return (
    // The maintenance state (an announced or running update) is for everyone signed in.
    <MaintenanceProvider>
      {/* The one live connection of the tab: every page below moves without a request of its own. */}
      <LiveChannelProvider>
        <SidebarProvider>
          <PageProvider icon={entry?.item.icon ?? null} tenantName={activeTenant?.name ?? null}>
            <CommandPaletteProvider>
              <SkipLink />
              <AppSidebar />
              {/*
              Not the primitive's SidebarInset: that renders <main>, which would
              put the top bar inside the main landmark and make "Skip to content"
              land on the top bar instead of the page.
            */}
              <div data-slot="sidebar-inset" className="flex min-w-0 flex-1 flex-col bg-background">
                {/* The maintenance banner stays above the top bar while the page scrolls. */}
                <div className="sticky top-0 z-20">
                  <MaintenanceBanner />
                  <TopBar />
                </div>
                <ShellMain>{children}</ShellMain>
              </div>
            </CommandPaletteProvider>
          </PageProvider>
        </SidebarProvider>
      </LiveChannelProvider>
      <ShellMaintenanceModal />
    </MaintenanceProvider>
  );
}

/**
 * The `<main>` landmark and its content wrapper, sized by the current page's
 * width (`wide` by default; a page opts into `readable` or `full` through
 * `usePageWidth`, see kit/page-context.tsx). `full` also hands the page a
 * fixed height below the top bar instead of a fixed max width, so it can lay
 * out its own independently scrolling panes. The width-sized `<main>` itself
 * is `PageMain`; this function only adds what belongs to the shell
 * specifically — the demo banner, the suspended-tenant notice and the routed
 * page.
 */
function ShellMain({ children }: { children: React.ReactNode }) {
  const width = usePageWidthValue();
  return (
    <PageMain id={MAIN_CONTENT_ID}>
      <DemoBanner />
      <SuspendedTenantNotice />
      {/*
        Always a `div` here, whatever the width — only its class changes
        (pageContentWrapperClass). Branching the element type itself on the
        width (a `div` for one width, `children` bare for the rest) would
        move the routed page to a different position in the tree on every
        width change and force React to remount it instead of reconciling.
      */}
      <div className={pageContentWrapperClass(width)}>{children}</div>
    </PageMain>
  );
}

/**
 * The routed page, guarded so a failing page stays inside the shell: a route
 * whose search params, guard or loader failed renders the error page in its
 * place, and a page that throws while rendering is caught at the outlet
 * (sidebar and top bar keep working). Navigating elsewhere clears the error.
 * Under "All tenants" a page that needs one tenant shows the choice of a tenant
 * in its place (components/layout/choose-tenant.tsx).
 */
function ShellOutlet() {
  const { t } = useTranslation();
  const session = useSession();
  const entry = useShellEntry();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const failedPage = useRouterState({
    select: (state) => {
      const shellIndex = state.matches.findIndex((match) => match.routeId === APP_ROUTE_ID);
      return state.matches.slice(shellIndex + 1).find((match) => match.status === "error");
    },
  });

  if (failedPage) {
    return <RouteErrorPage error={failedPage.error} />;
  }

  // Under "All tenants" a page that only exists per tenant asks for a tenant instead of failing.
  if (sessionScope(session) === "all" && isTenantOnlyPage(entry?.item.id ?? null, pathname)) {
    return <ChooseTenantPage title={entry ? t(entry.item.labelKey) : t("chooseTenant.title")} />;
  }

  return (
    <CatchBoundary getResetKey={() => pathname} errorComponent={RouteErrorPage}>
      <Outlet />
    </CatchBoundary>
  );
}

/**
 * Public demo mode (deploy/demo/README.md): a persistent reminder above every
 * page that nothing here is real and nothing survives the night. Reads the
 * same cached setup-state query the login page's demo panel and the root
 * guard use, so it never triggers a request of its own.
 */
function DemoBanner() {
  const { t } = useTranslation("auth");
  const { data } = useQuery(setupStateQueryOptions);
  if (!data?.demo.enabled) {
    return null;
  }
  return (
    <Alert className="mb-6 border-primary/40 bg-primary/5">
      <Sparkles />
      <AlertDescription>{t("demo.banner")}</AlertDescription>
    </Alert>
  );
}

/**
 * The active tenant is suspended or being deleted: say so above every page.
 * Provider admins may work in such a tenant; members only end up here when
 * every tenant they belong to is closed, and the API refuses their requests.
 */
function SuspendedTenantNotice() {
  const { t } = useTranslation();
  const session = useSession();
  const { activeTenant, isProviderAdmin } = session;
  // Under "All tenants" no one tenant is being worked in; the tenant underneath says nothing.
  if (!activeTenant || activeTenant.status === "active" || sessionScope(session) === "all") {
    return null;
  }
  const notice = `tenant.notice.${activeTenant.status}`;
  return (
    <Alert variant="warning" className="mb-6">
      <TriangleAlert />
      <AlertTitle>{t(`${notice}.title`, { name: activeTenant.name })}</AlertTitle>
      <AlertDescription>
        {t(`${notice}.${isProviderAdmin ? "provider" : "member"}`)}
      </AlertDescription>
    </Alert>
  );
}

/**
 * The shell itself could not be set up (the profile request failed, or the
 * frame crashed): a standalone page with the cause and a retry.
 */
export function AppErrorPage({ error, reset }: { error: unknown; reset?: () => void }) {
  const { t } = useTranslation();
  return <StandaloneErrorPage title={t("errors.shellTitle")} error={error} reset={reset} />;
}
