import type * as React from "react";

import { cn } from "@/lib/utils";

import type { TenantWidgets, WidgetData, WidgetId } from "./api.js";
import {
  ADMIN_WIDGETS,
  type WidgetView,
  showEndpoints,
  tileColumns,
  widgetView,
} from "./presenters.js";
import { EndpointsWidget } from "./widgets/endpoints-widget.js";
import { LastBackupWidget } from "./widgets/last-backup-widget.js";
import { ReadinessWidget } from "./widgets/readiness-widget.js";
import { RecentJobsWidget } from "./widgets/recent-jobs-widget.js";
import { RetentionWidget } from "./widgets/retention-widget.js";
import { SetupWidget } from "./widgets/setup-widget.js";
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

export interface WidgetContext {
  /** The view state of one widget from the page's single response. */
  view: <K extends WidgetId>(id: K) => WidgetView<WidgetData[K]>;
  onRetry: () => void;
  retrying: boolean;
  canAdminister: boolean;
  isProviderAdmin: boolean;
  trendDays: TrendWindow;
  onTrendDaysChange: (days: TrendWindow) => void;
}

interface Entry {
  /** Unique within the page. */
  key: string;
  /** The response widget the entry renders (several entries may share one). */
  source: WidgetId;
  /** The entry is left out of the page for this view state (its source is present). */
  hidden?: (context: WidgetContext) => boolean;
  render: (context: WidgetContext) => React.ReactNode;
}

interface Section {
  id: string;
  /** Grid columns for the number of entries present. */
  columns: (count: number) => string;
  entries: Entry[];
}

const twoUp = (count: number) => (count >= 2 ? "lg:grid-cols-2" : "");

const state = (context: WidgetContext) => ({
  onRetry: context.onRetry,
  retrying: context.retrying,
});

export const SECTIONS: readonly Section[] = [
  {
    id: "setup",
    columns: () => "",
    entries: [
      {
        key: "setup",
        source: "setup",
        render: (c) => <SetupWidget view={c.view("setup")} {...state(c)} />,
      },
    ],
  },
  {
    id: "status",
    columns: twoUp,
    entries: [
      {
        key: "readiness",
        source: "readiness",
        render: (c) => (
          <ReadinessWidget
            view={c.view("readiness")}
            {...state(c)}
            canAdminister={c.canAdminister}
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
        render: (c) => <StorageGrowthWidget view={c.view("storageGrowth")} {...state(c)} />,
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

export interface DashboardWidgetsProps extends Omit<WidgetContext, "view"> {
  widgets: TenantWidgets | undefined;
  loading: boolean;
}

/** Every tenant widget that applies, laid out section by section. */
export function DashboardWidgets({ widgets, loading, ...context }: DashboardWidgetsProps) {
  const visible = visibleSources(widgets, context.canAdminister);
  const full: WidgetContext = {
    ...context,
    view: (id) => widgetView(widgets?.[id], loading) as WidgetView<WidgetData[typeof id]>,
  };

  return (
    <div className="space-y-6">
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
            className={cn("grid gap-4 *:min-w-0", section.columns(entries.length))}
          >
            {entries.map((entry) => (
              // One shrinkable track (minmax(0, 1fr)), so a wide table scrolls
              // inside its card instead of widening the page on a phone.
              <div key={entry.key} data-slot="widget-cell" className="grid grid-cols-1">
                {entry.render(full)}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
