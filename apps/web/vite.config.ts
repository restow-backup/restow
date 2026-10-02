import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { fontPreloadPlugin } from "./vite/font-preload";
import { maintenancePagePlugin } from "./vite/maintenance-page";

/**
 * Third-party code split into its own long-lived chunks, so a Restow update
 * that changes only app code leaves the (larger) library chunks cached in the
 * browser. Keyed by package name inside node_modules.
 */
const VENDOR_CHUNKS: readonly (readonly [chunk: string, packages: readonly string[]])[] = [
  ["react", ["react", "react-dom", "scheduler"]],
  ["router", ["@tanstack"]],
  [
    "ui",
    [
      "@radix-ui",
      "radix-ui",
      "cmdk",
      "sonner",
      "vaul",
      "react-day-picker",
      "lucide-react",
      "@floating-ui",
      "cn",
    ],
  ],
  ["charts", ["recharts", "d3-", "victory-vendor", "decimal.js-light"]],
  ["i18n", ["i18next", "react-i18next", "i18next-icu", "intl-messageformat", "@formatjs"]],
  ["auth", ["better-auth", "@better-auth", "@simplewebauthn", "better-call", "nanostores"]],
];

function packageOf(id: string): string | null {
  const match = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(id);
  return match?.[1] ?? null;
}

/**
 * Packages outside the named groups are left to Rollup: a catch-all chunk
 * imported by, and importing from, the React chunk is a circular chunk, and in
 * production React's CommonJS exports are then read before they exist (blank
 * page). The CommonJS interop helper goes with React, its first user.
 */
function vendorChunk(id: string): string | undefined {
  if (id.includes("commonjsHelpers")) {
    return "vendor-react";
  }
  const name = packageOf(id);
  if (!name) {
    return undefined;
  }
  for (const [chunk, packages] of VENDOR_CHUNKS) {
    if (packages.some((prefix) => name === prefix || name.startsWith(prefix))) {
      return `vendor-${chunk}`;
    }
  }
  return undefined;
}

// Vite config for the Restow web app. Tailwind v4 runs through its own Vite
// plugin (no PostCSS config), and `@/` resolves to `src/` to match tsconfig.
export default defineConfig({
  // maintenancePagePlugin writes dist/maintenance/*: the page the edge serves while the api is down.
  // fontPreloadPlugin adds the preload links of the first-paint fonts to dist/index.html.
  plugins: [react(), tailwindcss(), maintenancePagePlugin(), fontPreloadPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: { manualChunks: vendorChunk },
      // A circular chunk builds fine and breaks only at runtime; fail the build instead.
      onwarn(warning, warn) {
        if (warning.message.startsWith("Circular chunk")) {
          throw new Error(`Refusing to build: ${warning.message}`);
        }
        warn(warning);
      },
    },
  },
  server: {
    port: 5173,
    // The API runs as a separate process (apps/api); proxy REST calls in dev.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
