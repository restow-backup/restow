import { cn } from "cn";
import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Classes of the overlay that holds a dialog's content. The overlay, not the
 * content, is the fixed layer: it spans the viewport from its top edge and is
 * never higher than the viewport (`100dvh`, `100vh` where `dvh` is unknown),
 * even where the page instead of the viewport ends up as the reference of
 * fixed elements (a filter or transform on <body> from an extension or user
 * style). It centres the content with auto margins, so a dialog never hangs
 * off the bottom of the screen, and a dialog taller than the viewport starts
 * at its top edge instead of being cut off above it. The overlay scrolls as a
 * last resort; the content itself is capped at the overlay's height.
 */
const DIALOG_LAYER =
  "flex max-h-screen overflow-y-auto overscroll-contain p-4 supports-[height:100dvh]:max-h-dvh";

/**
 * Classes of a dialog's content box: centred in its overlay, never taller than
 * the viewport less 2rem, scrolling inside (mouse wheel, touch, keyboard) with
 * its header and footer kept in view (DialogHeader, DialogFooter).
 */
const DIALOG_BOX =
  "relative m-auto max-h-full w-full overflow-y-auto overscroll-contain bg-background";

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <DialogPortal data-slot="dialog-portal">
      {/* The content inside its overlay (Radix "scrollable overlay"): the wheel scrolls it. */}
      <DialogOverlay className={DIALOG_LAYER}>
        <DialogPrimitive.Content
          data-slot="dialog-content"
          // Width: `w-full max-w-lg` inside the overlay's 1rem padding, so a
          // caller's plain `max-w-2xl` widens the dialog on every breakpoint.
          className={cn(
            DIALOG_BOX,
            "grid max-w-lg gap-4 rounded-lg border p-6 shadow-lg duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="absolute top-4 right-4 z-20 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <XIcon />
              <span className="sr-only">{t("actions.close")}</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogOverlay>
    </DialogPortal>
  );
}

/**
 * Header and footer of a dialog box that scrolls stay in view: the header at
 * the top, the footer with the buttons at the bottom, each on the dialog's
 * background over the content scrolling past (a visible header only; a
 * screen-reader-only one keeps `sr-only`). Both reach into the box's 1.5rem
 * padding (negative margin, matching padding) and stick 1.5rem past the
 * padding edge, where a sticky box stops, so nothing scrolls into view above
 * the header or below the footer.
 */
const STICKY_HEADER = [
  "[&:not(.sr-only)]:sticky [&:not(.sr-only)]:-top-6 [&:not(.sr-only)]:z-10 [&:not(.sr-only)]:-mt-6 [&:not(.sr-only)]:bg-background [&:not(.sr-only)]:pt-6",
  // A short fade under the header softens the edge content scrolls under; over the gap below
  // the header, where nothing is, it does not show.
  "[&:not(.sr-only)]:after:pointer-events-none [&:not(.sr-only)]:after:absolute [&:not(.sr-only)]:after:inset-x-0 [&:not(.sr-only)]:after:top-full [&:not(.sr-only)]:after:h-3 [&:not(.sr-only)]:after:bg-linear-to-b [&:not(.sr-only)]:after:from-background [&:not(.sr-only)]:after:to-transparent",
].join(" ");
const STICKY_FOOTER = [
  "sticky -bottom-6 z-10 -mb-6 bg-background pb-6",
  "before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-3 before:bg-linear-to-t before:from-background before:to-transparent",
].join(" ");

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", STICKY_HEADER, className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        STICKY_FOOTER,
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">{t("actions.close")}</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  DIALOG_BOX,
  DIALOG_LAYER,
  STICKY_FOOTER,
  STICKY_HEADER,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
