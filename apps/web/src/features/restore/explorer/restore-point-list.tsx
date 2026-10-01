import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  type ChartStatusTone,
  STATUS_CHART_COLOR,
  type StatusTone,
  UI_NAMESPACE,
  absoluteLabel,
  relativeLabel,
  toDate,
  useMinuteClock,
} from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ListedSnapshot } from "@/features/restore/api";
import {
  chronological,
  compactTimelineLabels,
  restorePointTime,
  useSnapshotLabel,
} from "@/features/restore/explorer/restore-point-label";
import type { SnapshotVerification, VerificationState } from "@/features/verify/api";
import { SnapshotVerificationBadge } from "@/features/verify/components/snapshot-verification-badge";
import "@/features/verify/i18n";
import { snapshotVerificationView } from "@/features/verify/presenters";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface RestorePointListProps {
  /** Newest first, as the API lists them; the timeline shows them oldest to newest. */
  restorePoints: readonly ListedSnapshot[] | undefined;
  loading: boolean;
  value: string | null;
  onChange: (restorePointId: string) => void;
}

/** A move of more than this many track widths is not animated. */
const FAR_MOVE = 2.5;

/** Height of the row the line and the markers sit in; odd, so the 1px line centres on the markers. */
const MARKER_ROW = "h-[17px]";

/**
 * Which point in time to browse: a slim, horizontally scrolling timeline,
 * oldest restore point on the left, newest on the right, one small marker per
 * restore point on a thin line. A marker's shape and colour carry the
 * verification of exactly that backup (never colour alone, and the words are
 * in the tooltip and the accessible name). The browsed restore point is
 * centred and spelled out (date, time, how long ago, verification); the
 * others show a short date label and the full picture on hover or focus.
 *
 * The track has half its width of empty space at both ends, so even the
 * first and the last restore point can be centred. It centres the newest
 * restore point when it opens, and whichever one is selected afterwards
 * (smoothly, unless the person asked for reduced motion). Nothing is
 * rendered once the account has no restore point yet; the explorer's own
 * empty state already says so.
 */
export function RestorePointList({
  restorePoints,
  loading,
  value,
  onChange,
}: RestorePointListProps) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const listRef = React.useRef<HTMLUListElement>(null);
  const buttons = React.useRef(new Map<string, HTMLButtonElement>()).current;
  // Roving tabindex (WAI-ARIA toolbar/listbox pattern): only the browsed
  // restore point is a Tab stop; the arrow keys move focus among the rest
  // without pulling every one of them (there can be hundreds) into the tab
  // order. `focused` tracks which marker last received DOM focus so the
  // roving tabindex follows real keyboard/mouse focus, not just `value`.
  const [focused, setFocused] = React.useState<string | null>(value);

  const timeline = React.useMemo(() => chronological(restorePoints ?? []), [restorePoints]);
  const labels = React.useMemo(
    () => compactTimelineLabels(timeline, language),
    [timeline, language],
  );
  const ready = !loading && timeline.length > 0;

  const centre = React.useCallback(
    (id: string | null, animate: boolean) => {
      const button = id === null ? undefined : buttons.get(id);
      if (!button) {
        return;
      }
      // Gliding past a few screens of markers is noise, and takes a second
      // and a half for a year of daily backups: far moves snap.
      const list = listRef.current;
      const distance = list
        ? Math.abs(
            button.offsetLeft + button.offsetWidth / 2 - list.scrollLeft - list.clientWidth / 2,
          )
        : 0;
      const far = list !== null && distance > list.clientWidth * FAR_MOVE;
      button.scrollIntoView?.({
        inline: "center",
        // Never scroll the page vertically to reveal the bar.
        block: "nearest",
        behavior: animate && !far && !prefersReducedMotion() ? "smooth" : "auto",
      });
    },
    [buttons],
  );

  // Where the track is centred right now, for the resize observer below.
  const centred = React.useRef<string | null>(null);

  // A layout effect, so the newest restore point is already centred when the
  // bar first paints instead of jumping there from the oldest one. Only a
  // move within the list the person is already looking at animates: the
  // first centring, and a switch to another account's restore points,
  // snap into place.
  //
  // The animated move waits for the next frame: started from inside the
  // commit that also resizes the markers (the selected one grows, the
  // previous one shrinks), Chrome drops a smooth scroll without moving at
  // all.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the selection and the list becoming available should re-centre.
  React.useLayoutEffect(() => {
    if (!ready) {
      return;
    }
    const sameList =
      centred.current !== null && timeline.some((point) => point.id === centred.current);
    centred.current = value;
    if (!sameList) {
      centre(value, false);
      return;
    }
    const frame = requestAnimationFrame(() => centre(value, true));
    return () => cancelAnimationFrame(frame);
  }, [value, ready]);

  React.useEffect(() => {
    setFocused(value);
  }, [value]);

  // Resizing the window (or the explorer settling into its layout) moves the
  // middle of the track: keep the browsed restore point in it.
  React.useEffect(() => {
    const node = listRef.current;
    if (!ready || !node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => centre(centred.current, false));
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready, centre]);

  // A mouse wheel only turns vertically; over this track that should scroll
  // it sideways. Native listener: React's own `onWheel` is passive and could
  // not stop the page from also scrolling.
  React.useEffect(() => {
    const node = listRef.current;
    if (!ready || !node) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }
      const limit = node.scrollWidth - node.clientWidth;
      const next = Math.min(
        Math.max(node.scrollLeft + event.deltaY * (event.deltaMode === 1 ? 16 : 1), 0),
        limit,
      );
      if (limit <= 0 || next === node.scrollLeft) {
        return;
      }
      event.preventDefault();
      node.scrollLeft = next;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [ready]);

  // Stable callbacks (`onChange` itself is a new function on every render of
  // the explorer), so a selection re-renders the few markers whose state
  // changed and not all of up to 500.
  const onChangeRef = React.useRef(onChange);
  React.useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const select = React.useCallback((id: string) => onChangeRef.current(id), []);
  const rememberFocus = React.useCallback((id: string) => setFocused(id), []);
  const register = React.useCallback(
    (id: string, node: HTMLButtonElement | null) => {
      if (node) {
        buttons.set(id, node);
      } else {
        buttons.delete(id);
      }
    },
    [buttons],
  );

  if (loading) {
    return (
      <div
        aria-hidden="true"
        className="flex min-w-0 flex-1 justify-center gap-4 overflow-hidden py-1.5"
      >
        {[0, 1, 2, 3, 4, 5, 6].map((placeholderId) => (
          <div key={placeholderId} className="flex w-12 shrink-0 flex-col items-center gap-1">
            <div className={cn("flex items-center", MARKER_ROW)}>
              <Skeleton className="size-[11px] rounded-full" />
            </div>
            <Skeleton className="h-3 w-9" />
          </div>
        ))}
      </div>
    );
  }
  if (timeline.length === 0) {
    return null;
  }

  const ids = timeline.map((point) => point.id);
  const latestId = ids[ids.length - 1] as string;
  const tabStop =
    [focused, value].find((id): id is string => id !== null && ids.includes(id)) ?? latestId;

  // Left is older, right is newer. Arrow keys and Home/End only move focus
  // (Enter or Space picks the restore point): every pick loads a whole
  // restore point, which arrowing across dozens of them should not do.
  const onKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }
    const current = Math.max(ids.indexOf(tabStop), 0);
    const target =
      event.key === "ArrowLeft"
        ? current - 1
        : event.key === "ArrowRight"
          ? current + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : null;
    if (target === null) {
      return;
    }
    event.preventDefault();
    const id = ids[Math.min(Math.max(target, 0), ids.length - 1)] as string;
    // Focus without the browser's own "nearest" scroll, then centre it the
    // same way a pick does.
    buttons.get(id)?.focus({ preventScroll: true });
    centre(id, true);
  };

  return (
    // `relative`: the selected marker's SnapshotVerificationBadge (and its
    // own hint) renders a `sr-only` span (`position: absolute`) when its
    // focusable tab stop is turned off. With no positioned ancestor, a
    // browser computes such a span's "static position" against the page's
    // initial containing block — inside this horizontally-scrolling row that
    // can place it thousands of pixels to the right (observed with the
    // previous card row: a 1920px-wide page grew to 6674px wide with 40
    // restore points), turning every wheel/trackpad scroll here into a
    // scroll of the whole app. Positioning the row itself anchors those
    // spans to it instead, where `overflow-x-auto` clips them (each marker's
    // own accessible name is anchored to its button the same way).
    //
    // `@container`: lets the selected label size itself to this track
    // (`cqw`), and `before:`/`after:` are the empty half-track at each end
    // (a percentage width of a flex item is a share of *this* row, which
    // padding on the row would not be).
    <ul
      ref={listRef}
      aria-label={t("explorer.restorePoint.listLabel")}
      className={cn(
        "@container relative flex min-w-0 flex-1 items-start overflow-x-auto py-1.5",
        "before:block before:w-1/2 before:shrink-0 after:block after:w-1/2 after:shrink-0",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "[mask-image:linear-gradient(to_right,transparent,#000_1.5rem,#000_calc(100%-1.5rem),transparent)]",
      )}
      onKeyDown={onKeyDown}
    >
      <TooltipProvider delayDuration={200}>
        {timeline.map((point, index) => (
          <li key={point.id} className="shrink-0">
            <RestorePointMarker
              point={point}
              compactLabel={labels.get(point.id) ?? ""}
              first={index === 0}
              last={index === timeline.length - 1}
              active={point.id === value}
              tabbable={point.id === tabStop}
              latest={point.id === latestId}
              register={register}
              onSelect={select}
              onFocusPoint={rememberFocus}
            />
          </li>
        ))}
      </TooltipProvider>
    </ul>
  );
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The verification of one restore point in words, from the same rules every snapshot list uses. */
function useVerificationText(verification: SnapshotVerification) {
  const { t, i18n } = useTranslation("verify");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const view = snapshotVerificationView(verification, (iso) => {
    const date = toDate(iso);
    return date ? absoluteLabel(date, language) : iso;
  });
  return {
    tone: view.tone,
    label: t(view.label.key),
    hint: t(view.hint.key, view.hint.values),
  };
}

/** Each state has its own shape as well as its own colour. */
const MARKER_SHAPE: Record<VerificationState, string> = {
  /** A solid dot: read back and restorable. */
  green: "size-[11px] rounded-full",
  /** A solid diamond: verified with warnings. */
  yellow: "size-[9px] rotate-45 rounded-[2px]",
  /** A solid square: the check failed. */
  red: "size-[9px] rounded-[2px]",
  /** A hollow ring: not proven, no check has read this backup back. */
  unverified: "size-[11px] rounded-full border-2 bg-card",
};

function chartTone(tone: StatusTone): ChartStatusTone {
  return tone === "neutral" ? "muted" : tone;
}

function VerificationMarker({
  verification,
  tone,
  selected,
}: {
  verification: SnapshotVerification;
  tone: StatusTone;
  selected: boolean;
}) {
  const color = STATUS_CHART_COLOR[chartTone(tone)];
  const hollow = verification.state === "unverified";
  return (
    <span
      data-verification={verification.state}
      className={cn(
        "relative z-10 shrink-0 motion-safe:transition-transform",
        MARKER_SHAPE[verification.state] ?? MARKER_SHAPE.unverified,
        selected ? "scale-[1.35] ring-4 ring-primary/15" : "group-hover:scale-125",
      )}
      style={hollow ? { borderColor: color } : { backgroundColor: color }}
    />
  );
}

/** The minute-fresh "3 hours ago" of a restore point. */
function RelativeText({ value }: { value: string }) {
  const { t, i18n } = useTranslation(UI_NAMESPACE);
  const language = i18n.resolvedLanguage ?? i18n.language;
  useMinuteClock();
  const date = toDate(value);
  if (!date) {
    return <>{t("time.unknown")}</>;
  }
  return <>{relativeLabel(date, Date.now(), language) ?? t("time.justNow")}</>;
}

interface RestorePointMarkerProps {
  point: ListedSnapshot;
  compactLabel: string;
  first: boolean;
  last: boolean;
  active: boolean;
  tabbable: boolean;
  latest: boolean;
  /** Hands the list this marker's button, and takes it back on unmount. */
  register: (id: string, node: HTMLButtonElement | null) => void;
  onSelect: (id: string) => void;
  onFocusPoint: (id: string) => void;
}

const RestorePointMarker = React.memo(function RestorePointMarker({
  point,
  compactLabel,
  first,
  last,
  active,
  tabbable,
  latest,
  register,
  onSelect,
  onFocusPoint,
}: RestorePointMarkerProps) {
  const { t, i18n } = useTranslation("restore");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const label = useSnapshotLabel();
  const verification = useVerificationText(point.verification);
  const time = restorePointTime(point);
  const absolute = formatDateTime(time, language) ?? "";

  // The button's whole accessible name, in one place: a restore point's
  // sequence number is never shown as text, and the verification state and
  // "Latest" would otherwise exist only as colour, shape and a tooltip. The
  // visible content below is hidden from assistive technology so nothing is
  // read twice. No `aria-label` on the button for the same reason: it would
  // replace this instead of adding to it.
  const spoken = [
    label(point),
    verification.label,
    verification.hint,
    latest ? t("explorer.restorePoint.latest") : null,
    active ? t("explorer.restorePoint.current") : null,
  ]
    .filter(Boolean)
    // The hint is a sentence with its own full stop.
    .map((part) => part?.replace(/\.$/, ""))
    .join(". ");

  return (
    // One tooltip provider and this tooltip stay mounted whether or not the
    // restore point is selected: swapping in a differently shaped tree when
    // it becomes the selected one would remount the button and drop its focus.
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={(node) => register(point.id, node)}
          type="button"
          onClick={() => onSelect(point.id)}
          onFocus={() => onFocusPoint(point.id)}
          tabIndex={tabbable ? 0 : -1}
          aria-current={active ? "true" : undefined}
          className={cn(
            "group relative flex min-w-14 flex-col items-center gap-0.5 rounded-md text-xs transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span className="sr-only">{spoken}</span>
          {/* The line runs through the marker row of every button; the first
              and the last one only carry their half of it. */}
          <span
            aria-hidden="true"
            className={cn("relative flex w-full items-center justify-center", MARKER_ROW)}
          >
            <span
              className={cn(
                "absolute top-2 h-px bg-border",
                first ? "left-1/2" : "left-0",
                last ? "right-1/2" : "right-0",
              )}
            />
            <VerificationMarker
              verification={point.verification}
              tone={verification.tone}
              selected={active}
            />
          </span>
          {active ? (
            <span
              aria-hidden="true"
              className="flex max-w-[min(34rem,calc(100cqw-1.5rem))] flex-wrap items-center justify-center gap-x-2 gap-y-1 min-h-[22px] rounded-md bg-primary/10 px-2.5 py-0.5"
            >
              <time
                dateTime={toDate(time)?.toISOString()}
                className="whitespace-nowrap text-[13px] font-semibold tabular-nums text-foreground"
              >
                {absolute}
              </time>
              <span className="whitespace-nowrap text-muted-foreground">
                <RelativeText value={time} />
              </span>
              {latest ? (
                <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                  {t("explorer.restorePoint.latest")}
                </Badge>
              ) : null}
              <SnapshotVerificationBadge
                verification={point.verification}
                focusable={false}
                className="px-1.5 py-0 text-[11px]"
              />
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="h-4 whitespace-nowrap px-1 text-[11px] leading-4 tabular-nums text-muted-foreground transition-colors group-hover:text-foreground"
            >
              {compactLabel}
            </span>
          )}
        </button>
      </TooltipTrigger>
      {active ? null : (
        <TooltipContent side="top" className="max-w-xs">
          <p className="font-medium">{absolute}</p>
          <p className="opacity-80">
            <RelativeText value={time} />
            {latest ? ` · ${t("explorer.restorePoint.latest")}` : null}
          </p>
          <p className="mt-1">{verification.label}</p>
          <p className="opacity-80">{verification.hint}</p>
        </TooltipContent>
      )}
    </Tooltip>
  );
});
