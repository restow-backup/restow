import { ChevronDown } from "lucide-react";
import * as React from "react";

import { SidebarGroup, SidebarGroupLabel } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * A sidebar section whose header opens and closes it (#56). Open and closed
 * is remembered per browser in localStorage. Storage can be missing or throw
 * (private mode, blocked site data, quota), so every access is guarded: a
 * failure means "open", never a crash.
 */

/** The part of the Storage API used here (injectable for tests). */
export type SectionStorage = Pick<Storage, "getItem" | "setItem">;

export function navSectionKey(id: string): string {
  return `restow.nav.${id}.open`;
}

/** `globalThis.localStorage`, or `null` where reading it is impossible or throws. */
function defaultStorage(): SectionStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether section `id` was left open; open unless it was explicitly closed. */
export function readSectionOpen(
  id: string,
  storage: SectionStorage | null = defaultStorage(),
): boolean {
  try {
    return storage?.getItem(navSectionKey(id)) !== "false";
  } catch {
    return true;
  }
}

/** Remember whether section `id` is open; silently does nothing when storage fails. */
export function writeSectionOpen(
  id: string,
  open: boolean,
  storage: SectionStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(navSectionKey(id), open ? "true" : "false");
  } catch {
    // The choice still applies until the page is reloaded.
  }
}

interface CollapsibleNavSectionProps {
  id: string;
  label: string;
  /**
   * The id of the current entry when it lies in this section, else null.
   * Navigating to an entry of the section opens it, so the current entry is
   * always visible; that opening is not remembered as the user's choice.
   */
  activeId: string | null;
  /**
   * Shows the content regardless of the remembered state and hides the
   * toggle: the icon-only sidebar has no section headers, only its entries.
   */
  forceOpen?: boolean;
  storage?: SectionStorage | null;
  children: React.ReactNode;
}

/**
 * Height and opacity animate together over 200 ms (a grid row from 0fr to
 * 1fr, so no height is measured and nothing jumps); with
 * `prefers-reduced-motion` the section opens and closes at once. A closed
 * section is `inert`, so its links leave the tab order and the
 * accessibility tree.
 */
export function CollapsibleNavSection({
  id,
  label,
  activeId,
  forceOpen = false,
  storage,
  children,
}: CollapsibleNavSectionProps) {
  const contentId = React.useId();
  const [open, setOpen] = React.useState(() => readSectionOpen(id, storage));

  React.useEffect(() => {
    if (activeId !== null) {
      setOpen(true);
    }
  }, [activeId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    writeSectionOpen(id, next, storage);
  };

  const shown = open || forceOpen;
  return (
    <SidebarGroup data-slot="nav-section" data-state={shown ? "open" : "closed"}>
      <SidebarGroupLabel asChild>
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={contentId}
          tabIndex={forceOpen ? -1 : undefined}
          onClick={toggle}
          className="w-full cursor-pointer justify-between text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:pointer-events-none"
        >
          <span>{label}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "transition-transform duration-200 ease-out motion-reduce:transition-none",
              !shown && "-rotate-90",
            )}
          />
        </button>
      </SidebarGroupLabel>
      <div
        id={contentId}
        data-slot="nav-section-content"
        inert={!shown}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </SidebarGroup>
  );
}
