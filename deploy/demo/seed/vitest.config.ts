import { defineConfig } from "vitest/config";

// Setup and teardown of the Postgres suites create, migrate and drop a
// database of their own; under a full parallel run on one server that can take
// longer than vitest's 10 s default. Test bodies keep the default timeout.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
