/**
 * The designated loader of the Business and Service Provider web modules
 * (ee/README.md): the one file of apps/web that may import from `ee/`
 * (scripts/ci/check-ee-boundary.mjs enforces it). It registers what
 * `ee/web` exports with the core's extension points (lib/extensions.tsx);
 * features/registry.ts imports it before it collects routes and menu entries.
 */
import { eeWebExtension } from "../../../../ee/web/src/index";

import { registerWebExtension } from "@/lib/extensions";

registerWebExtension(eeWebExtension);
