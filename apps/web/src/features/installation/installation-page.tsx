import { Link, type LinkProps, useParams, useSearch } from "@tanstack/react-router";
import { Lock, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";
import { RequireRole } from "@/components/require-role";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { InstallationSectionSpec } from "@/lib/extensions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

import { DEFAULT_SECTION_ID } from "./paths";
import { parseInstallationSearch, sectionStates } from "./presenters";
import { useWordingScope } from "./scope";
import { installationSections } from "./sections";
import { InstallationSubNav } from "./subnav";

/** The installation's settings are the provider's; a tenant's admins manage their tenant elsewhere. */
export const INSTALLATION_ROLES = ["provider_admin"] as const;

/**
 * The installation page: the settings of the server and of the operation of
 * all tenants (or of the one organisation), one section per address
 * (`/installation/<section>`), with the sections in a sub-navigation beside
 * the content (a select above it on a phone). The title names the section, so
 * the breadcrumbs read "Installation > Settings > Server". Only provider
 * admins open it; a role that may look but not change sees the forms read-only
 * with a sentence on what is needed (installation/access.tsx).
 */
export function InstallationPage() {
  const { t } = useTranslation();
  const scope = useWordingScope();
  const session = useSession();
  const { section } = useParams({ strict: false }) as { section?: string };
  const search = parseInstallationSearch(useSearch({ strict: false }));

  const states = sectionStates(installationSections(), session);
  const active =
    states.find(({ spec }) => spec.id === section) ??
    states.find(({ spec }) => spec.id === DEFAULT_SECTION_ID) ??
    states[0];
  if (!active) {
    return null;
  }
  const { spec, locked } = active;
  const Section = spec.component;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t(spec.labelKey)}
        description={spec.descriptionKey ? t(spec.descriptionKey, { scope }) : undefined}
        icon={spec.icon}
      />
      <RequireRole roles={INSTALLATION_ROLES} fallback={<Forbidden />}>
        {session.providerAllTenants === false ? (
          <Alert variant="warning">
            <ShieldAlert />
            <AlertDescription>{t("installation:scoped")}</AlertDescription>
          </Alert>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
            <InstallationSubNav states={states} activeId={spec.id} />
            <div className="min-w-0" data-slot="installation-section" data-section={spec.id}>
              {locked ? (
                <LockedSection spec={spec} />
              ) : (
                <Section key={spec.id} requires={search.requires ?? null} />
              )}
            </div>
          </div>
        )}
      </RequireRole>
    </div>
  );
}

function Forbidden() {
  const { t } = useTranslation();
  const scope = useWordingScope();
  return (
    <Alert variant="warning">
      <ShieldAlert />
      <AlertTitle>{t("errors.forbiddenTitle")}</AlertTitle>
      <AlertDescription>{t("installation:forbidden", { scope })}</AlertDescription>
    </Alert>
  );
}

/**
 * A section an extension locked, opened by its address: it says that it is not
 * unlocked and why (the lock's own hint) and leads to the page that unlocks it.
 * The core does not know what the lock stands for.
 */
function LockedSection({ spec }: { spec: InstallationSectionSpec }) {
  const { t } = useTranslation();
  const lock = spec.lock;
  if (!lock) {
    return null;
  }
  return (
    <Card data-slot="locked-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Lock aria-hidden="true" className="size-4" />
          {t("installation:locked.title", { section: t(spec.labelKey) })}
        </CardTitle>
        <CardDescription>{t(lock.hintKey)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("installation:locked.description")}
        </p>
        <Link
          to={lock.to as LinkProps["to"]}
          search={lock.search as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
        >
          {t("installation:locked.action")}
        </Link>
      </CardContent>
    </Card>
  );
}
