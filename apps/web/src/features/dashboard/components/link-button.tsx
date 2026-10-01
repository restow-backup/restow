import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LinkButtonProps {
  to: LinkProps["to"];
  variant?: "default" | "outline" | "ghost" | "link" | "secondary";
  size?: "default" | "sm" | "xs";
  className?: string;
  children: React.ReactNode;
}

/** A router link that looks like a button (navigation stays a link for the keyboard and new tabs). */
export function LinkButton({
  to,
  variant = "outline",
  size = "sm",
  className,
  children,
}: LinkButtonProps) {
  return (
    <Link to={to} className={cn(buttonVariants({ variant, size }), className)}>
      {children}
    </Link>
  );
}
