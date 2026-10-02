import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LinkButtonProps {
  to: LinkProps["to"];
  /** Search parameters of the address (feature routes are untyped here, like `to`). */
  search?: Record<string, string>;
  variant?: "default" | "outline" | "ghost" | "link" | "secondary";
  size?: "default" | "sm" | "xs";
  className?: string;
  /** Runs before the router navigates (closes a menu or sheet the link sits in). */
  onClick?: () => void;
  children: React.ReactNode;
}

/** A router link that looks like a button (navigation stays a link for the keyboard and new tabs). */
export function LinkButton({
  to,
  search,
  variant = "outline",
  size = "sm",
  className,
  onClick,
  children,
}: LinkButtonProps) {
  return (
    <Link
      to={to}
      search={search as never}
      onClick={onClick}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {children}
    </Link>
  );
}
