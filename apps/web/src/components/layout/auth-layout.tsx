import type * as React from "react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { MAIN_CONTENT_ID, SkipLink } from "@/components/layout/skip-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { Wordmark } from "@/components/wordmark";
import { cn } from "@/lib/utils";

const WIDTHS = {
  /** Sign-in and short messages. */
  sm: "max-w-sm",
  /** Single cards with a form (authenticator enrolment, errors). */
  md: "max-w-xl",
  /** The setup wizard. */
  lg: "max-w-2xl",
} as const;

interface AuthLayoutProps {
  children: React.ReactNode;
  width?: keyof typeof WIDTHS;
  /** `center` for short content; `top` for long, growing content such as the wizard. */
  align?: "center" | "top";
}

/**
 * The frame of every page outside the shell (login, authenticator
 * enrolment, the setup wizard, loading and fatal error states): the wordmark
 * with language and theme on top, the content on a quiet background below.
 * One layout, so these pages read as one product.
 */
export function AuthLayout({ children, width = "md", align = "center" }: AuthLayoutProps) {
  return (
    <div className="flex min-h-svh flex-col bg-muted/40">
      <SkipLink />
      <header className="flex h-(--topbar-height) shrink-0 items-center justify-between px-4 sm:px-6">
        <Wordmark />
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main
        id={MAIN_CONTENT_ID}
        tabIndex={-1}
        className={cn(
          "flex flex-1 justify-center px-4 pb-16 outline-none",
          align === "center" ? "items-start pt-6 sm:items-center sm:pt-0" : "items-start pt-4",
        )}
      >
        <div className={cn("w-full", WIDTHS[width])}>{children}</div>
      </main>
    </div>
  );
}
