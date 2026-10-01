import { createUpdateState } from "./state.js";

/**
 * The process-wide update state: the running version, the settings and the
 * cached check. Kept apart from the service (which needs the database pools)
 * so the status routes that only read it do not pull the pools in.
 */
export const updateState = createUpdateState();
