import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "cn";
import type * as React from "react";

/*
 * Status variants use a 10 % tint of the tone; icon and title take the tone's
 * text-safe `-text` token (4.5:1 or better, enforced by tokens.test.ts, which
 * reads the tint alphas from this file) and the description stays in the
 * foreground colour for long-form reading.
 */
const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        info: "border-info/30 bg-info/10 text-info-text *:data-[slot=alert-description]:text-foreground",
        success:
          "border-success/30 bg-success/10 text-success-text *:data-[slot=alert-description]:text-foreground",
        warning:
          "border-warning/40 bg-warning/10 text-warning-text *:data-[slot=alert-description]:text-foreground",
        destructive:
          "border-destructive/30 bg-destructive/10 text-destructive-text *:data-[slot=alert-description]:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>;

/**
 * Only problems interrupt a screen reader: destructive and warning alerts are
 * live `role="alert"` regions, informational ones are plain content. Pass
 * `role` explicitly to override.
 */
const INTERRUPTING: ReadonlySet<AlertVariant> = new Set(["destructive", "warning"]);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant ?? "default"}
      role={variant && INTERRUPTING.has(variant) ? "alert" : undefined}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  // No line clamp: an alert title is never truncated.
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
