import path from "node:path";

import { defineConfig } from "vite";

// ee/web modules import the web app's own components through `@/`, exactly as
// the app does (apps/web/vite.config.ts), so the tests resolve it the same way.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../../apps/web/src"),
    },
  },
});
