/**
 * Grid presets for recharts' CartesianGrid that never measure axis labels.
 *
 * CartesianGrid works out where its lines go by running the axis tick
 * collision check, and it does so without the axis font: it measures every
 * label with `fontSize` and `letterSpacing` set to `undefined`. Firefox
 * reports each of those as a dropped declaration ("Error in parsing value for
 * 'font-size'"), for every label on every render. It does so for both
 * directions, also for one switched off with `vertical={false}`.
 *
 * - The switched-off direction gets no lines from a generator that returns
 *   none, without measuring anything.
 * - The direction that draws lines follows a value axis that shows every one
 *   of its ticks (`interval={VALUE_AXIS_INTERVAL}`): with a numeric interval
 *   recharts skips the collision check. Value axes here have a handful of
 *   round ticks, which never collide.
 */

const NO_GRID_LINES = (): number[] => [];

/** Horizontal lines only (the value axis is the Y axis). */
export const HORIZONTAL_GRID = {
  vertical: false,
  verticalCoordinatesGenerator: NO_GRID_LINES,
} as const;

/** Vertical lines only (the value axis is the X axis, as in a horizontal bar chart). */
export const VERTICAL_GRID = {
  horizontal: false,
  horizontalCoordinatesGenerator: NO_GRID_LINES,
} as const;

/** `interval` of a value axis: every tick, without the label collision check. */
export const VALUE_AXIS_INTERVAL = 0;
