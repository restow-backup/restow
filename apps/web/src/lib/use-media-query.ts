import * as React from "react";

/**
 * Tracks a CSS media query, e.g. to switch the explorer's details panel between column and sheet,
 * or the selection panel of the protected objects between the section column and a bottom bar.
 * False on the server and before hydration.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
