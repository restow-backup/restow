import { main } from "./main.js";

/**
 * The `restow` program (Dockerfile: /usr/local/bin/restow runs this file). The
 * commands live in ./main.ts, which tests import without running anything.
 */
process.exitCode = await main(process.argv.slice(2));
