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

export interface VerifySearch {
  state?: ReadinessState;
  /** `all`: the tenants that have objects in `state`, instead of one tenant's objects. */
  scope?: "all";
}

export function isReadinessState(value: unknown): value is ReadinessState {
  return typeof value === "string" && (READINESS_STATES as readonly string[]).includes(value);
}

/** The search of the route: only known values survive, so a mistyped link shows everything. */
export function parseVerifySearch(search: Record<string, unknown>): VerifySearch {
  return {
    ...(isReadinessState(search.state) ? { state: search.state } : {}),
    ...(search.scope === "all" ? { scope: "all" as const } : {}),
  };
}

/** A link (or `navigate` target) to Recovery readiness, filtered to a state. */
export function verifyLink(
  state?: ReadinessState,
  scope?: "all",
): { to: LinkProps["to"]; search: never } {
  return {
    to: VERIFY_PATH as LinkProps["to"],
    // Feature routes join the router at runtime: the static typing cannot know their search.
    search: { ...(state ? { state } : {}), ...(scope ? { scope } : {}) } as never,
  };
}
