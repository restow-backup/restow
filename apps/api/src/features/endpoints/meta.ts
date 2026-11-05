/** Session API of the endpoint feature, mounted under /api/v1 (see app.ts). */
export const mountPath = "/endpoints";

/** The agent API and the restic endpoint sit outside /api/v1: an agent is not a browser session. */
export const AGENT_API_PATH = "/agent/v1";
export const RESTIC_PATH = "/agent/restic";
export const INSTALL_PATH = "/install";
/** The recovery ISO's API (docs/BAREMETAL.md 9.3, 9.8), mounted ahead of the agent API. */
export const RECOVERY_API_PATH = "/agent/v1/recovery";
/** The read-only restic route of a recovery session (docs/BAREMETAL.md 9.6). */
export const RECOVERY_RESTIC_PATH = "/agent/recovery/restic";
