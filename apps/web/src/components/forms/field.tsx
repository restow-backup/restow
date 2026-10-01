import type * as React from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface FieldProps {
  id: string;
  label: string;
  /** Translated validation message; rendered with `role="alert"` when set. */
  error?: string;
  /** Helper text shown when there is no error. */
  hint?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Label + control + message triplet. Wires `aria-describedby` for the hint
 * or error via the `${id}-message` convention; pass that id to the control.
 */
export function Field({ id, label, error, hint, className, children }: FieldProps) {
  const message = error ?? hint;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {message ? (
        <p
          id={messageId(id)}
          role={error ? "alert" : undefined}
          className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** Id of the message element `Field` renders for a control id. */
export function messageId(id: string): string {
  return `${id}-message`;
}
