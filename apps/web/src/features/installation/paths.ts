import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of the installation page. Feature routes join the router at runtime
 * and are not part of the statically typed route tree, so the conversion to
 * the router's types happens here, once.
 */

export const INSTALLATION_PATH = "/installation";

/** The section the bare installation address leads to. */
export const DEFAULT_SECTION_ID = "server";

export function installationSectionPath(id: string): string {
  return `${INSTALLATION_PATH}/${id}`;
}

/** The installation page; it leads on to its first section. */
export function installationTo(): LinkProps["to"] {
  return INSTALLATION_PATH as LinkProps["to"];
}

/** A section of the installation page, for `<Link to>` and `navigate`. */
export function installationSectionTo(id: string): LinkProps["to"] {
  return installationSectionPath(id) as LinkProps["to"];
}
