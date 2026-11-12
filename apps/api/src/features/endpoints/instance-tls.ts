/**
 * The instance check value (docs/BAREMETAL.md 9.2), measured by @restow/core
 * `measureInstanceSpki` (the worker's lab API measures the same way for a boot probe).
 */
import { measureInstanceSpki } from "@restow/core";

export { type MeasureOptions, measureInstanceSpki } from "@restow/core";

/** What issuing a code uses; replaced in tests. */
export const instanceTls = {
  measure: measureInstanceSpki,
};
