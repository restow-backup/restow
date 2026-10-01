/**
 * Preload for a child process that runs the TypeScript sources of this package
 * (tests, `tsx` runs): registers the hooks of ./ts-hooks.mjs. A built package
 * never loads this file, its child processes run the compiled JavaScript.
 */
import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url);
