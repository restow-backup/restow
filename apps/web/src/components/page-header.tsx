import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { useEmbeddedPage, usePageFrame, usePublishedTitle } from "@/components/kit/page-context";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  /** One line on what the page is for. */
  description?: React.ReactNode;
  /**
   * Page icon. When omitted, the icon of the active navigation item (from the
   * shell's page context) is used; `null` shows no icon at all.
   */
  icon?: LucideIcon | null;
  /** Right-aligned actions; the primary action goes last. */
  actions?: React.ReactNode;
  /** Right-aligned actions (buttons, filters); rendered after `actions`. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Consistent page heading for every feature page inside the shell: icon,
 * title, one-line description and actions on the right. It also publishes the
 * title for the breadcrumbs and sets the browser tab title to
 * "<title> · <tenant> · Restow".
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  children,
  className,
}: PageHeaderProps) {
  const { t } = useTranslation();
  const frame = usePageFrame();
  const embedded = useEmbeddedPage();
  usePublishedTitle(title, t("app.name"), !embedded);

  const Icon = icon === undefined ? frame.icon : icon;
  const hasActions = Boolean(actions) || Boolean(children);

  if (embedded) {
    // A section of a larger page: a heading one level below the page's own, no icon of its own.
    return (
      <div
        data-slot="page-header"
        data-embedded="true"
        className={cn(
          "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
          className,
        )}
      >
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold tracking-tight break-words hyphens-auto">{title}</h2>
          {description ? (
            typeof description === "string" ? (
              <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
            ) : (
              <div className="max-w-prose text-sm text-muted-foreground">{description}</div>
            )
          ) : null}
        </div>
        {hasActions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
            {children}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-slot="page-header"
      className={cn("flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between", className)}
    >
      <div className="flex min-w-0 items-start gap-3">
        {Icon ? (
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground shadow-xs"
          >
            <Icon className="size-5" />
          </span>
        ) : null}
        <div className="min-w-0 space-y-1">
          {/* Focusable by script only, so the shell can move focus here after navigation. */}
          <h1
            tabIndex={-1}
            className="text-2xl font-semibold tracking-tight break-words hyphens-auto outline-none"
          >
            {title}
          </h1>
          {description ? (
            typeof description === "string" ? (
              <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
            ) : (
              <div className="max-w-prose text-sm text-muted-foreground">{description}</div>
            )
          ) : null}
        </div>
      </div>
      {hasActions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
          {children}
        </div>
      ) : null}
    </div>
  );
}
