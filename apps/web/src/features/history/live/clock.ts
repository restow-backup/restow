import * as React from "react";

/**
 * One second clock for everything on the page that counts down or up ("in 17:42",
 * "updated 12 s ago"): a single timer runs while at least one part listens, and nothing
 * asks the server. The snapshot is the second, stable within it as `useSyncExternalStore`
 * requires and always current, even after the timer stood still for a while.
 */

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function second(): number {
  return Math.floor(Date.now() / 1000);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      for (const current of [...listeners]) {
        current();
      }
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current moment in epoch milliseconds, renewed every second while `enabled`. */
export function useSecondClock(enabled = true): number {
  const tick = React.useSyncExternalStore(enabled ? subscribe : subscribeNothing, second, second);
  return enabled ? tick * 1000 : Date.now();
}

function subscribeNothing(): () => void {
  return () => undefined;
}

/** How many parts listen to the clock (tests check the timer stops when nobody does). */
export function secondClockListeners(): number {
  return listeners.size;
}
