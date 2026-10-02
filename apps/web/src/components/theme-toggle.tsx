import { Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AppearanceMenuItems } from "@/components/appearance-menu";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Appearance picker for pages outside the shell (sign-in, setup): colour
 * scheme and mode, the same two choices as in the user menu. The button shows
 * the resolved mode.
 */
export function ThemeToggle() {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("theme.label")} title={t("theme.label")}>
          {resolvedTheme === "dark" ? <Moon /> : <Sun />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t("theme.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <AppearanceMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
