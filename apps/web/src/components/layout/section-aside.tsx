import * as React from "react";

/**
 * The free space at the bottom of a page's section column (SectionNav, from
 * the large breakpoint on): a slot a section can portal a small panel into,
 * such as the actions for the rows selected in its list. Null where the page
 * has no such column (another page, or below the large breakpoint the column
 * is hidden, which the section checks itself with a media query).
 */
const SectionAsideContext = React.createContext<HTMLElement | null>(null);

export function SectionAsideProvider({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: React.ReactNode;
}) {
  return <SectionAsideContext.Provider value={slot}>{children}</SectionAsideContext.Provider>;
}

/** The slot element of the section column, or null when there is none. */
export function useSectionAside(): HTMLElement | null {
  return React.useContext(SectionAsideContext);
}
