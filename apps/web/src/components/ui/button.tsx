import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "cn";
import { Loader2Icon } from "lucide-react";
import { Slot } from "radix-ui";
import * as React from "react";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (a link, for example) with the button styles instead. */
    asChild?: boolean;
    /**
     * Busy state: disables the button, sets aria-busy and shows a spinner in
     * place of the leading icon (or before the label when there is none).
     */
    loading?: boolean;
  };

/**
 * A leading icon is an <svg> or a component element without children, which
 * is how lucide icons are written (`<Save />`). Text and wrapper elements
 * (`<span>…</span>`) are never treated as icons.
 */
function isIconElement(node: React.ReactNode): boolean {
  if (!React.isValidElement(node)) {
    return false;
  }
  if (node.type === "svg") {
    return true;
  }
  const props = node.props as { children?: unknown };
  return typeof node.type !== "string" && props.children === undefined;
}

function withSpinner(children: React.ReactNode): React.ReactNode[] {
  const items = React.Children.toArray(children);
  const spinner = (
    <Loader2Icon key="spinner" data-slot="spinner" aria-hidden="true" className="animate-spin" />
  );
  return isIconElement(items[0]) ? [spinner, ...items.slice(1)] : [spinner, ...items];
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  type,
  children,
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size, className }));

  if (asChild) {
    // Slot needs exactly one child, so no spinner here; the busy state is still exposed.
    return (
      <Slot.Root
        data-slot="button"
        data-variant={variant}
        data-size={size}
        aria-busy={loading || undefined}
        aria-disabled={disabled || loading || undefined}
        className={classes}
        {...props}
      >
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-size={size}
      // Buttons never submit a surrounding form by accident; submit buttons say so.
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...props}
    >
      {loading ? withSpinner(children) : children}
    </button>
  );
}

export { Button, buttonVariants, type ButtonProps };
