import type { LinkProps } from "@tanstack/react-router";

import { ACCOUNT_PATH } from "@/lib/entry";

export { ACCOUNT_PATH };

/**
 * Paths of the settings feature. Feature routes join the router at
 * integration time and are not part of the statically typed route tree, so the
 * conversion to the router's types happens here, once. The installation
 * settings have their own paths (features/installation/paths.ts).
 */

/** The account page with the signed-in person's own sign-in security. */
export function accountTo(): LinkProps["to"] {
  return ACCOUNT_PATH as LinkProps["to"];
}
