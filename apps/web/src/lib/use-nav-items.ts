import { useRouter } from "@tanstack/react-router";

import type { NavItem } from "@/lib/navigation";

/**
 * Navigation items are assembled once in `router.tsx` (base items plus the
 * feature registry) and carried in the router context, so the sidebar never
 * imports feature modules and no import cycle forms through `routes/tree.ts`.
 */
export function useNavItems(): readonly NavItem[] {
  return useRouter().options.context.navItems;
}
