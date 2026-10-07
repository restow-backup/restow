import type { LinkProps } from "@tanstack/react-router";

/** The warnings page (`/warnings`, `?state=acknowledged` for the acknowledged tab). */
export const WARNINGS_PATH = "/warnings";

export function warningsTo(): LinkProps["to"] {
  return WARNINGS_PATH as LinkProps["to"];
}

/** The tab the address asks for; anything else is the open warnings. */
export function parseWarningsSearch(search: Record<string, unknown>): {
  state: "open" | "acknowledged";
} {
  return { state: search.state === "acknowledged" ? "acknowledged" : "open" };
}
