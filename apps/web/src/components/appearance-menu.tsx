import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PALETTES, type Palette, type Theme, useTheme } from "@/components/theme-provider";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/** The modes in the order the menus list them, with their icons. */
export const MODE_CHOICES: readonly { value: Theme; icon: typeof Sun }[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

/**
 * The two independent appearance choices, as the content of a dropdown menu or
 * submenu: the colour scheme (Restow or Neutral) and the mode (light, dark,
 * system). Every combination exists. Used by the user menu and by the
 * sign-in and setup pages, so the choice looks the same everywhere.
 */
export function AppearanceMenuItems() {
  const { t } = useTranslation();
  const { theme, setTheme, palette, setPalette } = useTheme();

  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        {t("theme.palette.label")}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={palette}
        onValueChange={(value) => setPalette(value as Palette)}
        aria-label={t("theme.palette.label")}
      >
        {PALETTES.map((value) => (
          <DropdownMenuRadioItem key={value} value={value}>
            {t(`theme.palette.${value}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        {t("theme.mode")}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme}
        onValueChange={(value) => setTheme(value as Theme)}
        aria-label={t("theme.mode")}
      >
        {MODE_CHOICES.map(({ value, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value} className="gap-2">
            <Icon className="size-4" />
            {t(`theme.${value}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      {/* w-0 min-w-full: the note wraps to the menu's width instead of widening it (a phone has little room). */}
      <p className="w-0 min-w-full px-2 py-1.5 text-xs text-muted-foreground">
        {t("theme.deviceNote")}
      </p>
    </>
  );
}
