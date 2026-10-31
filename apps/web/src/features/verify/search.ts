import type { LinkProps } from "@tanstack/react-router";

import { VERIFY_PATH } from "@/features/verify/paths";

/**
 * The address of Recovery readiness carries its filter: `/verify?state=red`
 * shows the objects in that state, `/verify?state=red&scope=all` the tenants
 * that have objects in it ("All tenants"). The links of the overview, of alert
 * mails and of the provider table all land here. The state names are those of
 * the API (`unverified`, `no_backup`), so a link reads the same everywhere.
 *
 * A leaf module (no feature imports): the dashboard builds its links with it.
 */

export const READINESS_STATES = ["green", "yellow", "red", "unverified", "no_backup"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/**
 * The extra filters of one tenant's table (0.4.9): `empty`, the objects an admin confirmed as
 * empty (grey), and `empty_unconfirmed`, the ones whose newest check found them empty that nobody
 * confirmed yet (yellow), where "Confirm as empty" acts on a selection. The provider view counts
 * neither apart, so they are not readiness states of the overview's links.
 */
export const EMPTY_FILTERS = ["empty_unconfirmed", "empty"] as const;
export type EmptyFilter = (typeof EMPTY_FILTERS)[number];
export type TableFilter = ReadinessState | EmptyFilter;

export interface VerifySearch {
  state?: TableFilter;
  /** `all`: the tenants that have objects in `state`, instead of one tenant's objects. */
  scope?: "all";
}

export function isReadinessState(value: unknown): value is ReadinessState {
  return typeof value === "string" && (READINESS_STATES as readonly string[]).includes(value);
}

export function isTableFilter(value: unknown): value is TableFilter {
  return (
    isReadinessState(value) ||
    (typeof value === "string" && (EMPTY_FILTERS as readonly string[]).includes(value))
  );
}

/** The search of the route: only known values survive, so a mistyped link shows everything. */
export function parseVerifySearch(search: Record<string, unknown>): VerifySearch {
  return {
    ...(isTableFilter(search.state) ? { state: search.state } : {}),
    ...(search.scope === "all" ? { scope: "all" as const } : {}),
  };
}

/** A link (or `navigate` target) to Recovery readiness, filtered to a state. */
export function verifyLink(
  state?: TableFilter,
  scope?: "all",
): { to: LinkProps["to"]; search: never } {
  return {
    to: VERIFY_PATH as LinkProps["to"],
    // Feature routes join the router at runtime: the static typing cannot know their search.
    search: { ...(state ? { state } : {}), ...(scope ? { scope } : {}) } as never,
  };
}
