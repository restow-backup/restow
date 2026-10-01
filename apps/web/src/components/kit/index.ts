/**
 * The shared UI kit: the parts every feature page is built from, on top of
 * the generated shadcn components in `components/ui`. Import from here
 * (`@/components/kit`) instead of hand-building tables, empty states,
 * confirmations, relative times or status labels.
 *
 * Kit strings live in the `ui` translation namespace.
 */

export { UI_NAMESPACE } from "./i18n.js";

export * from "./data-table/index.js";

export {
  ACTIVITY_ORB_STATE,
  ActivityOrb,
  type ActivityKind,
  type ActivityOrbProps,
  type ActivityOrbSize,
} from "./activity-orb.js";
export { ChartCard, type ChartCardProps } from "./chart-card.js";
export { HORIZONTAL_GRID, VALUE_AXIS_INTERVAL, VERTICAL_GRID } from "./chart-grid.js";
export { type ChartStatusTone, STATUS_CHART_COLOR } from "./chart-colors.js";
export { type ClipboardEnvironment, copyToClipboard } from "./clipboard.js";
export {
  ConfirmDialog,
  type ConfirmDialogProps,
  confirmationMatches,
} from "./confirm-dialog.js";
export { CopyButton, type CopyButtonProps } from "./copy-button.js";
export { EmptyState, type EmptyStateProps } from "./empty-state.js";
export { HintTooltip, type HintTooltipProps } from "./hint-tooltip.js";
export { IconButton, type IconButtonProps } from "./icon-button.js";
export {
  type DeltaDirection,
  type DeltaTone,
  type DeltaView,
  type KpiDelta,
  KpiTile,
  type KpiTileProps,
  describeDelta,
} from "./kpi-tile.js";
export {
  DEFAULT_PAGE_WIDTH,
  PageProvider,
  type PageProviderProps,
  type PageWidth,
  documentTitle,
  usePageFrame,
  usePageTitle,
  usePageWidth,
  usePublishedTitle,
} from "./page-context.js";
export { type PageTab, PageTabs, type PageTabsProps } from "./page-tabs.js";
export { RefreshButton, type RefreshButtonProps } from "./refresh-button.js";
export {
  RelativeTime,
  type RelativeTimeProps,
  absoluteLabel,
  relativeLabel,
  toDate,
  useMinuteClock,
} from "./relative-time.js";
export {
  STATUS_TONE_ICON,
  StatusBadge,
  type StatusBadgeProps,
  type StatusTone,
} from "./status-badge.js";

// Existing shared parts, re-exported so pages import the whole kit from one place.
export { ErrorState } from "../error-state.js";
export { PageHeader } from "../page-header.js";
