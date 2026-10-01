import { useTranslation } from "react-i18next";
import { type OrbState, ThinkingOrb } from "thinking-orbs";

import { cn } from "@/lib/utils";

import { UI_NAMESPACE } from "./i18n.js";

/**
 * Every long-running activity Restow shows an orb for, named by what the
 * user is waiting for rather than by the underlying animation. Adding an
 * activity means adding one entry to `ACTIVITY_ORB_STATE` (which animation
 * it reads as) and one string per language in `ui.json` under
 * `activityOrb.<kind>` -- never a new animation and never a hard-coded label.
 */
export type ActivityKind =
  | "backupRunning"
  | "restoreRunning"
  | "verifying"
  | "restoreTest"
  | "directorySync"
  | "sourceConsent"
  | "searching"
  | "exporting"
  | "reportGenerating"
  | "queued"
  | "throttled"
  | "waitingFirstBackup"
  | "scrubbing"
  | "integrityCheck"
  | "storageMigration";

/**
 * The two tuned sizes this kit exposes: 20 for inline use (badges, job rows,
 * buttons for long operations) and 64 for detail headers, progress and empty
 * panels. `thinking-orbs` also ships 32, kept out of the Restow surface so
 * every use case picks one of two deliberate sizes.
 */
export type ActivityOrbSize = 20 | 64;

/**
 * Which `thinking-orbs` state reads as each Restow activity (see that
 * package's `OrbState` doc comment for what each animation looks like).
 * `listening` is unused: nothing in Restow currently reads as a waveform.
 */
export const ACTIVITY_ORB_STATE: Readonly<Record<ActivityKind, OrbState>> = {
  backupRunning: "working",
  restoreRunning: "weaving",
  verifying: "solving",
  restoreTest: "solving",
  directorySync: "connecting",
  sourceConsent: "connecting",
  searching: "searching",
  exporting: "composing",
  reportGenerating: "composing",
  queued: "breathing",
  throttled: "breathing",
  waitingFirstBackup: "breathing",
  scrubbing: "shaping",
  integrityCheck: "shaping",
  storageMigration: "shaping",
};

export interface ActivityOrbProps {
  /** What the orb stands for; picks both the animation and the default label. */
  kind: ActivityKind;
  /** @default 64 */
  size?: ActivityOrbSize;
  /**
   * Overrides the i18n label, for a caller whose surrounding text already
   * names the activity precisely (e.g. a job row that names the object).
   */
  label?: string;
  /**
   * Marks the orb as pure decoration for a caller whose surrounding text
   * already names the activity out loud (e.g. a job row with a "Running"
   * status badge next to it). Renders `aria-hidden="true"` and drops
   * `role="img"` and `aria-label` instead of announcing the activity twice.
   * @default false
   */
  decorative?: boolean;
  className?: string;
}

/**
 * The activity indicator for long-running work: a small canvas animation
 * (`thinking-orbs`) mapped from what the activity means to the user rather
 * than from the animation's own name. Dark/light and `prefers-reduced-
 * motion` (which freezes the orb on a single tuned frame instead of
 * animating) are the dependency's own job -- this component only ever
 * passes it a state, a size and a label, so that handling stays intact.
 *
 * Never use this for a finished state (use `StatusBadge` instead) and never
 * for page-content loading (skeletons stay for that); it is for work that is
 * genuinely still running.
 *
 * Pass `decorative` next to text that already names the activity (a job row
 * with a visible "Running" status), so the canvas does not make a screen
 * reader announce the same activity twice.
 */
export function ActivityOrb({
  kind,
  size = 64,
  label,
  decorative = false,
  className,
}: ActivityOrbProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <ThinkingOrb
      state={ACTIVITY_ORB_STATE[kind]}
      size={size}
      role={decorative ? "presentation" : "img"}
      aria-label={decorative ? "" : (label ?? t(`activityOrb.${kind}`))}
      aria-hidden={decorative ? "true" : undefined}
      className={cn("shrink-0", className)}
      data-activity={kind}
    />
  );
}
