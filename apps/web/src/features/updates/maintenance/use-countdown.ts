import * as React from "react";

import { remainingSeconds } from "../presenters";

/**
 * Milliseconds until the displayed number of whole seconds changes. The
 * number is `ceil(remaining / 1000)`, so it drops the moment the remaining
 * time falls to the next lower multiple of a second; the tick is aimed there
 * (plus a hair) instead of running on a free interval that drifts.
 */
export function msUntilNextTick(startsAt: string, nowMs: number, offsetMs: number): number | null {
  const target = Date.parse(startsAt);
  if (!Number.isFinite(target)) {
    return null;
  }
  const left = target - (nowMs + offsetMs);
  if (left <= 0) {
    return null;
  }
  return left - (Math.ceil(left / 1000) - 1) * 1000 + 20;
}

/**
 * Whole seconds until `startsAt` on the server's clock (`offsetMs` is the
 * server clock minus the client clock), ticking once a second, `0` from the
 * start time on, `null` without a start time. The server's time is the
 * reference, so a browser with a wrong clock still counts down correctly.
 */
export function useCountdown(startsAt: string | null | undefined, offsetMs: number): number | null {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!startsAt) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const current = Date.now();
      setNow(current);
      const wait = msUntilNextTick(startsAt, current, offsetMs);
      if (wait !== null) {
        timer = setTimeout(schedule, wait);
      }
    };
    schedule();
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [startsAt, offsetMs]);

  return remainingSeconds(startsAt, now, offsetMs);
}

/** The stages a screen reader hears about a countdown: at the start, at one minute, at ten seconds, at zero. */
export type AnnouncementStage = "start" | "minute" | "seconds" | "starting";

const STAGE_ORDER: readonly AnnouncementStage[] = ["start", "minute", "seconds", "starting"];

/** The stage that belongs to the remaining time. */
export function stageFor(remaining: number | null): AnnouncementStage {
  if (remaining === null) {
    return "start";
  }
  if (remaining <= 0) {
    return "starting";
  }
  if (remaining <= 10) {
    return "seconds";
  }
  if (remaining <= 60) {
    return "minute";
  }
  return "start";
}

/** Advance the announced stage; it only ever moves forward, so nothing is announced twice. */
export function nextStage(current: AnnouncementStage, remaining: number | null): AnnouncementStage {
  const target = stageFor(remaining);
  return STAGE_ORDER.indexOf(target) > STAGE_ORDER.indexOf(current) ? target : current;
}
