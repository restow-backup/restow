import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { EyeOff, Info } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { ARCHIVE_PATH } from "@/features/archive/paths";
import { INVENTORY_PATH } from "@/features/endpoints/paths";
import { PVE_PATH } from "@/features/pve/paths";
import { queryKeys } from "@/lib/api";
import { MODULE_IDS, type ModuleId, moduleDescriptionKey, moduleTitleKey } from "@/lib/modules";
import { useSession } from "@/lib/session";
import { tenantPagePath } from "@/lib/tenant-paths";

import { blockFor, useInstallationAccess } from "../access";
import type { WordingScope } from "../presenters";
import { useWordingScope } from "../scope";
import { fetchModules, MODULES_KEY, type ModuleState, saveModules } from "./modules-api";

/** Where a module's own page is: the address that still opens it while it is hidden. */
function modulePage(
  id: ModuleId,
  tenantId: string | null,
): { to: string; search?: Record<string, string> } | null {
  switch (id) {
    case "microsoft365":
      // The tab is named: the bare address opens the first kind of connection still on offer.
      return tenantId
        ? { to: tenantPagePath(tenantId, "connections"), search: { tab: "microsoft365" } }
        : null;
    case "imap":
      return tenantId
        ? { to: tenantPagePath(tenantId, "connections"), search: { tab: "imap" } }
        : null;
    case "archive":
      return { to: ARCHIVE_PATH };
    case "endpoints":
      return { to: INVENTORY_PATH };
    case "pve":
      return { to: PVE_PATH };
  }
}

/**
 * Installation > Modules: what this installation protects (lib/modules.ts), the answer the setup
 * wizard asked for, changed at any time. A switch per module; one module always stays on.
 * Switching a module off hides its menu entries, its cards on the overview and its entries where
 * something new is created, and nothing else: no data is deleted, no job stops. A module that is
 * off and still holds something says what, with counts across every tenant, and leads to its
 * page, which stays reachable by its address. Every provider admin reads; administrators and
 * owners change (apps/api lib/provider-access.ts).
 */
export function ModulesSection() {
  const { t } = useTranslation("installation");
  const { t: tc } = useTranslation();
  const session = useSession();
  const scope = useWordingScope();
  const access = useInstallationAccess();
  const block = blockFor(access, "administrator");
  const queryClient = useQueryClient();
  const id = React.useId();
  const query = useQuery({ queryKey: MODULES_KEY, queryFn: fetchModules });
  const save = useMutation({
    mutationFn: saveModules,
    onSuccess: async (data) => {
      queryClient.setQueryData(MODULES_KEY, data);
      toast.success(t("modules.saved"));
      // The menu, the overview and the palette read the modules from the profile.
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const modules = query.data?.modules ?? [];
  const enabled = modules.filter((module) => module.enabled).map((module) => module.id);
  const toggle = (module: ModuleId, on: boolean) => {
    save.mutate(
      MODULE_IDS.filter((candidate) => (candidate === module ? on : enabled.includes(candidate))),
    );
  };

  return (
    <div className="space-y-4" data-slot="modules-section">
      {block ? (
        <Alert variant="info" data-slot="access-note" data-reason={block}>
          <Info />
          <AlertDescription>
            {block === "demo" ? t("access.demo") : t("modules.access")}
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("modules.title")}</CardTitle>
          <CardDescription>{t("modules.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {query.isError ? (
            <ErrorState
              title={t("modules.loadError")}
              error={query.error}
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          ) : !query.data ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <ul className="divide-y divide-border">
              {modules.map((module) => {
                // The last module that is on cannot be switched off: something is always shown.
                const last = module.enabled && enabled.length === 1;
                return (
                  <li
                    key={module.id}
                    className="space-y-2 py-4 first:pt-0 last:pb-0"
                    data-module={module.id}
                    data-enabled={module.enabled}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <label htmlFor={`${id}-${module.id}`} className="text-sm font-medium">
                          {tc(moduleTitleKey(module.id))}
                        </label>
                        <p
                          id={`${id}-${module.id}-description`}
                          className="max-w-prose text-sm text-muted-foreground"
                        >
                          {tc(moduleDescriptionKey(module.id))}
                        </p>
                        {last ? (
                          <p className="text-xs text-muted-foreground" data-slot="module-last">
                            {t("modules.lastOne")}
                          </p>
                        ) : null}
                      </div>
                      <Switch
                        id={`${id}-${module.id}`}
                        checked={module.enabled}
                        aria-describedby={`${id}-${module.id}-description`}
                        disabled={block !== null || save.isPending || last}
                        onCheckedChange={(checked) => toggle(module.id, checked)}
                      />
                    </div>
                    {module.enabled ? null : (
                      <HiddenModule
                        module={module}
                        tenantId={session.activeTenant?.id ?? null}
                        scope={scope}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * A module that is off: hidden, and what it still holds across every tenant. Nothing of it was
 * deleted or stopped, so the line says so and leads to the module's page.
 */
function HiddenModule({
  module,
  tenantId,
  scope,
}: {
  module: ModuleState;
  tenantId: string | null;
  scope: WordingScope;
}) {
  const { t } = useTranslation("installation");
  const page = modulePage(module.id, tenantId);
  const held = module.data
    .map((entry) => t(`modules.kinds.${entry.kind}`, { count: entry.count }))
    .join(", ");
  return (
    <p
      className="flex items-start gap-2 text-xs text-muted-foreground"
      data-slot="module-hidden"
      data-has-data={module.data.length > 0}
    >
      <EyeOff aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {module.data.length > 0
          ? t("modules.hiddenWithData", { held, scope })
          : t("modules.hidden")}{" "}
        {page && module.data.length > 0 ? (
          <Link
            to={page.to as LinkProps["to"]}
            search={page.search as never}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {t("modules.open")}
          </Link>
        ) : null}
      </span>
    </p>
  );
}
