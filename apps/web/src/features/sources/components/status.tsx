import {
  Building2,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  FileInput,
  type LucideIcon,
  Mail,
  TriangleAlert,
} from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_VARIANT, type Tone } from "../presenters";
import type { SourceKind, SourceStatus } from "../types";

const STATUS_ICON: Record<SourceStatus, LucideIcon> = {
  pending: CircleDashed,
  active: CircleCheck,
  error: TriangleAlert,
  disabled: CirclePause,
};

/** Connection status of a source as a badge with icon (never colour alone). */
export function SourceStatusBadge({ status }: { status: SourceStatus }) {
  const { t } = useTranslation("sources");
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={STATUS_VARIANT[status]}>
      <Icon aria-hidden="true" />
      {t(`status.${status}`)}
    </Badge>
  );
}

export function SourceKindIcon({ kind, className }: { kind: SourceKind; className?: string }) {
  const Icon = kind === "m365" ? Building2 : kind === "import" ? FileInput : Mail;
  return <Icon aria-hidden="true" className={className} />;
}

const TONE_ICON: Record<Tone, LucideIcon> = {
  neutral: CirclePause,
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
    <p className={cn("flex items-start gap-1.5 text-sm", className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE_TEXT[tone])} />
      <span>{children}</span>
    </p>
  );
}
