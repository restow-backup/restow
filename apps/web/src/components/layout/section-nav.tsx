import { Link, type LinkProps, useNavigate } from "@tanstack/react-router";
import { Lock, type LucideIcon } from "lucide-react";

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

function ColumnNav({ items, activeId, label }: SectionNavProps) {
  return (
    <nav aria-label={label} className="hidden lg:block">
      <ul className="sticky top-20 space-y-0.5">
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
                className={cn(
                  base,
                  "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
                  active &&
                    "bg-sidebar-accent font-medium text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon aria-hidden="true" />
                <span className="flex-1">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
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
