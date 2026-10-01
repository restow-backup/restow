import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/**
 * Keyboard shortcut hints. Apple keyboards say ⌘, everything else Ctrl (Strg
 * on German keyboards, hence translated); the shortcuts themselves accept
 * both modifiers everywhere.
 */

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** Whether the visitor is on a Mac, iPhone or iPad (⌘ instead of Ctrl). */
export function isApplePlatform(nav: NavigatorLike | undefined = globalNavigator()): boolean {
  if (!nav) {
    return false;
  }
  const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function globalNavigator(): NavigatorLike | undefined {
  return typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike);
}

/** The keys to show for "modifier + key", e.g. `["⌘", "K"]` or `["Ctrl", "K"]`. */
export function shortcutKeys(key: string, apple: boolean, ctrlLabel: string): string[] {
  return [apple ? "⌘" : ctrlLabel, key.toUpperCase()];
}

/** `aria-keyshortcuts` value for "Ctrl or Cmd + key". */
export function ariaShortcut(key: string): string {
  const upper = key.toUpperCase();
  return `Control+${upper} Meta+${upper}`;
}

/** Whether a keydown is "Ctrl or Cmd + key" (no other modifiers). */
export function isModifierShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  key: string,
): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === key.toLowerCase()
  );
}

/** "⌘ K" / "Strg K" as keycaps; decorative, the control names its shortcut itself. */
export function ShortcutHint({
  shortcutKey,
  className,
}: { shortcutKey: string; className?: string }) {
  const { t } = useTranslation();
  const keys = shortcutKeys(shortcutKey, isApplePlatform(), t("keys.ctrl"));
  return (
    <span aria-hidden="true" className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((keyLabel) => (
        <kbd
          key={keyLabel}
          className="pointer-events-none inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[0.6875rem] font-medium text-muted-foreground select-none"
        >
          {keyLabel}
        </kbd>
      ))}
    </span>
  );
}
