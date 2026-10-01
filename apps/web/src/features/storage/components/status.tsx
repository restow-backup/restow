import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Cloud,
  HardDrive,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_VARIANT, type Tone } from "../presenters";
import type { StorageKind, StorageRole, TargetStatus } from "../types";

const STATUS_ICON: Record<TargetStatus, LucideIcon> = {
  ok: CircleCheck,
  error: TriangleAlert,
  unverified: CircleDashed,
};

/** Health of a target as a badge with icon (never colour alone). */
export function TargetStatusBadge({ status }: { status: TargetStatus }) {
  const { t } = useTranslation("storage");
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      <Icon aria-hidden="true" />
      {t(`status.${status}`)}
    </Badge>
  );
}

export function RoleBadge({ value }: { value: StorageRole }) {
  const { t } = useTranslation("storage");
  return <Badge variant={value === "primary" ? "default" : "outline"}>{t(`role.${value}`)}</Badge>;
}

export function TargetKindIcon({ kind, className }: { kind: StorageKind; className?: string }) {
  const Icon = kind === "s3" ? Cloud : HardDrive;
  return <Icon aria-hidden="true" className={className} />;
}

const TONE_ICON: Record<Tone, LucideIcon> = {
  neutral: CircleHelp,
  ok: CircleCheck,
  warning: TriangleAlert,
  destructive: CircleX,
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  ok: "text-foreground",
  warning: "text-warning-foreground dark:text-warning",
  destructive: "text-destructive",
};

/** A short status line with a tone icon. */
export function ToneLine({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={cn("flex items-start gap-1.5 text-sm", className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[tone])} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
