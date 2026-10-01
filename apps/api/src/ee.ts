/**
 * The designated loader of the Business and Service Provider API modules
 * (ee/README.md): the one file of apps/api that may import from `ee/`
 * (scripts/ci/check-ee-boundary.mjs enforces it). It hands what `ee/api`
 * exports to the core's extension points (./extensions.ts); whether a
 * registered feature answers is decided per request by the module itself.
 * The Community build replaces this file with an empty module and leaves
 * `ee/` out (docs/CI.md).
 *
 * Order matters: better-auth plugins must be registered before anything
 * imports ./auth.ts, which builds the better-auth instance from them. The
 * auth entry of `ee/api` imports nothing that reaches ./auth.ts, and the
 * rest of `ee/api` (whose routes do) is loaded only afterwards. Import this
 * module before ./app.ts (server.ts does).
 */
import { eeAuthExtension } from "../../../ee/api/src/auth.js";
import { registerApiExtension, registerAuthExtension } from "./extensions.js";

registerAuthExtension(eeAuthExtension);

const { eeApiExtension } = await import("../../../ee/api/src/index.js");
registerApiExtension(eeApiExtension);
