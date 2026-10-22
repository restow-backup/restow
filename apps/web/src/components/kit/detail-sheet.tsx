import { X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { CopyButton } from "./copy-button.js";
import { UI_NAMESPACE } from "./i18n.js";

/**
 * The detail panel of a table row (0.4.3 for VMs & containers, 0.4.5 for Inventory and Jobs):
 * everything the row leaves out so it can stay one line. It slides in from the right, is opened
 * by clicking the row or its state badge (the address carries the open row, so a link opens it),
 * and closes with Esc or its close button; focus then goes back to where the row was opened.
 *
 * The parts: {@link DetailSheet} (the panel with its title), {@link DetailSection} (a titled
 * group), {@link DetailFact} (a label and its value, in a `<dl>`) and {@link LogBlock} (an error
 * or warning text as written: monospace, scrolling inside a fixed height, with a Copy button).
 */

export interface DetailSheetProps {
  /** Open while true. */
  open: boolean;
  onClose: () => void;
  /** The row's name; while the row is not known yet, a generic title. */
  title: string;
  /** One line under the title (kind, host, job); cut with an ellipsis. */
  description?: string;
  /** The row is still loading: skeletons instead of the body. */
  loading?: boolean;
  /** Shown instead of the body when the row does not exist (any more). */
  notFound?: React.ReactNode;
  /** Where focus goes when the panel closes (the name in the row). */
  returnFocus?: () => HTMLElement | null;
  /** `data-slot` of the panel, for tests and styles. */
  slot?: string;
  children?: React.ReactNode;
}

export function DetailSheet({
  open,
  onClose,
  title,
  description,
  loading = false,
  notFound,
  returnFocus,
  slot,
  children,
}: DetailSheetProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        hideClose
        data-slot={slot ?? "detail-sheet"}
        className="w-full gap-0 p-0 motion-reduce:animate-none motion-reduce:transition-none sm:w-[min(640px,96vw)] sm:max-w-none"
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <div className="flex items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[15.5px]">{title}</SheetTitle>
            <SheetDescription className="truncate text-xs">
              {description || (loading ? t("detail.loading") : " ")}
            </SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon" className="-mt-1 -mr-1 shrink-0">
              <X aria-hidden="true" />
              <span className="sr-only">{t("detail.close")}</span>
            </Button>
          </SheetClose>
        </div>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
          {loading ? (
            <div className="space-y-4" aria-busy="true">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : notFound ? (
            <p className="text-sm text-muted-foreground">{notFound}</p>
          ) : (
            children
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** A titled group of the panel. */
export function DetailSection({
  title,
  children,
  slot,
}: {
  title: string;
  children: React.ReactNode;
  slot?: string;
}) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} className="space-y-2" data-slot={slot}>
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A label and its value; put several in a `<dl className="space-y-1.5">`. */
export function DetailFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,40%)_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** A log text: monospace, kept as written, scrolls inside a fixed height, with a Copy button. */
export function LogBlock({
  text,
  tone = "muted",
  label,
  name,
  "data-slot": slot,
}: {
  text: string;
  tone?: "destructive" | "warning" | "muted";
  /** The Copy button's name ("Copy error"). */
  label: string;
  /** The scrolling block's name for screen readers ("Error of the last run"). */
  name: string;
  "data-slot"?: string;
}) {
  return (
    <section
      aria-label={name}
      className={cn(
        "relative rounded-md border",
        tone === "destructive" && "border-destructive/40 bg-destructive/5",
        tone === "warning" && "border-warning/50 bg-warning/5",
        tone === "muted" && "bg-muted/40",
      )}
      data-slot={slot ?? "log-block"}
    >
      <pre
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region the keyboard must reach
        tabIndex={0}
        className="max-h-60 overflow-auto p-3 pr-11 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {text}
      </pre>
      <CopyButton value={text} label={label} className="absolute top-1.5 right-1.5" />
    </section>
  );
}
