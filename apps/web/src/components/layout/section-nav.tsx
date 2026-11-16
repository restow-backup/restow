import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import { Lock, type LucideIcon } from "lucide-react";
import * as React from "react";

import { UpdateDot } from "@/components/layout/update-dot";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** The router marks active links itself; exact only, so it never contradicts ours. */
const EXACT_MATCH = { exact: true, includeSearch: true } as const;

/** The aside slot's distance to the bottom of the viewport while it sticks (`bottom-6`). */
const ASIDE_BOTTOM_PX = 24;
/** The links keep at least this much height beside a panel, however short the viewport. */
const MIN_LINKS_PX = 120;

/** Where a locked section leads, and why it is locked (already translated). */
export interface SectionNavLock {
  to: string;
  search?: Readonly<Record<string, string>>;
  hint: string;
}

/** One entry of a section sub-navigation, with its texts already translated. */
export interface SectionNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Absolute app path of the section. */
  to: string;
  /** Set while an extension's lock holds the section closed: it stays in the list, greyed out. */
  locked?: SectionNavLock;
  /**
   * Set while an update is available for what the section shows ("Update to 0.4.9 available",
   * already translated): the entry gets the update dot, and the words are its text for
   * assistive technology and its tooltip.
   */
  updateLabel?: string;
}

interface SectionNavProps {
  items: readonly SectionNavItem[];
  activeId: string;
  /** Accessible name of the column of links. */
  label: string;
  /** Label of the select shown instead of the column on small screens. */
  selectLabel: string;
  /** Unique id of the select (a page can show one sub-navigation only, but ids must not collide with tests). */
  selectId: string;
  /**
   * Receives the slot at the bottom of the column (see `section-aside.tsx`), where a section can
   * show a small panel in the free space below the links. Without it the column has no slot.
   */
  asideRef?: (slot: HTMLElement | null) => void;
}

/**
 * The sub-navigation of a page that is split into sections with an address
 * each (the installation page, the tenant page). From the large breakpoint on
 * it is a column of links beside the content, with the active section tinted
 * like the active menu entry; below it, where a column would take the width
 * the content needs, a select above the content holds the same sections. A
 * section an extension locked stays in the list, greyed out with a lock, and
 * leads where its lock says (the same rule as a locked menu entry).
 */
export function SectionNav(props: SectionNavProps) {
  return (
    <>
      <ColumnNav {...props} />
      <SelectNav {...props} />
    </>
  );
}

/*
 * The column is as high as the grid row beside it. The links stick below the shell header; the
 * aside slot sits at the bottom of the column (`mt-auto`) and sticks to the bottom of the
 * viewport while the row runs past it, so a panel in it is in view at once, in the space the
 * links leave free. While the slot holds a panel, the links get only the room between their top
 * (stuck or not yet) and the panel, and scroll inside it on a short viewport: they never run
 * under the panel, and the column never makes the page longer than the content does. An empty
 * slot takes no space and changes nothing. The slot is outside the `<nav>`: what it holds is not
 * navigation.
 */
function ColumnNav({ items, activeId, label, asideRef }: SectionNavProps) {
  const listRef = React.useRef<HTMLUListElement>(null);
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  const slotRef = React.useCallback(
    (element: HTMLElement | null) => {
      setSlot(element);
      asideRef?.(element);
    },
    [asideRef],
  );
  React.useEffect(() => {
    const list = listRef.current;
    if (!slot || !list || typeof ResizeObserver === "undefined") {
      return;
    }
    let frame = 0;
    const fit = () => {
      frame = 0;
      // The slot's height includes its top padding, the gap to the links.
      const room = slot.offsetHeight;
      if (room === 0) {
        list.style.removeProperty("max-height");
        return;
      }
      const top = list.getBoundingClientRect().top;
      const free = window.innerHeight - top - room - ASIDE_BOTTOM_PX;
      list.style.maxHeight = `${Math.max(MIN_LINKS_PX, Math.floor(free))}px`;
      markClipped();
    };
    // Links cut off below fade out, so the list shows that it scrolls.
    const markClipped = () => {
      const clipped = list.scrollHeight - list.scrollTop - list.clientHeight > 1;
      list.toggleAttribute("data-clipped", clipped);
    };
    const schedule = () => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(fit);
      }
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(slot);
    window.addEventListener("scroll", schedule, { passive: true });
    list.addEventListener("scroll", markClipped, { passive: true });
    window.addEventListener("resize", schedule);
    fit();
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      list.removeEventListener("scroll", markClipped);
      list.removeAttribute("data-clipped");
      window.removeEventListener("resize", schedule);
      window.cancelAnimationFrame(frame);
      list.style.removeProperty("max-height");
    };
  }, [slot]);

  return (
    <div className="hidden lg:flex lg:flex-col" data-slot="section-column">
      <nav aria-label={label} className="sticky top-[calc(var(--shell-header-height)+1.5rem)]">
        <ul
          ref={listRef}
          className="-m-1 space-y-0.5 overflow-y-auto p-1 data-[clipped]:[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]"
        >
          {items.map((item) => {
            const Icon = item.icon;
            const active = item.id === activeId;
            const base =
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>svg]:size-4 [&>svg]:shrink-0";
            if (item.locked) {
              return (
                <li key={item.id}>
                  <Link
                    to={item.locked.to as LinkProps["to"]}
                    search={item.locked.search as never}
                    data-locked="true"
                    aria-current={active ? "page" : undefined}
                    title={`${item.label} — ${item.locked.hint}`}
                    className={cn(
                      base,
                      "text-muted-foreground/70 hover:bg-sidebar-hover",
                      active && "bg-sidebar-hover",
                    )}
                  >
                    <Icon aria-hidden="true" />
                    <span className="flex-1">{item.label}</span>
                    <Lock aria-hidden="true" className="ml-auto size-3.5" />
                    <span className="sr-only">{`, ${item.locked.hint}`}</span>
                  </Link>
                </li>
              );
            }
            return (
              <li key={item.id}>
                <Link
                  to={item.to as LinkProps["to"]}
                  activeOptions={EXACT_MATCH}
                  aria-current={active ? "page" : undefined}
                  title={item.updateLabel}
                  className={cn(
                    base,
                    "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
                    active &&
                      "bg-sidebar-accent font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}
                >
                  <Icon aria-hidden="true" />
                  <span className="flex-1">
                    {item.label}
                    {item.updateLabel ? (
                      <span className="sr-only">{`, ${item.updateLabel}`}</span>
                    ) : null}
                  </span>
                  {item.updateLabel ? <UpdateDot /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {asideRef ? (
        <div
          ref={slotRef}
          data-slot="section-aside"
          className="sticky bottom-6 z-10 mt-auto shrink-0 pt-4 empty:hidden"
        />
      ) : null}
    </div>
  );
}

function SelectNav({ items, activeId, selectLabel, selectId }: SectionNavProps) {
  const navigate = useNavigate();

  const open = (id: string) => {
    const target = items.find((item) => item.id === id);
    if (!target) {
      return;
    }
    if (target.locked) {
      void navigate({
        to: target.locked.to as LinkProps["to"],
        search: target.locked.search as never,
      });
      return;
    }
    void navigate({ to: target.to as LinkProps["to"] });
  };

  return (
    <div className="space-y-1.5 lg:hidden">
      <Label htmlFor={selectId}>{selectLabel}</Label>
      <Select value={activeId} onValueChange={open}>
        <SelectTrigger id={selectId} className="w-full sm:max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <SelectItem key={item.id} value={item.id}>
                <Icon aria-hidden="true" />
                {item.label}
                {item.updateLabel ? <UpdateDot className="ml-auto" /> : null}
                {item.updateLabel ? (
                  <span className="sr-only">{`, ${item.updateLabel}`}</span>
                ) : null}
                {item.locked ? <Lock aria-hidden="true" className="ml-auto size-3.5" /> : null}
                {item.locked ? <span className="sr-only">{`, ${item.locked.hint}`}</span> : null}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
