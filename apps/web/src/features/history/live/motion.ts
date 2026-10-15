import * as React from "react";

import { useReducedMotion } from "@/lib/use-reduced-motion";

/**
 * The motion of a running run between two measurements: a clock that drives the charts' time
 * axis, and numbers that count up to a new value instead of jumping to it. Both run on animation
 * frames, so a hidden tab (and a closed drawer, which unmounts them) costs nothing: the browser
 * stops the frames. With reduced motion nothing eases; the clock still ticks once a second, so
 * what is shown keeps moving with time, in steps.
 */

/** How long a new value takes to arrive: a line point, a number. */
export const EASE_MS = 400;
/** How often the time axis moves on while nothing eases: a few pixels a second, four steps. */
export const SLIDE_INTERVAL_MS = 250;
/** The clock's step with reduced motion. */
export const REDUCED_INTERVAL_MS = 1000;

/** Fast at first, settling at the end. `t` from 0 to 1. */
export function easeOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) ** 3;
}

function frame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 16);
  return () => clearTimeout(id);
}

/**
 * The current moment (epoch ms), renewed on an animation frame at most every `intervalMs` (every
 * frame for 0) while `enabled`. It stands still while not, and while the tab is hidden.
 */
export function useFrameClock(enabled: boolean, intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancel: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      setNow(Date.now());
      if (intervalMs <= 0) {
        cancel = frame(tick);
      } else {
        // Wait without waking every frame, then draw on the next one.
        timer = setTimeout(() => {
          timer = null;
          cancel = frame(tick);
        }, intervalMs);
      }
    };
    cancel = frame(tick);
    return () => {
      cancel();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [enabled, intervalMs]);
  return enabled ? now : Date.now();
}

interface Tween {
  from: number;
  to: number;
  start: number;
}

function tweenAt(tween: Tween, now: number, durationMs: number): number {
  if (durationMs <= 0) {
    return tween.to;
  }
  return tween.from + (tween.to - tween.from) * easeOut((now - tween.start) / durationMs);
}

/**
 * A number that counts to a new value over `durationMs` instead of jumping to it (bytes read,
 * a percent). It starts where the shown value is, so a value that changes mid-way does not jump
 * either. With reduced motion, or `enabled` false, it is the value itself.
 */
export function useTweened(target: number, enabled = true, durationMs = EASE_MS * 2): number {
  const reduced = useReducedMotion();
  const animate = enabled && !reduced && Number.isFinite(target);
  const tween = React.useRef<Tween>({ from: target, to: target, start: 0 });
  if (tween.current.to !== target) {
    const now = Date.now();
    const shown = animate ? tweenAt(tween.current, now, durationMs) : target;
    tween.current = { from: shown, to: target, start: now };
  }
  const moving = animate && Date.now() - tween.current.start < durationMs;
  const now = useFrameClock(moving, 0);
  return moving ? tweenAt(tween.current, now, durationMs) : target;
}

/** Beyond this the time axis does not ease towards a new measurement: it jumps. */
export const MAX_AXIS_EASE_MS = 5_000;

export interface LiveAxis {
  /** Where the time axis ends now (epoch ms, on the measurements' clock). */
  now: number;
  /** How far the newest measurement has arrived, 0 to 1 (1 with reduced motion). */
  arrived: number;
}

interface Arrival {
  at: number;
  /** When it arrived, on this browser's clock. */
  local: number;
  /** How far ahead (or behind) the axis stood at that moment; eased away. */
  offset: number;
}

/**
 * The time axis of a running run's charts. It moves on from the newest measurement by the time
 * that passed here since that measurement arrived: continuous between two measurements, which
 * arrive every two seconds or less often, and independent of how far this browser's clock is off
 * the server's. When a new measurement arrives the axis eases from where it stood to it, over
 * {@link EASE_MS}. It renews every frame while it eases, four times a second otherwise, once a
 * second with reduced motion, and not at all while the tab is hidden.
 */
export function useLiveAxis(lastAt: number, running: boolean): LiveAxis {
  const reduced = useReducedMotion();
  const arrival = React.useRef<Arrival>({ at: lastAt, local: Date.now(), offset: 0 });
  const shown = React.useRef<number>(lastAt);
  if (arrival.current.at !== lastAt) {
    const offset = shown.current - lastAt;
    arrival.current = {
      at: lastAt,
      local: Date.now(),
      offset: reduced || Math.abs(offset) > MAX_AXIS_EASE_MS ? 0 : offset,
    };
  }
  const easing = running && !reduced && Date.now() - arrival.current.local < EASE_MS;
  const clock = useFrameClock(
    running,
    reduced ? REDUCED_INTERVAL_MS : easing ? 0 : SLIDE_INTERVAL_MS,
  );
  if (!running) {
    shown.current = lastAt;
    return { now: lastAt, arrived: 1 };
  }
  const elapsed = Math.max(0, clock - arrival.current.local);
  const arrived = reduced ? 1 : easeOut(elapsed / EASE_MS);
  const now = lastAt + elapsed + arrival.current.offset * (1 - arrived);
  shown.current = now;
  return { now, arrived };
}
