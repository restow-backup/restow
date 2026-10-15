import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

/**
 * The vendor chunks as Rolldown code-splitting groups, in priority order: a
 * group also takes the dependencies of what it captures, so React's group
 * comes first and keeps React (and react-dom) whole instead of letting the
 * first library that imports it pull it into its own chunk. Packages outside
 * the named groups are left to Rolldown's automatic splitting.
 */
const VENDOR_GROUPS = VENDOR_CHUNKS.map(([chunk, packages], index) => ({
  name: `vendor-${chunk}`,
  priority: VENDOR_CHUNKS.length - index,
  test: (id: string) => {
    const name = packageOf(id);
    return name !== null && packages.some((prefix) => name === prefix || name.startsWith(prefix));
  },
}));

function packageOf(id: string): string | null {
  const match = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(id);
  return match?.[1] ?? null;
}

/**
 * A circular chunk builds fine and breaks only at runtime (a chunk reads
 * another's exports before they exist: blank page). Rollup warned about it,
 * Rolldown does not, so the build checks the chunk graph itself and fails on a
 * cycle.
 */
function noCircularChunks(): Plugin {
  return {
    name: "no-circular-chunks",
    apply: "build",
    generateBundle(_options, bundle) {
      const imports = new Map<string, readonly string[]>();
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          imports.set(output.fileName, output.imports);
        }
      }
      const done = new Set<string>();
      const visit = (file: string, path: readonly string[]) => {
        if (path.includes(file)) {
          throw new Error(`Refusing to build: circular chunks ${[...path, file].join(" -> ")}`);
        }
        if (done.has(file)) {
          return;
        }
        for (const next of imports.get(file) ?? []) {
          visit(next, [...path, file]);
        }
        done.add(file);
      };
      for (const file of imports.keys()) {
        visit(file, []);
      }
    },
  };
}

// Vite config for the Restow web app. Tailwind v4 runs through its own Vite
// plugin (no PostCSS config), and `@/` resolves to `src/` to match tsconfig.
export default defineConfig({
  // maintenancePagePlugin writes dist/maintenance/*: the page the edge serves while the api is down.
  plugins: [react(), tailwindcss(), maintenancePagePlugin(), noCircularChunks()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    rolldownOptions: {
      output: { codeSplitting: { groups: VENDOR_GROUPS } },
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
