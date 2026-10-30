import type * as React from "react";
import { RecommendedJobButton } from "@/features/backup-jobs/components/recommended-job";
import type { PricingEstimate } from "@/features/pricing/api";
import { usePricingEstimate } from "@/features/pricing/use-estimate";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { TenantWidgets, WidgetData, WidgetId } from "./api.js";
import {
  ADMIN_WIDGETS,
  showEndpoints,
  tileColumns,
  type WidgetView,
  widgetView,
} from "./presenters.js";
import type { StorageRange } from "./ranges.js";
import { EndpointsWidget } from "./widgets/endpoints-widget.js";
import { LastBackupWidget } from "./widgets/last-backup-widget.js";
import { PriceWidget } from "./widgets/price-widget.js";
import { ReadinessWidget } from "./widgets/readiness-widget.js";
import { RecentJobsWidget } from "./widgets/recent-jobs-widget.js";
import { RetentionWidget } from "./widgets/retention-widget.js";
import { RunningNowWidget } from "./widgets/running-widget.js";
import {
  MailboxUsageWidget,
  ProtectedObjectsWidget,
  StorageWidget,
} from "./widgets/tile-widgets.js";
import {
  BackupSuccessTile,
  BackupTrendWidget,
  StorageGrowthWidget,
  type TrendWindow,
  VerificationHistoryWidget,
} from "./widgets/trend-widgets.js";

/**
 * The widget registry of the start page. Which widgets exist for the viewer
 * is the server's decision (GET /dashboard returns only those that apply);
 * this table decides where each one sits and how it renders. A section lays
 * out whatever of its entries are present, so a plain member's page has no
 * holes where the admin widgets would be.
 */

/**
 * The price card next to "Last successful backup" (0.4.8). It is not a widget of the response: its
 * figures are the server's estimate for the active tenant, and the card is there only for a
 * provider admin whose installation has a price (the tenant's own counts), so the status row of
 * everybody else stays exactly as it was.
 */
export interface PriceCell {
  /** The card is on the page, and the status row has three cells. */
  show: boolean;
  tenantId: string;
  tenantName: string;
  view: WidgetView<PricingEstimate>;
  onRetry: () => void;
  retrying: boolean;
}

export interface WidgetContext {
  /** The view state of one widget from the page's single response. */
  view: <K extends WidgetId>(id: K) => WidgetView<WidgetData[K]>;
  price: PriceCell;
  onRetry: () => void;
  retrying: boolean;
  canAdminister: boolean;
  isProviderAdmin: boolean;
  trendDays: TrendWindow;
  onTrendDaysChange: (days: TrendWindow) => void;
  /** The storage growth window; without it the chart offers no choice. */
  storageRange?: StorageRange;
  onStorageRangeChange?: (range: StorageRange) => void;
  /** Another storage window was chosen and its answer is on the way. */
  storageUpdating?: boolean;
}

interface Entry {
  /** Unique within the page. */
  key: string;
  /** The response widget the entry renders (several entries may share one). */
  source: WidgetId;
  /** The entry is left out of the page for this view state (its source is present). */
  hidden?: (context: WidgetContext) => boolean;
  /** Classes of the entry's cell (e.g. the columns it spans), for this view state and count. */
  cell?: (context: WidgetContext, count: number) => string;
  render: (context: WidgetContext) => React.ReactNode;
}

interface Section {
  id: string;
  /** Grid columns for the number of entries present. */
  columns: (count: number, context: WidgetContext) => string;
  entries: Entry[];
}

const twoUp = (count: number) => (count >= 2 ? "lg:grid-cols-2" : "");

/**
 * The status row: readiness and "Last successful backup" side by side. With a price card the
 * last backup and the price card always stand next to each other (a vertical split, both at the
 * full height of their row), never one above the other. The page's width decides the rest (a
 * container query on the widget area, so a collapsed sidebar counts): from 68rem all three in
 * one row, readiness the widest; from 42rem readiness above, the two cards below it; narrower,
 * one below the other in that order. The last backup's list needs about 21rem, which a quarter
 * of a laptop page does not give it.
 */
const priceBesideLastBackup = (count: number, context: WidgetContext) =>
  context.price.show && count >= 3;

const statusColumns = (count: number, context: WidgetContext) =>
  priceBesideLastBackup(count, context)
    ? "@[42rem]/widgets:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] @[68rem]/widgets:grid-cols-[minmax(0,1.8fr)_minmax(0,1.25fr)_minmax(0,0.85fr)]"
    : twoUp(count);

const state = (context: WidgetContext) => ({
  onRetry: context.onRetry,
  retrying: context.retrying,
});

/**
 * The setup checklist is not on this page: it is the sidebar's "Start" entry
 * (features/start), and the tenant page shows its steps. Nothing here says "setup
 * complete" either.
 */
export const SECTIONS: readonly Section[] = [
  {
    id: "status",
    columns: statusColumns,
    entries: [
      {
        key: "readiness",
        source: "readiness",
        cell: (c, count) =>
          priceBesideLastBackup(count, c)
            ? "@[42rem]/widgets:col-span-2 @[68rem]/widgets:col-span-1"
            : "",
        render: (c) => (
          <ReadinessWidget
            view={c.view("readiness")}
            {...state(c)}
            canAdminister={c.canAdminister}
            protectAction={
              c.canAdminister ? <RecommendedJobButton scope={{ everything: true }} /> : undefined
            }
          />
        ),
      },
      {
        key: "lastBackup",
        source: "lastBackup",
        render: (c) => (
          <LastBackupWidget
            view={c.view("lastBackup")}
            {...state(c)}
            canAdminister={c.canAdminister}
          />
        ),
      },
      {
        key: "price",
        source: "readiness",
        hidden: (c) => !c.price.show,
        render: (c) => (
          <PriceWidget
            view={c.price.view}
            onRetry={c.price.onRetry}
            retrying={c.price.retrying}
            tenantId={c.price.tenantId}
            tenantName={c.price.tenantName}
          />
        ),
      },
    ],
  },
  {
    id: "running",
    columns: () => "",
    entries: [
      {
        key: "running",
        source: "running",
        render: (c) => <RunningNowWidget view={c.view("running")} {...state(c)} />,
      },
    ],
  },
  {
    id: "figures",
    columns: tileColumns,
    entries: [
      {
        key: "backupSuccess",
        source: "backupTrend",
        render: (c) => (
          <BackupSuccessTile view={c.view("backupTrend")} {...state(c)} days={c.trendDays} />
        ),
      },
      {
        key: "protectedObjects",
        source: "protectedObjects",
        render: (c) => (
          <ProtectedObjectsWidget
            view={c.view("protectedObjects")}
            {...state(c)}
            canAdminister={c.canAdminister}
          />
        ),
      },
      {
        key: "storage",
        source: "storage",
        render: (c) => (
          <StorageWidget view={c.view("storage")} {...state(c)} canAdminister={c.canAdminister} />
        ),
      },
      {
        key: "mailboxUsage",
        source: "mailboxUsage",
        render: (c) => (
          <MailboxUsageWidget
            view={c.view("mailboxUsage")}
            {...state(c)}
            isProviderAdmin={c.isProviderAdmin}
          />
        ),
      },
    ],
  },
  {
    id: "endpoints",
    columns: () => "",
    entries: [
      {
        key: "endpoints",
        source: "endpoints",
        // Nothing for a tenant without servers or clients, not an empty card.
        hidden: (c) => !showEndpoints(c.view("endpoints")),
        render: (c) => <EndpointsWidget view={c.view("endpoints")} {...state(c)} />,
      },
    ],
  },
  {
    id: "trends",
    columns: twoUp,
    entries: [
      {
        key: "backupTrend",
        source: "backupTrend",
        render: (c) => (
          <BackupTrendWidget
            view={c.view("backupTrend")}
            {...state(c)}
            days={c.trendDays}
            onDaysChange={c.onTrendDaysChange}
            canAdminister={c.canAdminister}
          />
        ),
      },
      {
        key: "verificationHistory",
        source: "verificationHistory",
        render: (c) => (
          <VerificationHistoryWidget
            view={c.view("verificationHistory")}
            {...state(c)}
            canAdminister={c.canAdminister}
          />
        ),
      },
    ],
  },
  {
    id: "storage",
    columns: twoUp,
    entries: [
      {
        key: "storageGrowth",
        source: "storageGrowth",
        render: (c) => (
          <StorageGrowthWidget
            view={c.view("storageGrowth")}
            {...state(c)}
            range={c.storageRange}
            onRangeChange={c.onStorageRangeChange}
            updating={c.storageUpdating}
          />
        ),
      },
      {
        key: "retention",
        source: "retention",
        render: (c) => <RetentionWidget view={c.view("retention")} {...state(c)} />,
      },
    ],
  },
  {
    id: "activity",
    columns: () => "",
    entries: [
      {
        key: "recentJobs",
        source: "recentJobs",
        render: (c) => <RecentJobsWidget view={c.view("recentJobs")} {...state(c)} />,
      },
    ],
  },
];

/** Every widget the registry places, in page order (the one order of the page). */
export const PAGE_WIDGETS: readonly WidgetId[] = [
  ...new Set(SECTIONS.flatMap((section) => section.entries.map((entry) => entry.source))),
];

/**
 * The widgets to show skeletons for before the response arrives, from the
 * session's role; the response then decides.
 */
export function expectedWidgets(canAdminister: boolean): WidgetId[] {
  return PAGE_WIDGETS.filter((id) => canAdminister || !ADMIN_WIDGETS.has(id));
}

/** The sources on the page: those in the response, or those expected while it loads. */
export function visibleSources(
  widgets: TenantWidgets | undefined,
  canAdminister: boolean,
): ReadonlySet<WidgetId> {
  if (widgets) {
    return new Set(Object.keys(widgets) as WidgetId[]);
  }
  return new Set(expectedWidgets(canAdminister));
}

export interface DashboardWidgetsProps extends Omit<WidgetContext, "view" | "price"> {
  widgets: TenantWidgets | undefined;
  loading: boolean;
}

/**
 * The price card's cell from the estimate query of the active tenant: shown once the installation
 * has a price that applies, and in its error state when the estimate failed. After a tenant
 * switch the previous tenant's answer keeps the cell (and so the row's three columns) while the
 * new one loads, with the card as a skeleton, so the row does not collapse and grow again. Only
 * the very first load of a session cannot know yet, and shows the row without the card until the
 * answer is there (nobody without a price sees the row change).
 */
function usePriceCell(isProviderAdmin: boolean): PriceCell {
  const tenant = useSession().activeTenant;
  const query = usePricingEstimate({
    tenantId: tenant?.id,
    enabled: isProviderAdmin && tenant !== null,
    keepPrevious: true,
  });
  const estimate = query.data;
  // The previous tenant's figures are not this tenant's: they only decide whether the cell stays.
  const stale = query.isPlaceholderData;
  return {
    show: isProviderAdmin && tenant !== null && (estimate ? estimate.hasPrices : query.isError),
    tenantId: tenant?.id ?? "",
    tenantName: tenant?.name ?? "",
    view:
      estimate && !stale
        ? { kind: "ready", data: estimate }
        : query.isError
          ? { kind: "error", error: query.error }
          : { kind: "loading" },
    onRetry: () => void query.refetch(),
    retrying: query.isFetching,
  };
}

/** Every tenant widget that applies, laid out section by section. */
export function DashboardWidgets({ widgets, loading, ...context }: DashboardWidgetsProps) {
  const visible = visibleSources(widgets, context.canAdminister);
  const price = usePriceCell(context.isProviderAdmin);
  const full: WidgetContext = {
    ...context,
    price,
    view: (id) => widgetView(widgets?.[id], loading) as WidgetView<WidgetData[typeof id]>,
  };

  return (
    <div className="@container/widgets space-y-6">
      {SECTIONS.map((section) => {
        const entries = section.entries.filter(
          (entry) => visible.has(entry.source) && !entry.hidden?.(full),
        );
        if (entries.length === 0) {
          return null;
        }
        return (
          <section
            key={section.id}
            data-section={section.id}
            className={cn("grid gap-4 *:min-w-0", section.columns(entries.length, full))}
          >
            {entries.map((entry) => (
              // One shrinkable track (minmax(0, 1fr)), so a wide table scrolls
              // inside its card instead of widening the page on a phone.
              <div
                key={entry.key}
                data-slot="widget-cell"
                className={cn("grid grid-cols-1", entry.cell?.(full, entries.length))}
              >
                {entry.render(full)}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
