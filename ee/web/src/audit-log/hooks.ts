import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatDateTime, formatInteger, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import {
  type AuditPage,
  auditKeys,
  fetchAuditActions,
  fetchAuditEntries,
  fetchAuditEntry,
  fetchChainVerification,
} from "./api";
import { AUDIT_NAMESPACE } from "./i18n";
import { actionLabelKey, formatAnchorDate, formatDuration } from "./presenters";
import {
  AUDIT_PATH,
  type AuditSearch,
  FILTER_KEYS,
  nextAuditSearch,
  parseAuditSearch,
  toAuditQuery,
} from "./search";

/**
 * Data and URL hooks of the audit page. Provider admins read the whole
 * installation; everyone else reads their active tenant, which is why the
 * active tenant is part of every query key.
 */

export type AuditAccess =
  | { kind: "provider" }
  | { kind: "tenant"; tenantId: string; tenantName: string }
  | { kind: "noTenant" }
  | { kind: "notAdmin"; tenantName: string }
  | { kind: "loading" };

/** What the signed-in user may read here, from the session. */
export function useAuditAccess(): AuditAccess {
  const { status, isProviderAdmin, activeTenant } = useSession();
  if (status !== "authenticated") {
    return { kind: "loading" };
  }
  if (isProviderAdmin) {
    return { kind: "provider" };
  }
  if (!activeTenant) {
    return { kind: "noTenant" };
  }
  if (activeTenant.role !== "tenant_admin") {
    return { kind: "notAdmin", tenantName: activeTenant.name };
  }
  return { kind: "tenant", tenantId: activeTenant.id, tenantName: activeTenant.name };
}

/** Cache scope of the requester; null while nothing may be read. */
export function scopeKeyOf(access: AuditAccess): string | null {
  if (access.kind === "provider") {
    return "provider";
  }
  return access.kind === "tenant" ? `tenant:${access.tenantId}` : null;
}

/**
 * The URL state and a setter that writes it back. `path` is the address the
 * log lives at: the audit page itself, or the audit section of a tenant's page,
 * where the filters are kept in the same way.
 */
export function useAuditSearch(path: string = AUDIT_PATH) {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = React.useMemo(() => parseAuditSearch(raw), [raw]);
  const navigate = useNavigate();
  const update = React.useCallback(
    (change: Partial<AuditSearch>) => {
      const typing = "actor" in change || "target" in change;
      void navigate({
        to: path as never,
        search: nextAuditSearch(search, change) as never,
        // Typing into a search box should not flood the history.
        replace: typing,
      });
    },
    [navigate, path, search],
  );
  const clearFilters = React.useCallback(
    () => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined]))),
    [update],
  );
  return { search, update, clearFilters };
}

export function useAuditEntries(access: AuditAccess, search: AuditSearch) {
  const scope = scopeKeyOf(access);
  const query = toAuditQuery(search, access.kind === "provider");
  const list = useInfiniteQuery({
    queryKey: auditKeys.entries(scope ?? "none", query),
    queryFn: ({ pageParam }) => fetchAuditEntries(query, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last: AuditPage) => last.next,
    enabled: scope !== null,
  });
  const entries = React.useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );
  return { list, entries };
}

/** One entry for the drawer; skipped when the loaded list already has it. */
export function useAuditEntry(access: AuditAccess, entryId: string | undefined, known: boolean) {
  const scope = scopeKeyOf(access);
  return useQuery({
    queryKey: auditKeys.entry(scope ?? "none", entryId ?? ""),
    queryFn: () => fetchAuditEntry(entryId ?? ""),
    enabled: scope !== null && entryId !== undefined && !known,
    retry: false,
  });
}

export function useAuditActions(access: AuditAccess, tenant: string | undefined) {
  const scope = scopeKeyOf(access);
  const chain = access.kind === "provider" ? tenant : undefined;
  return useQuery({
    queryKey: auditKeys.actions(scope ?? "none", chain),
    queryFn: () => fetchAuditActions(chain),
    enabled: scope !== null,
    staleTime: 60_000,
  });
}

/**
 * The chain verification for the selected chains. A full walk is a real read
 * of the whole log, so a result is reused for a few minutes unless the
 * operator asks again.
 */
export function useChainVerification(access: AuditAccess, tenant: string | undefined) {
  const scope = scopeKeyOf(access);
  const chain = access.kind === "provider" ? tenant : undefined;
  return useQuery({
    queryKey: auditKeys.verification(scope ?? "none", chain),
    queryFn: () => fetchChainVerification(chain),
    enabled: scope !== null,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Locale-bound formatters and code labels shared by the audit components. */
export function useAuditFormat() {
  const { t, i18n } = useTranslation(AUDIT_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;

  return React.useMemo(() => {
    /** The translation of `key` when the namespace has a string there, else null. */
    const known = (key: string): string | null =>
      typeof i18n.getResource(language, AUDIT_NAMESPACE, key) === "string" ? t(key) : null;
    return {
      t,
      language,
      dateTime: (value: string) => formatDateTime(value, language) ?? value,
      relative: (value: string) => formatRelative(value, language) ?? value,
      integer: (value: number) => formatInteger(value, language),
      duration: (milliseconds: number) => formatDuration(milliseconds, language),
      anchorDate: (day: string) => formatAnchorDate(day, language),
      /** The action's label, or null for codes this version does not know. */
      actionLabel: (action: string) => known(actionLabelKey(action)),
      categoryLabel: (category: string) => known(`categories.${category}`) ?? category,
      targetTypeLabel: (type: string) => known(`targetTypes.${type}`) ?? type,
    };
  }, [t, i18n, language]);
}

export type AuditFormat = ReturnType<typeof useAuditFormat>;
