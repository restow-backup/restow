/**
 * The designated loader of the Business and Service Provider worker modules
 * (ee/README.md): the one file of apps/worker that may import from `ee/`
 * (scripts/ci/check-ee-boundary.mjs enforces it). It registers what
 * `ee/worker` exports with the core's extension points (./extensions.ts);
 * each registered task decides itself whether it runs. The Community build
 * replaces this file with an empty module and leaves `ee/` out (docs/CI.md).
 */
import { eeWorkerExtension } from "../../../ee/worker/src/index.js";
import { registerWorkerExtension } from "./extensions.js";

registerWorkerExtension(eeWorkerExtension);
