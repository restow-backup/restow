import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
  ApiError,
  GATED_FEATURES,
  type GatedFeature,
  type Me,
  type ProviderRole,
  type Role,
  type SessionUser,
  type Tenant,
  type TenantKind,
  type TenantSummary,
  fetchMe,
  fetchTenants,
  queryKeys,
  setupStateQueryOptions,
} from "@/lib/api";
import { type AuthSession, authClient } from "@/lib/auth-client";
import { requiresAuthenticatorEnrollment } from "@/lib/second-factor";
import {
  type SessionScope,
  type TenantStatus,
  canEnterTenant,
  forgetActiveTenant,
  pickActiveTenant,
  readRememberedScope,
  readRememberedTenantId,
  rememberScope,
  roleInActiveTenant,
  setActiveTenantId,
} from "@/lib/tenant";

/**
 * Session model for the shell. better-auth answers "who is signed in"
 * (reactive via `authClient.useSession()`); `/api/v1/me` adds what Restow
 * knows on top: the tenants this user may work in with the role in each, the
 * tenant the server considers active, the gated features the installation
 * enables, the fields server extensions add, and the running version. The
 * provider merges both and owns the active-tenant choice.
 *
 * `role` is the role in the active tenant. The API decides every request with
 * that role (it reads the tenant from `X-Restow-Tenant`), so the sidebar, the
 * command palette, `RequireRole` and every other gate use it as well: a
 * tenant admin of one tenant who is a plain user of another sees the user's
 * navigation while the second tenant is active.
 */

/** The better-auth session, cached for route guards (`beforeLoad`). */
export const sessionQueryOptions = queryOptions({
  queryKey: queryKeys.authSession,
  queryFn: async (): Promise<AuthSession | null> => {
    const { data, error } = await authClient.getSession();
    if (error) {
      if (error.status === 401) {
        return null;
      }
      throw error;
    }
    return data ?? null;
  },
  staleTime: 60_000,
  retry: false,
});

/** `/api/v1/me`, cached for route guards and the provider alike. */
export const meQueryOptions = queryOptions({
  queryKey: queryKeys.me,
  queryFn: fetchMe,
  staleTime: 60_000,
  retry: (failureCount, error) =>
    !(error instanceof ApiError && error.status < 500) && failureCount < 1,
});

export type SessionStatus = "loading" | "authenticated" | "unauthenticated" | "error";

/**
 * A tenant on offer in the switcher, with its lifecycle state, its kind (the
 * operator's own organisation is `internal` and listed first) and the
 * provider's customer number.
 */
export interface SessionTenant extends Omit<TenantSummary, "kind" | "customerNumber"> {
  kind: TenantKind;
  customerNumber: string | null;
  status: TenantStatus;
}

/** The running build as `/api/v1/me` reports it (same document as `/status`). */
export interface RunningVersion {
  /** Release version; null for a build without a release tag. */
  running: string | null;
  /** Short git revision of the running build; null when unknown. */
  commit: string | null;
  /** Newest published release, when the operator enabled the update check. */
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
}

export interface SessionContextValue {
  status: SessionStatus;
  user: SessionUser | null;
  /** Role in the active tenant (provider admins everywhere `provider_admin`). */
  role: Role | null;
  /**
   * The gated core features this installation enables (lib/api.ts
   * `GatedFeature`); null until the profile loaded. Test with {@link hasFeature}.
   */
  features: readonly GatedFeature[] | null;
  /**
   * Fields server extensions added to the profile (`/api/v1/me`
   * `extensions`), opaque to the core and read only by web extensions; null
   * until the profile loaded.
   */
  extensions: Readonly<Record<string, unknown>> | null;
  isProviderAdmin: boolean;
  /**
   * A provider admin's role in the provider team, and whether it covers every
   * tenant (lib/provider-role.ts); null for everyone else. Optional so that
   * test doubles written before the team existed stay valid.
   */
  providerRole?: ProviderRole | null;
  providerAllTenants?: boolean;
  /** Tenants the user may switch between (all tenants for a provider admin). */
  tenants: SessionTenant[];
  activeTenant: SessionTenant | null;
  /** Make a tenant the active one; this also leaves the scope "all". */
  setActiveTenant: (tenantId: string) => void;
  /**
   * What the session works on: `tenant` (the active tenant) or `all`, the view
   * across every tenant that only the overview has. Optional so that test doubles
   * written before it existed stay valid; read it with {@link sessionScope}.
   */
  scope?: SessionScope;
  /**
   * The view across all tenants is on offer: a provider admin whose team role covers
   * every tenant, on an installation that manages tenants and has more than one.
   */
  canViewAllTenants?: boolean;
  /** Work across all tenants (only where {@link canViewAllTenants}); remembered per browser. */
  setScopeAll?: () => void;
  /** The running version; null until the profile loaded. */
  version: RunningVersion | null;
  signOut: () => Promise<void>;
  /** Re-read session and profile (after a sign-in, or when a 401 shows up). */
  refresh: () => Promise<void>;
  error: unknown;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

function deriveStatus(
  session: { data: unknown; isPending: boolean; error: unknown },
  me: { data: Me | undefined; isPending: boolean; error: unknown },
): SessionStatus {
  if (session.isPending) {
    return "loading";
  }
  if (session.error) {
    return "error";
  }
  if (!session.data) {
    return "unauthenticated";
  }
  if (me.error) {
    return me.error instanceof ApiError && me.error.status === 401 ? "unauthenticated" : "error";
  }
  if (me.isPending || !me.data) {
    return "loading";
  }
  return "authenticated";
}

const TENANT_STATUSES: readonly TenantStatus[] = ["active", "suspended", "deleting"];

/** A tenant's status from an API row; rows from older servers count as active. */
function statusOf(row: unknown): TenantStatus {
  const status =
    typeof row === "object" && row !== null ? (row as { status?: unknown }).status : null;
  return TENANT_STATUSES.includes(status as TenantStatus) ? (status as TenantStatus) : "active";
}

const TENANT_KINDS: readonly TenantKind[] = ["customer", "internal"];

/** A tenant's kind from an API row; rows from older servers count as customers. */
function kindOf(row: unknown): TenantKind {
  const kind = typeof row === "object" && row !== null ? (row as { kind?: unknown }).kind : null;
  return TENANT_KINDS.includes(kind as TenantKind) ? (kind as TenantKind) : "customer";
}

/** A tenant's customer number from an API row; null when none is set or the server sends none. */
function customerNumberOf(row: unknown): string | null {
  const number =
    typeof row === "object" && row !== null
      ? (row as { customerNumber?: unknown }).customerNumber
      : null;
  return typeof number === "string" && number.length > 0 ? number : null;
}

/**
 * Tenants the switcher offers. A provider admin may enter every tenant, so
 * the provider list (kept fresh when tenants are added or suspended) wins over
 * the profile's copy; everyone else gets their memberships from the profile.
 */
export function buildTenantList(
  me: Pick<Me, "role" | "tenants"> | undefined,
  allTenants: readonly Tenant[] | undefined,
): SessionTenant[] {
  if (!me) {
    return [];
  }
  if (me.role === "provider_admin" && allTenants) {
    return allTenants.map((tenant) => {
      const membership = me.tenants.find((candidate) => candidate.id === tenant.id);
      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        kind: kindOf(tenant),
        customerNumber: customerNumberOf(tenant),
        role: membership?.role ?? "tenant_admin",
        status: statusOf(tenant),
      };
    });
  }
  return me.tenants.map((tenant) => ({
    ...tenant,
    kind: kindOf(tenant),
    customerNumber: customerNumberOf(tenant),
    status: statusOf(tenant),
  }));
}

/**
 * The version block of `/api/v1/me`, read defensively: a server from before
 * the field existed simply reports no version.
 */
export function readRunningVersion(me: unknown): RunningVersion | null {
  const raw = typeof me === "object" && me !== null ? (me as { version?: unknown }).version : null;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const version = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
  return {
    running: text(version.running),
    commit: text(version.commit),
    latest: text(version.latest),
    updateAvailable: version.updateAvailable === true,
    releaseUrl: text(version.releaseUrl),
  };
}

/**
 * The gated features of `/api/v1/me`, read defensively: unknown ids are
 * dropped and a server from before the field existed enables none.
 */
export function readFeatures(me: unknown): GatedFeature[] {
  const raw =
    typeof me === "object" && me !== null ? (me as { features?: unknown }).features : null;
  if (!Array.isArray(raw)) {
    return [];
  }
  return GATED_FEATURES.filter((feature) => raw.includes(feature));
}

/** The extension fields of `/api/v1/me`; an empty record when there are none. */
export function readExtensions(me: unknown): Readonly<Record<string, unknown>> {
  const raw =
    typeof me === "object" && me !== null ? (me as { extensions?: unknown }).extensions : null;
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** Whether the installation enables a gated core feature (false while the profile loads). */
export function hasFeature(
  session: Pick<SessionContextValue, "features">,
  feature: GatedFeature,
): boolean {
  return session.features?.includes(feature) ?? false;
}

/** What the shell derives from the profile and the tenant choice. */
export interface TenantView {
  tenants: SessionTenant[];
  activeTenant: SessionTenant | null;
  role: Role | null;
  isProviderAdmin: boolean;
}

/**
 * Tenant list, active tenant and the role that applies in it, from the
 * profile, the provider's tenant list and the ids in order of preference
 * (explicit choice, remembered choice, server hint).
 */
export function resolveTenantView(
  me: Pick<Me, "role" | "tenants"> | undefined,
  allTenants: readonly Tenant[] | undefined,
  preferred: readonly (string | null | undefined)[],
): TenantView {
  const isProviderAdmin = me?.role === "provider_admin";
  const tenants = buildTenantList(me, allTenants);
  const activeTenant = pickActiveTenant(tenants, preferred, (tenant) =>
    canEnterTenant(tenant.status, isProviderAdmin),
  );
  return {
    tenants,
    activeTenant,
    role: me ? roleInActiveTenant(isProviderAdmin, activeTenant) : null,
    isProviderAdmin,
  };
}

/**
 * Whether "All tenants" is on offer: a provider admin whose team role covers every tenant, on
 * an installation that manages tenants (the Service Provider capabilities `tenants.additional`
 * and `dashboard.allTenants`), with more than one tenant to look across. Community and Business
 * have one organisation and never show it.
 */
export function canViewAllTenants(input: {
  isProviderAdmin: boolean;
  providerAllTenants: boolean;
  features: readonly GatedFeature[] | null;
  tenantCount: number;
}): boolean {
  return (
    input.isProviderAdmin &&
    input.providerAllTenants &&
    (input.features?.includes("tenants.additional") ?? false) &&
    (input.features?.includes("dashboard.allTenants") ?? false) &&
    input.tenantCount > 1
  );
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  const hasSession = session.data !== null && session.data !== undefined;

  // While signing out the better-auth store still holds the old session for
  // a moment; suspending the profile queries keeps them from refetching into
  // a 401. The flag clears once a new session shows up.
  const [suspended, setSuspended] = React.useState(false);
  React.useEffect(() => {
    if (hasSession) {
      setSuspended(false);
    }
  }, [hasSession]);
  // A password-only session may only enrol its authenticator; the API refuses
  // it everything else, so there is no profile to load yet. The demo account
  // (deploy/demo/README.md) is the one exception (lib/second-factor.ts).
  const setupState = useQuery(setupStateQueryOptions);
  const enrolling = session.data
    ? requiresAuthenticatorEnrollment(session.data, setupState.data?.demo)
    : false;
  const profileEnabled = hasSession && !suspended && !enrolling;

  const me = useQuery({ ...meQueryOptions, enabled: profileEnabled });
  const isProviderAdmin = me.data?.role === "provider_admin";

  const allTenants = useQuery({
    queryKey: queryKeys.tenants,
    queryFn: fetchTenants,
    enabled: profileEnabled && isProviderAdmin,
    staleTime: 60_000,
  });

  // The user's explicit choice in this page load; server hint and the
  // remembered tenant only apply until they pick one.
  const [selectedTenantId, setSelectedTenantId] = React.useState<string | null>(null);
  // Whether the user asked for the view across all tenants; remembered per browser like the tenant.
  const [wantsAllScope, setWantsAllScope] = React.useState(() => readRememberedScope() === "all");

  const view = React.useMemo(
    () =>
      // The browser's remembered choice beats the server hint: the switcher
      // never writes back to the server, so the hint is only a first default.
      resolveTenantView(me.data, allTenants.data, [
        selectedTenantId,
        readRememberedTenantId(),
        me.data?.activeTenantId,
      ]),
    [me.data, allTenants.data, selectedTenantId],
  );

  // Publish the active tenant for `apiFetch` before dependent queries run
  // (and remember it; a null while the profile loads forgets nothing).
  const activeTenantId = view.activeTenant?.id ?? null;
  React.useLayoutEffect(() => {
    setActiveTenantId(activeTenantId);
  }, [activeTenantId]);

  const setActiveTenant = React.useCallback(
    (tenantId: string) => {
      setSelectedTenantId(tenantId);
      setActiveTenantId(tenantId);
      // Choosing a tenant leaves "All tenants".
      setWantsAllScope(false);
      rememberScope("tenant");
      // Everything tenant-scoped must be re-read; auth and setup state are not.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== "auth" && query.queryKey[0] !== "setup",
      });
    },
    [queryClient],
  );

  const setScopeAll = React.useCallback(() => {
    setWantsAllScope(true);
    rememberScope("all");
  }, []);

  const signOut = React.useCallback(async () => {
    setSuspended(true);
    // In-flight tenant queries would answer 401 after the cookie is gone;
    // cancel them so the "session expired" path is never triggered here.
    await queryClient.cancelQueries();
    await authClient.signOut();
    setSelectedTenantId(null);
    setWantsAllScope(false);
    forgetActiveTenant();
    queryClient.clear();
  }, [queryClient]);

  const refresh = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.authSession });
    await session.refetch();
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [queryClient, session]);

  const status = deriveStatus(session, me);
  const version = React.useMemo(() => readRunningVersion(me.data), [me.data]);
  const features = React.useMemo(() => (me.data ? readFeatures(me.data) : null), [me.data]);
  const extensions = React.useMemo(() => (me.data ? readExtensions(me.data) : null), [me.data]);
  const providerAllTenants = isProviderAdmin ? (me.data?.provider?.allTenants ?? true) : false;
  const canViewAll = canViewAllTenants({
    isProviderAdmin,
    providerAllTenants,
    features,
    tenantCount: view.tenants.length,
  });
  const scope: SessionScope = wantsAllScope && canViewAll ? "all" : "tenant";

  const value = React.useMemo<SessionContextValue>(
    () => ({
      status,
      user: me.data?.user ?? null,
      role: view.role,
      features,
      extensions,
      isProviderAdmin,
      providerRole: isProviderAdmin ? (me.data?.provider?.role ?? "owner") : null,
      providerAllTenants,
      tenants: view.tenants,
      activeTenant: view.activeTenant,
      setActiveTenant,
      scope,
      canViewAllTenants: canViewAll,
      setScopeAll,
      version,
      signOut,
      refresh,
      error: session.error ?? me.error ?? null,
    }),
    [
      status,
      me.data,
      me.error,
      session.error,
      isProviderAdmin,
      view,
      setActiveTenant,
      scope,
      canViewAll,
      providerAllTenants,
      setScopeAll,
      version,
      features,
      extensions,
      signOut,
      refresh,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/**
 * A fixed session value, for static renders (tests, previews) of components
 * that read the session; the app uses {@link SessionProvider}.
 */
export function StaticSessionProvider({
  value,
  children,
}: {
  value: SessionContextValue;
  children: React.ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = React.useContext(SessionContext);
  if (context === null) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return context;
}

/**
 * What the session works on: `all` while "All tenants" is chosen, else `tenant`. A plain
 * function over the session value (not a hook), so that it keeps working where a test
 * replaces `useSession`.
 */
export function sessionScope(session: Pick<SessionContextValue, "scope">): SessionScope {
  return session.scope ?? "tenant";
}

/** Whether the installation enables a gated core feature (see {@link hasFeature}). */
export function useHasFeature(feature: GatedFeature): boolean {
  return hasFeature(useSession(), feature);
}

/** True when the role in the active tenant is one of `allowed` (or `allowed` is empty). */
export function useHasRole(allowed: readonly string[] | undefined): boolean {
  const { role } = useSession();
  return canAccess(role, allowed);
}

/** Pure role check shared by the sidebar, the palette, route guards and `useHasRole`. */
export function canAccess(role: string | null, allowed: readonly string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) {
    return true;
  }
  return role !== null && allowed.includes(role);
}
