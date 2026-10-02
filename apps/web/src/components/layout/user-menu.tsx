import { type SupportedLanguage, supportedLanguages } from "@restow/i18n";
import { type LinkProps, useNavigate } from "@tanstack/react-router";
import { Fingerprint, Languages, LogOut, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AppearanceMenuItems } from "@/components/appearance-menu";
import { useSignOut } from "@/components/layout/use-sign-out";
import { useTheme } from "@/components/theme-provider";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { chooseLanguage } from "@/i18n";
import { ACCOUNT_PATH } from "@/lib/entry";
import { initialsOf } from "@/lib/format";
import { useSession } from "@/lib/session";

/**
 * Avatar button with the signed-in identity, the role in the active tenant,
 * sign-in security, appearance (colour scheme and mode), language and sign-out.
 */
export function UserMenu() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user, role, activeTenant } = useSession();
  const { resolvedTheme } = useTheme();
  const { signOut, signingOut } = useSignOut();
  const language = (i18n.resolvedLanguage ?? i18n.language) as SupportedLanguage;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t("user.menuFor", { name: user?.name ?? "" })}
        >
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">{initialsOf(user?.name)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
          <span className="text-xs text-muted-foreground">{t("user.signedInAs")}</span>
          <span className="truncate text-sm font-medium">{user?.name}</span>
          <span className="truncate text-xs text-muted-foreground">{user?.email}</span>
          {role ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1 text-xs text-muted-foreground">
              <Badge variant="secondary">{t(`roles.${role}`)}</Badge>
              {activeTenant ? (
                <span className="min-w-0 truncate">
                  {t("user.roleIn", { tenant: activeTenant.name })}
                </span>
              ) : null}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => void navigate({ to: ACCOUNT_PATH as LinkProps["to"] })}>
            <Fingerprint />
            {t("user.security")}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {resolvedTheme === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
              {t("theme.label")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <AppearanceMenuItems />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages aria-hidden="true" />
              {t("language.label")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={language}
                onValueChange={(value) => void chooseLanguage(value)}
              >
                {supportedLanguages.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {t(`language.${option}`)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            event.preventDefault();
            void signOut();
          }}
        >
          <LogOut />
          {signingOut ? t("user.signingOut") : t("user.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
