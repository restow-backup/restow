import { Building2, type LucideIcon, Server, Shield } from "lucide-react";
import type * as React from "react";

import type { ScopeKind } from "@/components/layout/breadcrumb-trail";
import { cn } from "@/lib/utils";

/**
 * The level a page works on, as the first crumb of the header: the
 * installation (inverted: it is the operator's own level), the own
 * organisation and a tenant (a Lapis tint, the colour of "where you are"), or
 * all tenants (an outline). The icon repeats what the sidebar uses for the
 * same thing (the tenant switcher), so the pill and the switcher read as one.
 * The text always says the level in words; colour and icon only support it.
 */

const SCOPE_ICON: Readonly<Record<ScopeKind, LucideIcon>> = {
  installation: Server,
  all: Building2,
  internal: Shield,
  tenant: Building2,
  organisation: Building2,
};

const SCOPE_TONE: Readonly<Record<ScopeKind, string>> = {
  installation: "bg-foreground text-background",
  all: "border-border bg-card text-foreground",
  internal: "bg-info/15 text-info-text",
  tenant: "bg-info/15 text-info-text",
  organisation: "bg-info/15 text-info-text",
};

export function ScopePill({
  kind,
  trailing,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  kind: ScopeKind;
  /** Decoration after the text that must not be truncated with it (a menu chevron). */
  trailing?: React.ReactNode;
}) {
  const Icon = SCOPE_ICON[kind];
  return (
    <span
      data-slot="scope-pill"
      data-scope={kind}
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-transparent px-2.5 text-xs font-medium",
        "[&>svg]:size-3.5 [&>svg]:shrink-0",
        SCOPE_TONE[kind],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" />
      <span className="truncate">{children}</span>
      {trailing}
    </span>
  );
}
