import { type RunningVersion, type SessionContextValue, useSession } from "@/lib/session";

/**
 * A newer release than the one that runs, for the people who see the Updates section: the dots
 * beside the version, the installation entry and the section list, and the banner above the top
 * bar. Only provider administrators; tenant users never see where an update would be installed.
 */

export interface AvailableUpdate {
  /** The newest release's version. */
  latest: string;
  running: string | null;
  releaseUrl: string | null;
}

type UpdateSession = Pick<SessionContextValue, "isProviderAdmin" | "version">;

/** The release to point at, or null when none is newer or the person may not see Updates. */
export function availableUpdateOf(session: UpdateSession): AvailableUpdate | null {
  return session.isProviderAdmin ? availableFrom(session.version) : null;
}

function availableFrom(version: RunningVersion | null): AvailableUpdate | null {
  if (!version?.updateAvailable || !version.latest) {
    return null;
  }
  return { latest: version.latest, running: version.running, releaseUrl: version.releaseUrl };
}

export function useAvailableUpdate(): AvailableUpdate | null {
  return availableUpdateOf(useSession());
}

// --- The banner's dismissal ---------------------------------------------------------------------------

const DISMISSED_PREFIX = "restow.update-banner.dismissed.";

/** Whether this browser closed the banner for exactly this version. */
export function isUpdateBannerDismissed(version: string): boolean {
  try {
    return window.localStorage.getItem(`${DISMISSED_PREFIX}${version}`) !== null;
  } catch {
    return false;
  }
}

/** Remember the closing for this version only: a newer release shows the banner again. */
export function dismissUpdateBanner(version: string): void {
  try {
    window.localStorage.setItem(`${DISMISSED_PREFIX}${version}`, "1");
  } catch {
    // Without storage the banner stays closed for this page load only.
  }
}
