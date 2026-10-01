import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

/*
 * `success` is green and green means proof (brand guide, section 4): a passed
 * restore check, a completed restore, an intact storage or hash chain check.
 * A state that merely is fine (protected, active, online, completed backup) is
 * the `outline` variant (see StatusBadge's `neutral` tone).
 *
 * Status variants (success, warning, destructive, info) use a 15 % tint of the
 * tone (20 % for the lighter amber of warning) with its text-safe `-text`
 * token, which keeps the label at 4.5:1 or
 * better in light and dark (enforced by tokens.test.ts, which reads the tint
 * alphas from this file). Pair a status badge with an icon or a word, never
 * colour alone.
 *
 * Unlike the registry badge, the label is never clipped: there is no
 * `overflow-hidden` and no `whitespace-nowrap`, so a long status label wraps
 * inside a narrow container instead of losing its end (a status such as "3
 * objects with failed items" must stay readable). The badge inherits
 * `white-space` from its context, so a column that says `whitespace-nowrap`
 * keeps its badges on one line.
 *
 * The corner radius is half the one-line height (1rem line, 0.25rem padding,
 * 2px border) instead of `rounded-full`: a one-line badge is the same pill,
 * and a wrapped one becomes a rounded rectangle rather than a blob.
 */
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-[calc(0.625rem+1px)] border border-transparent px-2 py-0.5 text-xs font-medium transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        success: "bg-success/15 text-success-text",
        warning: "bg-warning/20 text-warning-text",
        destructive:
          "bg-destructive/15 text-destructive-text focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        info: "bg-info/15 text-info-text",
        muted: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Render the child element (a link, for example) with the badge styles instead. */
    asChild?: boolean;
  };

function Badge({ className, variant = "default", asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants, type BadgeProps };
