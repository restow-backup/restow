import { supportedLanguages } from "@restow/i18n";
import { useQuery } from "@tanstack/react-query";
import { type LinkProps, useNavigate } from "@tanstack/react-router";
import { Check } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  OBJECTS_NAV_COMMAND_ID,
  type PaletteAction,
  buildPaletteGroups,
  commandValue,
  objectGroup,
} from "@/components/command-palette/commands";
import { isModifierShortcut } from "@/components/command-palette/shortcut";
import { useSignOut } from "@/components/layout/use-sign-out";
import { useSwitchTenant } from "@/components/tenant-switcher";
import { useTheme } from "@/components/theme-provider";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchObjects } from "@/features/directory/api";
import { chooseLanguage } from "@/i18n";
import { canAccess, useSession } from "@/lib/session";
import { useNavItems } from "@/lib/use-nav-items";

/**
 * Command palette (Cmd/Ctrl+K): jump to any page the active role may open
 * (locked menu entries are left out), switch the tenant, change appearance or language, open account
 * security or sign out; with two or more characters typed it also finds the
 * active tenant's protected objects. The provider owns the open state and the shortcut,
 * so the top bar's search button and the keyboard open the same palette.
 */

interface CommandPaletteContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CommandPaletteContext = React.createContext<CommandPaletteContextValue | null>(null);

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isModifierShortcut(event, "k")) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const value = React.useMemo(() => ({ open, setOpen }), [open]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <CommandPalette />
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette(): CommandPaletteContextValue {
  const context = React.useContext(CommandPaletteContext);
  if (context === null) {
    throw new Error("useCommandPalette must be used within a CommandPaletteProvider");
  }
  return context;
}

function CommandPalette() {
  const { t, i18n } = useTranslation();
  const { open, setOpen } = useCommandPalette();
  const navigate = useNavigate();
  const navItems = useNavItems();
  const { role, features, extensions, tenants, activeTenant, isProviderAdmin } = useSession();
  const { theme, setTheme } = useTheme();
  const switchTenant = useSwitchTenant();
  const { signOut } = useSignOut();
  // A command that opens another page hands focus to that page's heading
  // (the shell does that); the dialog must not pull it back to its trigger.
  const keepFocusOnPage = React.useRef(false);

  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  React.useEffect(() => {
    if (!open) {
      setSearch("");
      setDebouncedSearch("");
    }
  }, [open]);

  const baseGroups = React.useMemo(
    () =>
      buildPaletteGroups({
        navItems,
        role,
        lockContext: { features, extensions },
        canAccess,
        tenants,
        activeTenantId: activeTenant?.id ?? null,
        isProviderAdmin,
        theme,
        language: i18n.resolvedLanguage ?? i18n.language,
        languages: supportedLanguages,
        t,
      }),
    [
      navItems,
      role,
      features,
      extensions,
      tenants,
      activeTenant?.id,
      isProviderAdmin,
      theme,
      i18n,
      t,
    ],
  );

  // Objects are searched only where the protected-objects page may be opened,
  // by the same rule the sidebar uses.
  const canSearchObjects = baseGroups.some((group) =>
    group.commands.some((command) => command.id === OBJECTS_NAV_COMMAND_ID),
  );
  const objects = useQuery({
    queryKey: ["command-palette", "objects", activeTenant?.id ?? null, debouncedSearch],
    queryFn: () =>
      fetchObjects({
        search: debouncedSearch,
        page: 1,
        pageSize: 8,
        sort: "name",
        order: "asc",
      }),
    enabled: open && canSearchObjects && activeTenant !== null && debouncedSearch.length >= 2,
    staleTime: 30_000,
  });
  const foundObjects = objectGroup(
    debouncedSearch.length >= 2 ? objects.data?.items : undefined,
    debouncedSearch,
    t,
  );
  const groups = foundObjects ? [foundObjects, ...baseGroups] : baseGroups;

  const run = (action: PaletteAction) => {
    keepFocusOnPage.current = action.kind === "navigate";
    setOpen(false);
    switch (action.kind) {
      case "navigate":
        void navigate({
          to: action.to as LinkProps["to"],
          ...(action.search ? { search: action.search as never } : {}),
        });
        break;
      case "tenant":
        switchTenant(action.tenant);
        break;
      case "theme":
        setTheme(action.theme);
        break;
      case "language":
        void chooseLanguage(action.language);
        break;
      case "signOut":
        void signOut();
        break;
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/*
        The same composition as `CommandDialog` in components/ui/command.tsx,
        spelled out for `onCloseAutoFocus`, which that wrapper does not pass on.
      */}
      <DialogContent
        className="overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          if (keepFocusOnPage.current) {
            event.preventDefault();
            keepFocusOnPage.current = false;
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t("search.title")}</DialogTitle>
          <DialogDescription>{t("search.description")}</DialogDescription>
        </DialogHeader>
        <Command className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5">
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
          />
          <CommandList className="max-h-[min(24rem,60vh)]">
            <CommandEmpty>{t("search.empty")}</CommandEmpty>
            {groups.map((group, index) => (
              <React.Fragment key={group.id}>
                {index > 0 ? <CommandSeparator /> : null}
                <CommandGroup heading={group.heading}>
                  {group.commands.map((command) => {
                    const Icon = command.icon;
                    return (
                      <CommandItem
                        key={command.id}
                        value={commandValue(command)}
                        keywords={command.keywords}
                        disabled={command.disabled}
                        onSelect={() => run(command.action)}
                      >
                        <Icon aria-hidden="true" />
                        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          {command.label}
                        </span>
                        {command.hint ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {command.hint}
                          </span>
                        ) : null}
                        {command.current ? (
                          <>
                            <Check className="text-foreground" aria-hidden="true" />
                            <span className="sr-only">{t("search.current")}</span>
                          </>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </React.Fragment>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
