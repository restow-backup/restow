/** Session API of the endpoint feature, mounted under /api/v1 (see app.ts). */
export const mountPath = "/endpoints";

/** The agent API and the restic endpoint sit outside /api/v1: an agent is not a browser session. */
export const AGENT_API_PATH = "/agent/v1";
export const RESTIC_PATH = "/agent/restic";
export const INSTALL_PATH = "/install";
