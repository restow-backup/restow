import { Link, useSearch } from "@tanstack/react-router";
import { Info, Lock, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { EmbeddedPage } from "@/components/kit/page-context";
import { ReadOnlyGroup } from "@/components/kit/read-only-group";
import { SectionNav, type SectionNavItem } from "@/components/layout/section-nav";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWordingScope } from "@/features/installation/scope";
import type { TenantSectionSpec } from "@/lib/extensions";
import { type SessionTenant, sessionScope, useSession } from "@/lib/session";
import { tenantPagePath } from "@/lib/tenant-paths";
import { cn } from "@/lib/utils";

import { type TenantPageAccess, resolveTenantPageAccess, useTenantWriteBlock } from "./access";
import { type SubPage, isSectionClosed, tenantSectionStates } from "./presenters";
import { tenantSections } from "./sections";

/**
 * The tenant page: everything that belongs to one tenant at one address,
 * `/tenants/<id>/<section>`, with the sections in a sub-navigation beside the
 * content (a select above it on a phone). The title names the section, so the
 * breadcrumbs read "Tenant: <name> > Tenants > Tenant settings > Connections".
 *
 * Opening the page makes the tenant the active one (the same switch the
 * tenant switcher makes), so every section keeps working on "the active
 * tenant" and the header names the tenant it is about. A tenant's own
 * administrator opens their tenant only; the address of another tenant, or of
 * one that does not exist, says so instead of failing. A person who is no
 * administrator of the tenant has no tenant page. Provider roles that may look
 * but not change see the controls closed, with a sentence saying why.
 */
export function TenantPage({
  tenantId,
  section,
  sub = null,
}: {
  tenantId: string;
  section: string;
  /** The page below the section the address names, if any. */
  sub?: SubPage | null;
}) {
  const session = useSession();
  const access = resolveTenantPageAccess({
    isProviderAdmin: session.isProviderAdmin,
    tenants: session.tenants,
    tenantId,
  });
  if (access.kind !== "ok") {
    return <ClosedTenantPage access={access} />;
  }
  return <OpenTenantPage tenant={access.tenant} section={section} sub={sub} />;
}

function OpenTenantPage({
  tenant,
  section,
  sub,
}: {
  tenant: SessionTenant;
  section: string;
  sub: SubPage | null;
}) {
  const { t } = useTranslation();
  const session = useSession();
  const scope = useWordingScope();
  const block = useTenantWriteBlock();
  // Searched only so that the address's parameters keep reaching the sections.
  useSearch({ strict: false });

  // Make the tenant of the address the active one when the address is opened or
  // changes. Not the other way round: when the switcher picks another tenant, it
  // takes the page along (components/tenant-switcher.tsx), and this must not undo it.
  // A tenant's page also ends "All tenants": it names its tenant, and the header says so.
  const allTenants = sessionScope(session) === "all";
  const latest = React.useRef({ activeId: session.activeTenant?.id, set: session.setActiveTenant });
  latest.current = { activeId: session.activeTenant?.id, set: session.setActiveTenant };
  React.useEffect(() => {
    if (latest.current.activeId !== tenant.id || allTenants) {
      latest.current.set(tenant.id);
    }
  }, [tenant.id, allTenants]);

  const states = tenantSectionStates(tenantSections(), session);
  const active =
    states.find(({ spec }) => spec.id === section) ??
    states.find(({ spec }) => spec.id === "overview") ??
    states[0];
  if (!active) {
    return null;
  }
  const { spec, locked } = active;

  const items = states.map(
    ({ spec: entry, locked: isLocked }): SectionNavItem => ({
      id: entry.id,
      label: t(entry.labelKey),
      icon: entry.icon,
      to: tenantPagePath(tenant.id, entry.id),
      locked:
        isLocked && entry.lock
          ? { to: entry.lock.to, search: entry.lock.search, hint: t(entry.lock.hintKey) }
          : undefined,
    }),
  );
  const ready = session.activeTenant?.id === tenant.id;
  const closed = isSectionClosed(spec.id, block);

  return (
    <div className="space-y-6" data-slot="tenant-page" data-tenant={tenant.id}>
      <PageHeader
        title={t(spec.labelKey)}
        description={
          spec.descriptionKey ? t(spec.descriptionKey, { scope, tenant: tenant.name }) : undefined
        }
        icon={spec.icon}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
        <SectionNav
          items={items}
          activeId={spec.id}
          label={t("tenantpage:sections.label", { scope })}
          selectLabel={t("tenantpage:sections.select")}
          selectId="tenant-section-select"
        />
        <div
          className="min-w-0 space-y-6"
          data-slot="tenant-section"
          data-section={spec.id}
          data-sub={sub ?? undefined}
        >
          {closed && block ? <WriteNote block={block} /> : null}
          {!ready ? (
            <SectionSkeleton />
          ) : locked ? (
            <LockedSection spec={spec} />
          ) : (
            <EmbeddedPage>
              <ReadOnlyGroup closed={closed} className="space-y-6">
                <spec.component
                  key={`${tenant.id}:${spec.id}`}
                  tenant={tenant}
                  readOnly={closed}
                  sub={sub}
                />
              </ReadOnlyGroup>
            </EmbeddedPage>
          )}
        </div>
      </div>
    </div>
  );
}

/** Why the controls are closed, in one sentence. */
function WriteNote({ block }: { block: "demo" | "role" }) {
  const { t } = useTranslation("tenantpage");
  return (
    <Alert variant="info" data-slot="access-note" data-reason={block}>
      <Info />
      <AlertDescription>{t(`access.${block}`)}</AlertDescription>
    </Alert>
  );
}

function SectionSkeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" className="space-y-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
      <span className="sr-only">{t("common:loading.label")}</span>
    </div>
  );
}

/**
 * A section an extension locked, opened by its address: it says that it is not
 * unlocked and why (the lock's own hint) and leads to the page that unlocks it.
 * The core does not know what the lock stands for.
 */
function LockedSection({ spec }: { spec: TenantSectionSpec }) {
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
          {t("tenantpage:locked.title", { section: t(spec.labelKey) })}
        </CardTitle>
        <CardDescription>{t(lock.hintKey)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          {t("tenantpage:locked.description")}
        </p>
        <Link
          to={lock.to as never}
          search={lock.search as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
        >
          {t("tenantpage:locked.action")}
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * The address names a tenant the viewer cannot open: one that is somebody
 * else's, that does not exist, that is closed, or where they are no
 * administrator. A calm statement and the way back to what is theirs.
 */
function ClosedTenantPage({ access }: { access: Exclude<TenantPageAccess, { kind: "ok" }> }) {
  const { t } = useTranslation("tenantpage");
  const scope = useWordingScope();
  const { tenants, isProviderAdmin } = useSession();
  // The way out: a tenant they administer, else the start page.
  const own = tenants.find((tenant) => isProviderAdmin || tenant.role === "tenant_admin");
  const name = "tenant" in access ? access.tenant.name : "";
  return (
    <div className="space-y-6" data-slot="tenant-page-closed" data-state={access.kind}>
      <PageHeader title={t("title", { scope })} icon={ShieldAlert} />
      <Alert variant="warning">
        <ShieldAlert />
        <AlertTitle>{t(`states.${access.kind}.title`, { scope, name })}</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>{t(`states.${access.kind}.description`, { scope, name })}</p>
          {own ? (
            <Link
              to={tenantPagePath(own.id, "overview") as never}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
            >
              {t("states.openOwn", { scope, name: own.name })}
            </Link>
          ) : (
            <Link
              to={"/" as never}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
            >
              {t("states.home")}
            </Link>
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}
