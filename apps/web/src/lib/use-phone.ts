import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { setupStateQueryOptions } from "./api";
import { isPhone, PHONE_INPUT_QUERY } from "./device";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const media = window.matchMedia(PHONE_INPUT_QUERY);
  media.addEventListener("change", onChange);
  // A foldable that opens up keeps its pointer but gains screen size; the snapshot is a
  // boolean, so the extra checks cost no re-render.
  window.addEventListener("resize", onChange);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
  };
}

/** Whether this device is a phone, re-checked when the input device or the screen changes. */
export function useIsPhone(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => isPhone(),
    () => false,
  );
}

/**
 * Whether this installation is the public demo, which the phone block leaves alone. Reads what
 * the root guard has loaded already (routes/tree.ts) and never fetches on its own.
 */
export function useIsDemo(): boolean {
  return useQuery({ ...setupStateQueryOptions, enabled: false }).data?.demo?.enabled === true;
}

/**
 * Whether the phone block applies to this visitor: a phone, except on the
 * public demo. Pages that stay reachable on a phone use it to keep the
 * visitor off the sign-in, which the block would hide.
 */
export function usePhoneBlocked(): boolean {
  const phone = useIsPhone();
  const demo = useIsDemo();
  return phone && !demo;
}
