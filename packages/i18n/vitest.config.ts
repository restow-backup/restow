import { configDefaults, defineConfig } from "vitest/config";

// Setup and teardown of the Postgres suites create, migrate and drop a
// database of their own; under a full parallel run on one server that can take
// longer than vitest's 10 s default. Test bodies keep the default timeout.
//
// The build compiles the tests into dist/ as well; since vitest 4 the default
// exclude no longer skips dist/, so it is excluded here to run each test once.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
