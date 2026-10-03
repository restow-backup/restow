import type { SetupItem, SetupWidget } from "@/features/dashboard/api";

/**
 * What the sidebar's Start entry decides without a browser: whether it shows,
 * how far the ring is filled, which items offer which button, and when the last
 * step has just been completed. Components only render the result.
 */

/** Roles that may see the entry: the admins of the tenant. End users never do. */
export const START_ROLES: readonly string[] = ["provider_admin", "tenant_admin"];

export function canSeeStart(role: string | null): boolean {
  return role !== null && START_ROLES.includes(role);
}

export interface StartView {
  done: number;
  total: number;
  /** 0..1, for the ring. */
  fraction: number;
}

/**
 * The entry exists while there is something left to do: nothing at all once every
 * step is done (or not needed), and nothing while the checklist is not known (it
 * would only flash).
 */
export function startView(setup: SetupWidget | null | undefined): StartView | null {
  if (!setup || setup.complete || setup.total === 0) {
    return null;
  }
  return {
    done: setup.done,
    total: setup.total,
    fraction: Math.max(0, Math.min(1, setup.done / setup.total)),
  };
}

/**
 * True when the checklist went from open to complete for the same tenant: the
 * moment of the one toast per session. Opening the app on a finished checklist,
 * or switching to a finished tenant, is no completion.
 */
export function justCompleted(
  previous: { tenantId: string | null; complete: boolean } | null,
  next: { tenantId: string | null; complete: boolean },
): boolean {
  return (
    previous !== null &&
    previous.tenantId === next.tenantId &&
    previous.tenantId !== null &&
    !previous.complete &&
    next.complete
  );
}

/** What the optional notification mail step offers next to its way to the page. */
export type NotNeededOffer = "mark" | "undo" | null;

/**
 * "Not needed" is offered on the mail step only: on an open or failing one to
 * mark it, on one that was marked to take the mark back. A step that is done, or
 * not needed because the setup skipped the mail, has nothing to decide.
 */
export function notNeededOffer(item: Pick<SetupItem, "id" | "state" | "reason">): NotNeededOffer {
  if (item.id !== "notificationMail") {
    return null;
  }
  if (item.state === "open" || item.state === "attention") {
    return "mark";
  }
  return item.state === "not_needed" && item.reason === "mail_marked" ? "undo" : null;
}

/** Items that are not settled yet come first in what a "next step" looks at. */
export function isSettled(item: Pick<SetupItem, "state">): boolean {
  return item.state === "done" || item.state === "not_needed";
}

/** The part of the Storage API the dismissal needs (injectable for tests). */
export type DismissStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Whoever does not want the guide can hide the Start entry for good, in every
 * tenant: an experienced admin sets things up from the pages directly. The choice
 * is remembered per user in this browser (like the column choices of the tables),
 * and the steps stay on each tenant's page ("Show setup steps").
 */
export function startDismissedKey(userId: string): string {
  return `restow.start.${userId}.dismissed`;
}

/** `globalThis.localStorage`, or `null` where reading it is impossible or throws. */
function defaultDismissStorage(): DismissStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether `userId` hid the Start entry; false when storage is missing or fails. */
export function readStartDismissed(
  userId: string,
  storage: DismissStorage | null = defaultDismissStorage(),
): boolean {
  try {
    return storage?.getItem(startDismissedKey(userId)) === "1";
  } catch {
    return false;
  }
}

/** Remember (or forget) that `userId` hid the Start entry; silently does nothing when storage fails. */
export function writeStartDismissed(
  userId: string,
  dismissed: boolean,
  storage: DismissStorage | null = defaultDismissStorage(),
): void {
  try {
    if (dismissed) {
      storage?.setItem(startDismissedKey(userId), "1");
    } else {
      storage?.removeItem(startDismissedKey(userId));
    }
  } catch {
    // The choice still applies until the page is reloaded.
  }
}
