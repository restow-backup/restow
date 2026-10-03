import { Boxes, Laptop, Plus, Server } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader, RefreshButton } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/session";

import { EndpointsTable } from "./components/endpoints-table.js";
import { EnrollDialog } from "./components/enroll-dialog.js";
import { PendingTokens } from "./components/pending-tokens.js";
import { ProxmoxTeaser } from "./components/proxmox-teaser.js";
import { WithoutBackupBanner, canManageJobs } from "./components/without-backup.js";
import { useEndpoints } from "./hooks.js";
import { type EndpointArea, type EndpointProfile, profileOfArea } from "./paths.js";

const AREA_ICON = { agents: Boxes, servers: Server, clients: Laptop } as const;

/** The filter chips, in order: everything, then each profile. */
const CHIPS: readonly { area: EndpointArea; kind: EndpointProfile | undefined }[] = [
  { area: "agents", kind: undefined },
  { area: "servers", kind: "server" },
  { area: "clients", kind: "client" },
];

/**
 * Inventory: every machine with an agent, filtered to servers or clients by
 * the chips above the list, with the wizard that adds one and the install
 * commands that wait for a machine.
 */
export function EndpointsPage({
  area,
  onKindChange,
}: {
  area: EndpointArea;
  /** Chooses a filter chip; omitted, the chips are not shown. */
  onKindChange?: (kind: EndpointProfile | undefined) => void;
}) {
  const { t } = useTranslation("endpoints");
  const { activeTenant, isProviderAdmin, role } = useSession();
  const profile = profileOfArea(area);
  const endpoints = useEndpoints(profile);
  const [enrolling, setEnrolling] = React.useState<EndpointProfile | null>(null);

  const newButton = (kind: EndpointProfile, primary: boolean) => (
    <Button
      key={kind}
      size="sm"
      variant={primary ? "default" : "outline"}
      onClick={() => setEnrolling(kind)}
    >
      <Plus aria-hidden="true" />
      {t(`list.new.${kind}`)}
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t("inventory.title")} description={t("inventory.subtitle")}>
        <RefreshButton
          onRefresh={() => void endpoints.refetch()}
          fetching={endpoints.isFetching}
          label={t("list.refresh")}
        />
        {/* A teaser, not a flow: what comes after this release. */}
        <ProxmoxTeaser />
        {area === "agents"
          ? [newButton("client", false), newButton("server", true)]
          : newButton(profile ?? "server", true)}
      </PageHeader>

      {onKindChange ? (
        // A group of toggle buttons: one is pressed, the list follows it.
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0" data-slot="inventory-chips">
          <legend className="sr-only">{t("inventory.filterLabel")}</legend>
          {CHIPS.map((chip) => {
            const pressed = chip.area === area;
            const Icon = AREA_ICON[chip.area];
            return (
              <Button
                key={chip.area}
                type="button"
                size="sm"
                variant={pressed ? "secondary" : "outline"}
                aria-pressed={pressed}
                className="rounded-full"
                onClick={() => onKindChange(chip.kind)}
              >
                <Icon aria-hidden="true" />
                {t(`inventory.chips.${chip.area}`)}
              </Button>
            );
          })}
        </fieldset>
      ) : null}

      <p className="max-w-prose text-sm text-muted-foreground">{t("list.honesty")}</p>

      <PendingTokens profile={profile} />

      <WithoutBackupBanner items={endpoints.data ?? []} />

      <EndpointsTable
        area={area}
        items={endpoints.data}
        loading={endpoints.isPending && activeTenant !== null}
        fetching={endpoints.isFetching}
        error={endpoints.isError ? endpoints.error : null}
        onRetry={() => void endpoints.refetch()}
        canManageJobs={canManageJobs(role)}
        empty={
          activeTenant === null ? (
            <EmptyState
              variant="plain"
              icon={AREA_ICON[area]}
              title={t("list.noTenant.title")}
              description={t("list.noTenant.description")}
            />
          ) : (
            <EmptyState
              variant="plain"
              icon={AREA_ICON[area]}
              title={t(`list.empty.${area}.title`)}
              description={t(`list.empty.${area}.description`)}
              actions={
                area === "agents" ? (
                  <>
                    {newButton("server", true)}
                    {newButton("client", false)}
                  </>
                ) : (
                  newButton(profile ?? "server", true)
                )
              }
            />
          )
        }
      />

      <EnrollDialog
        open={enrolling !== null}
        onOpenChange={(open) => {
          if (!open) setEnrolling(null);
        }}
        profile={enrolling ?? "server"}
        canOpenInstallation={isProviderAdmin}
      />
    </div>
  );
}
