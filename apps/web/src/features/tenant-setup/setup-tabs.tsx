import { type LinkProps, useNavigate, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageTabs } from "@/components/kit/page-tabs";
import { toast } from "@/components/ui/sonner";
import { canAccess, useSession } from "@/lib/session";

import {
  TENANT_SETUP_PATH,
  findTenantSetupTab,
  isTenantSetupTabPage,
  visibleTenantSetupTabs,
} from "./tabs";

/**
 * The tab bar of the tenant setup area, above the page of the current tab
 * (the shell renders it, app-layout.tsx). It shows on the tabs' own pages,
 * not on pages below them (a source, an import), which have breadcrumbs back
 * instead, and only when the role may open more than one tab.
 */
export function TenantSetupTabs() {
  const { t } = useTranslation();
  const { role, activeTenant } = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  if (!activeTenant || !isTenantSetupTabPage(pathname)) {
    return null;
  }
  const current = findTenantSetupTab(pathname);
  const tabs = visibleTenantSetupTabs(role, canAccess);
  if (!current || tabs.length < 2) {
    return null;
  }
  return (
    <PageTabs
      className="mb-6"
      label={t("nav.setup.tabsLabel", { tenant: activeTenant.name })}
      current={current.id}
      tabs={tabs.map((tab) => ({
        id: tab.id,
        label: t(tab.labelKey),
        to: tab.path,
        icon: tab.icon,
      }))}
    />
  );
}

/**
 * "Open tenant page": make the tenant the active one (as switching does) and
 * open its setup area. Shared by the tenant switcher and the All tenants list.
 */
export function useOpenTenantSetup(): (tenant: { id: string; name: string }) => void {
  const { t } = useTranslation();
  const { activeTenant, setActiveTenant } = useSession();
  const navigate = useNavigate();

  return React.useCallback(
    (tenant) => {
      if (tenant.id !== activeTenant?.id) {
        setActiveTenant(tenant.id);
        toast.success(t("tenant.switched", { name: tenant.name }));
      }
      void navigate({ to: TENANT_SETUP_PATH as LinkProps["to"] });
    },
    [activeTenant?.id, navigate, setActiveTenant, t],
  );
}
