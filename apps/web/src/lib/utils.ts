/**
 * Merge conditional class names and resolve conflicting Tailwind utilities
 * (`cn("px-2", active && "px-4")` -> `"px-4"`).
 *
 * Backed by the `cn` package, the engine the shadcn/ui registry imports
 * directly, so feature code (which imports from here) and the generated
 * primitives in components/ui share one implementation.
 */
export { cn } from "cn";
