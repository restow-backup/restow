import type { LucideIcon } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, ErrorState, KpiTile } from "@/components/kit";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type { WidgetView } from "../presenters.js";
import "../i18n.js";

/** What an empty widget says: an icon, one sentence and, where the viewer can act, the way forward. */
export interface WidgetEmpty {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
}

/** Shared by every widget: the view state and the retry of the page's one request. */
export interface WidgetStateProps<T> {
  view: WidgetView<T>;
  onRetry: () => void;
  retrying: boolean;
}

interface WidgetCardProps<T> extends WidgetStateProps<T> {
  id: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** Right side of the header, e.g. a link to the full page. */
  action?: React.ReactNode;
  /** The empty state for this data, or null when there is something to show. */
  empty?: (data: T) => WidgetEmpty | null;
  /** Loading placeholder shaped like the content (default: three lines). */
  skeleton?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  children: (data: T) => React.ReactNode;
}

function DefaultSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/**
 * The card around a widget and its states: a skeleton shaped like the
 * content while the page loads, the cause with a retry when the server could
 * not load this part, the widget's own empty state, and finally the content.
 */
export function WidgetCard<T>({
  id,
  view,
  onRetry,
  retrying,
  title,
  description,
  icon: Icon,
  action,
  empty,
  skeleton,
  className,
  contentClassName,
  children,
}: WidgetCardProps<T>) {
  const { t } = useTranslation("dashboard");
  const emptyState = view.kind === "ready" && empty ? empty(view.data) : null;
  const state = emptyState ? "empty" : view.kind;

  let body: React.ReactNode;
  if (view.kind === "loading") {
    body = (
      <div aria-busy="true">
        {skeleton ?? <DefaultSkeleton />}
        <span className="sr-only">{t("widget.loading", { title })}</span>
      </div>
    );
  } else if (view.kind === "error") {
    body = (
      <ErrorState
        title={t("widget.error.title")}
        description={t("widget.error.description")}
        error={view.error}
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  } else if (emptyState) {
    body = (
      <EmptyState
        icon={emptyState.icon}
        title={emptyState.title}
        description={emptyState.description}
        actions={emptyState.action}
        variant="plain"
        className="py-6"
      />
    );
  } else {
    body = children(view.data);
  }

  return (
    <Card data-widget={id} data-state={state} className={cn("gap-4", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {Icon ? <Icon className="size-4 text-muted-foreground" aria-hidden="true" /> : null}
          {title}
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action && view.kind === "ready" && !emptyState ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className={cn("min-w-0", contentClassName)}>{body}</CardContent>
    </Card>
  );
}

interface TileWidgetProps<T> extends WidgetStateProps<T> {
  id: string;
  label: string;
  icon: LucideIcon;
  empty?: (data: T) => WidgetEmpty | null;
  /** The ready tile, normally a KpiTile. */
  children: (data: T) => React.ReactNode;
}

/**
 * A key-figure widget. Loading and ready use the kit's KpiTile; failed and
 * empty keep the tile's frame and height so the row does not jump.
 */
export function TileWidget<T>({
  id,
  view,
  onRetry,
  retrying,
  label,
  icon: Icon,
  empty,
  children,
}: TileWidgetProps<T>) {
  const { t } = useTranslation("dashboard");
  if (view.kind === "loading") {
    return (
      <div data-widget={id} data-state="loading" className="grid">
        <KpiTile label={label} icon={Icon} value="" loading />
      </div>
    );
  }
  const emptyState = view.kind === "ready" && empty ? empty(view.data) : null;
  if (view.kind === "ready" && !emptyState) {
    return (
      <div data-widget={id} data-state="ready" className="grid">
        {children(view.data)}
      </div>
    );
  }
  return (
    <Card
      data-widget={id}
      data-state={view.kind === "error" ? "error" : "empty"}
      className="gap-3 p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      {view.kind === "error" ? (
        <ErrorState
          title={t("widget.error.title")}
          description={t("widget.error.description")}
          error={view.error}
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : emptyState ? (
        <EmptyState
          icon={emptyState.icon}
          title={emptyState.title}
          description={emptyState.description}
          actions={emptyState.action}
          variant="plain"
          className="px-2 py-2"
        />
      ) : null}
    </Card>
  );
}
